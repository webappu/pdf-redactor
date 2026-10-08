// 試料 (a)〜(f) 以外の漏洩の経路を Node の MuPDF で確かめる（共有の資源・非表示のオプショナルコンテンツ・ソフトマスク）
import * as mupdf from 'mupdf';
import { describe, expect, it } from 'vitest';
import type { ApplyChoice, Mark } from '../lib/types';
import { checkOutput, openBytes } from './checks';
import { redactDocument } from './redact';

function raw(bytes: Uint8Array): string {
  return Buffer.from(openBytes(bytes).saveToBuffer('decompress,encrypt=none').asUint8Array()).toString('latin1');
}

function build(setup: (doc: mupdf.PDFDocument, font: mupdf.PDFObject) => void): Uint8Array {
  const doc = new mupdf.PDFDocument();
  const font = doc.addSimpleFont(new mupdf.Font('Helvetica'));
  setup(doc, font);
  return doc.saveToBuffer('compress').asUint8Array().slice();
}

function fontRes(doc: mupdf.PDFDocument, font: mupdf.PDFObject): mupdf.PDFObject {
  const res = doc.newDictionary();
  const fonts = doc.newDictionary();
  fonts.put('F1', font);
  res.put('Font', fonts);
  return res;
}

function form(doc: mupdf.PDFDocument, font: mupdf.PDFObject, content: string, group = false): mupdf.PDFObject {
  const d = doc.newDictionary();
  d.put('Type', doc.newName('XObject'));
  d.put('Subtype', doc.newName('Form'));
  const bb = doc.newArray();
  for (const v of [0, 0, 595, 842]) bb.push(v);
  d.put('BBox', bb);
  d.put('Resources', fontRes(doc, font));
  if (group) {
    const g = doc.newDictionary();
    g.put('S', doc.newName('Transparency'));
    g.put('CS', doc.newName('DeviceGray'));
    d.put('Group', g);
  }
  return doc.addStream(content, d);
}

// ソフトマスクに秘密の文字を描いたページ（shared なら資源の辞書を 2 ページで共有）
function smaskDoc(shared: boolean): Uint8Array {
  return build((doc, font) => {
    const smask = doc.newDictionary();
    smask.put('S', doc.newName('Luminosity'));
    smask.put('G', form(doc, font, '1 g BT /F1 14 Tf 250 700 Td (MASKSECRET) Tj ET', true));
    const gs = doc.newDictionary();
    gs.put('SMask', smask);
    const res = shared ? doc.addObject(fontRes(doc, font)) : fontRes(doc, font);
    const egs = doc.newDictionary();
    egs.put('GS1', gs);
    res.put('ExtGState', egs);
    doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, res, 'q /GS1 gs 0 0 1 rg 200 650 300 100 re f Q BT /F1 14 Tf 72 600 Td (KEEP1) Tj ET'));
    if (shared) doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, res, 'BT /F1 14 Tf 72 600 Td (PAGE2) Tj ET'));
  });
}

const region: Mark = { id: 'm', page: 0, rect: [240, 120, 400, 160], mode: 'fill', color: [0, 0, 0], source: 'draw' };
const none: ApplyChoice = { lineArtTouchedPages: [], rasterPages: [] };

function run(bytes: Uint8Array, choice: ApplyChoice = none) {
  const out = redactDocument(openBytes(bytes), [region], choice, 'tok');
  return { bytes: out.bytes, report: checkOutput(out.bytes, undefined, [region], 'tok') };
}

describe('そのほかの漏洩の経路', () => {
  it('共有の資源の Form XObject（墨消しするページだけが使う）: 元の Form が残らない', () => {
    const bytes = build((doc, font) => {
      const res = doc.addObject(fontRes(doc, font));
      const xo = doc.newDictionary();
      xo.put('Fm1', form(doc, font, 'BT /F1 14 Tf 250 700 Td (SHAREDSECRET) Tj ET'));
      res.put('XObject', xo);
      doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, res, 'q /Fm1 Do Q BT /F1 14 Tf 72 600 Td (KEEP1) Tj ET'));
      doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, res, 'BT /F1 14 Tf 72 600 Td (PAGE2) Tj ET'));
    });
    expect(raw(bytes)).toContain('SHAREDSECRET');
    const r = run(bytes);
    expect(r.report.ok).toBe(true);
    expect(raw(r.bytes)).not.toContain('SHAREDSECRET');
    expect(raw(r.bytes)).toContain('PAGE2');
  });

  it('非表示のオプショナルコンテンツの中の文字も消える', () => {
    const bytes = build((doc, font) => {
      const ocg = doc.addObject(doc.newDictionary());
      ocg.put('Type', doc.newName('OCG'));
      ocg.put('Name', doc.newString('hidden'));
      const ocprops = doc.newDictionary();
      const ocgs = doc.newArray();
      ocgs.push(ocg);
      ocprops.put('OCGs', ocgs);
      const d = doc.newDictionary();
      const off = doc.newArray();
      off.push(ocg);
      d.put('OFF', off);
      ocprops.put('D', d);
      doc.getTrailer().get('Root').put('OCProperties', ocprops);
      const res = fontRes(doc, font);
      const props = doc.newDictionary();
      props.put('OC1', ocg);
      res.put('Properties', props);
      doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, res, '/OC /OC1 BDC BT /F1 14 Tf 250 700 Td (OCSECRET) Tj ET EMC BT /F1 14 Tf 72 600 Td (KEEP1) Tj ET'));
    });
    const r = run(bytes);
    expect(r.report.ok).toBe(true);
    expect(raw(r.bytes)).not.toContain('OCSECRET');
  });

  it('ソフトマスクに描いた文字: applyRedactions では残るが、事後検査①②が見つけ、画像化で消える', () => {
    const bytes = smaskDoc(false);
    const first = run(bytes);
    expect(raw(first.bytes)).toContain('MASKSECRET');
    expect(first.report.ok).toBe(false);
    expect(first.report.marks[0].pixels).toBe(false);
    expect(first.report.marks[0].chars).toBeGreaterThan(0);
    expect(first.report.pixelFailedPages).toEqual([0]);
    const raster = run(bytes, { lineArtTouchedPages: [], rasterPages: [0] });
    expect(raster.report.ok).toBe(true);
    expect(raw(raster.bytes)).not.toContain('MASKSECRET');
  });

  it('スキャン（ページ全面の画像＋見えない文字）: 画像の画素と見えない文字が消え、検査に合格する', () => {
    const bytes = build((doc, font) => {
      // 150dpi 相当の写真風の画像（ざらつきのある灰色）。範囲の中に濃い四角
      const w = 1240;
      const h = 1754;
      const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, w, h], false);
      const px = pix.getPixels();
      let seed = 7;
      for (let i = 0; i < w * h; i++) {
        seed = (seed * 1103515245 + 12345) >>> 0;
        const v = 200 + (seed % 40);
        px[i * 3] = v;
        px[i * 3 + 1] = v;
        px[i * 3 + 2] = v;
      }
      // ページ空間 (250,125)〜(390,155) に相当する画素を濃く
      const s = w / 595;
      for (let y = Math.round(125 * s); y < Math.round(155 * s); y++) for (let x = Math.round(250 * s); x < Math.round(390 * s); x++) px.fill(20, (y * w + x) * 3, (y * w + x) * 3 + 3);
      const img = doc.addImage(new mupdf.Image(pix));
      const res = fontRes(doc, font);
      const xo = doc.newDictionary();
      xo.put('Scan', img);
      res.put('XObject', xo);
      doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, res, 'q 595 0 0 842 0 0 cm /Scan Do Q 3 Tr BT /F1 14 Tf 250 700 Td (SCANSECRET) Tj ET BT /F1 14 Tf 72 600 Td (KEEP1) Tj ET'));
    });
    const r = run(bytes);
    expect(r.report.marks[0].pixelsDetail).toBe('合格');
    expect(r.report.ok).toBe(true);
    expect(raw(r.bytes)).not.toContain('SCANSECRET');
    expect(raw(r.bytes)).toContain('KEEP1');
  });

  it('ソフトマスクが共有の資源にあっても、画像化した後に残らない', () => {
    const raster = run(smaskDoc(true), { lineArtTouchedPages: [], rasterPages: [0] });
    expect(raster.report.ok).toBe(true);
    const s = raw(raster.bytes);
    expect(s).not.toContain('MASKSECRET');
    expect(s).toContain('PAGE2');
  });
});
