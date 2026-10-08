// 独立の検証（2026-10-07、Claude の別のモデル）で見つかった漏れの経路を、直す前に失敗し直した後に通る試験にしたもの。
// 番号（E1 など）は検証の記録の番号。範囲はどれも利用者空間 x 240..400, y 682..722（ページ空間 y 120..160）
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

function arr(doc: mupdf.PDFDocument, v: number[]): mupdf.PDFObject {
  const a = doc.newArray();
  for (const x of v) a.push(x);
  return a;
}

function addPage(doc: mupdf.PDFDocument, res: mupdf.PDFObject, content: string): mupdf.PDFObject {
  doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, res, content));
  return doc.findPage(doc.countPages() - 1);
}

function addAnnot(doc: mupdf.PDFDocument, pageRef: mupdf.PDFObject, dict: mupdf.PDFObject): mupdf.PDFObject {
  const ref = doc.addObject(dict);
  let annots = pageRef.get('Annots');
  if (!annots.isArray()) {
    pageRef.put('Annots', doc.newArray());
    annots = pageRef.get('Annots');
  }
  annots.push(ref);
  return ref;
}

function hiddenOCG(doc: mupdf.PDFDocument): mupdf.PDFObject {
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
  return ocg;
}

const region: Mark = { id: 'm', page: 0, rect: [240, 120, 400, 160], mode: 'fill', color: [0, 0, 0], source: 'draw' };
const none: ApplyChoice = { lineArtTouchedPages: [], rasterPages: [] };

function run(bytes: Uint8Array, choice: ApplyChoice = none, stripDocument = false) {
  const out = redactDocument(openBytes(bytes), [region], choice, 'tok', { stripDocument });
  return { ...out, report: checkOutput(out.bytes, undefined, [region], 'tok') };
}

describe('独立の検証で見つかった漏れの経路', () => {
  it('E1: 範囲の中のウィジェットを消すと、ほかにウィジェットのない親の欄（/V）も AcroForm から消える', () => {
    const bytes = build((doc, font) => {
      const pageRef = addPage(doc, fontRes(doc, font), 'BT /F1 14 Tf 72 600 Td (KEEP1) Tj ET');
      const parent = doc.addObject(doc.newDictionary());
      parent.put('FT', doc.newName('Tx'));
      parent.put('T', doc.newString('name'));
      parent.put('V', doc.newString('SECRET-FORM-PARENT'));
      const widget = doc.newDictionary();
      widget.put('Type', doc.newName('Annot'));
      widget.put('Subtype', doc.newName('Widget'));
      widget.put('Rect', arr(doc, [250, 690, 390, 715]));
      widget.put('Parent', parent);
      widget.put('P', pageRef);
      widget.put('F', 4);
      const wref = addAnnot(doc, pageRef, widget);
      const kids = doc.newArray();
      kids.push(wref);
      parent.put('Kids', kids);
      // 範囲の外の欄（残る）
      const keep = doc.newDictionary();
      keep.put('Type', doc.newName('Annot'));
      keep.put('Subtype', doc.newName('Widget'));
      keep.put('FT', doc.newName('Tx'));
      keep.put('T', doc.newString('keep'));
      keep.put('V', doc.newString('KEEP-FORM'));
      keep.put('Rect', arr(doc, [72, 500, 200, 520]));
      keep.put('P', pageRef);
      const kref = addAnnot(doc, pageRef, keep);
      const acro = doc.newDictionary();
      const fields = doc.newArray();
      fields.push(parent);
      fields.push(kref);
      acro.put('Fields', fields);
      doc.getTrailer().get('Root').put('AcroForm', acro);
    });
    const r = run(bytes);
    expect(r.report.ok).toBe(true);
    const s = raw(r.bytes);
    expect(s.includes('SECRET-FORM-PARENT')).toBe(false);
    expect(s.includes('KEEP-FORM')).toBe(true);
    const fields = openBytes(r.bytes).getTrailer().get('Root').get('AcroForm').get('Fields');
    expect(fields.length).toBe(1);
  });

  it('E3a: 範囲を横切る非表示のレイヤーの線画は ① で見つかり、線も削除・画像化で座標が残らない', () => {
    const bytes = build((doc, font) => {
      const ocg = hiddenOCG(doc);
      const res = fontRes(doc, font);
      const props = doc.newDictionary();
      props.put('OC1', ocg);
      res.put('Properties', props);
      addPage(doc, res, '/OC /OC1 BDC 0 0 1 RG 2 w 200 700 m 311.111 712.222 l 333.333 688.888 l 450 705 l S EMC BT /F1 14 Tf 72 600 Td (KEEP1) Tj ET');
    });
    const first = run(bytes);
    expect(first.report.marks[0].pixels).toBe(false);
    expect(first.report.pixelFailedPages).toEqual([0]);
    for (const choice of [{ lineArtTouchedPages: [0], rasterPages: [] }, { lineArtTouchedPages: [], rasterPages: [0] }]) {
      const r = run(bytes, choice);
      expect(r.report.ok).toBe(true);
      const s = raw(r.bytes);
      expect(s.includes('311.111')).toBe(false);
      expect(s.includes('333.333')).toBe(false);
    }
  });

  // 模様の試料。after は塗りの後の内容（検証の記録の試料は、模様の色のまま KEEP1 を描く）
  function patternDoc(after: string): Uint8Array {
    return build((doc, font) => {
      const res = fontRes(doc, font);
      const pd = doc.newDictionary();
      pd.put('Type', doc.newName('Pattern'));
      pd.put('PatternType', 1);
      pd.put('PaintType', 1);
      pd.put('TilingType', 1);
      pd.put('BBox', arr(doc, [0, 0, 100, 20]));
      pd.put('XStep', 100);
      pd.put('YStep', 20);
      pd.put('Resources', fontRes(doc, font));
      pd.put('Matrix', arr(doc, [1, 0, 0, 1, 250, 690]));
      const pats = doc.newDictionary();
      pats.put('P1', doc.addStream('0 0 1 rg BT /F1 12 Tf 2 4 Td (SECRET-PATTERN) Tj ET', pd));
      res.put('Pattern', pats);
      addPage(doc, res, `/Pattern cs /P1 scn 250 690 100 20 re f ${after}`);
    });
  }

  // MuPDF の墨消しは色の指定を描く直前にだけ書き出すので、範囲の中だけを塗った模様は、塗りが消えると色の指定ごと消え、
  // 保存（sanitize）で資源からも落ちる（実測。この試験は修正なしで通る）
  it('E5: 範囲の中だけを塗るタイルの模様の中の文字は、適用後のファイルに残らない', () => {
    for (const after of ['', '0 g BT /F1 14 Tf 72 600 Td (KEEP1) Tj ET']) {
      const bytes = patternDoc(after);
      expect(raw(bytes)).toContain('SECRET-PATTERN');
      const r = run(bytes);
      expect(r.report.ok).toBe(true);
      expect(raw(r.bytes).includes('SECRET-PATTERN')).toBe(false);
    }
  });

  it('E5（検証の記録の試料）: 模様が範囲の外の文字も塗っているときは、模様を残す（範囲の外に見えている内容のため）', () => {
    // 検証の記録の試料では、矩形の塗りの後も塗りの色が模様のままで、KEEP1 の字形をその模様で塗っている。
    // 模様の中身は範囲の外（KEEP1 の字形の中）に見えているので、範囲の内容ではない。外すと KEEP1 の見た目が変わる
    const bytes = patternDoc('BT /F1 14 Tf 72 600 Td (KEEP1) Tj ET');
    // 元の PDF で、KEEP1 の字形の中に模様の青が見えている（模様は範囲の外の描画にも使われている）
    const pix = openBytes(bytes).loadPage(0).toPixmap(mupdf.Matrix.scale(4, 4), mupdf.ColorSpace.DeviceRGB, false, false);
    const px = pix.getPixels();
    let blue = 0;
    for (let y = 222 * 4; y < 244 * 4; y++) for (let x = 70 * 4; x < 130 * 4; x++) {
      const i = (y * pix.getWidth() + x) * 3;
      if (px[i + 2] > 200 && px[i] < 80 && px[i + 1] < 80) blue++;
    }
    expect(blue).toBeGreaterThan(0);
    const r = run(bytes);
    expect(r.report.ok).toBe(true);
    expect(raw(r.bytes)).toContain('SECRET-PATTERN');
    expect(raw(r.bytes)).toContain('/P1 scn');
  });

  // 検証の記録では範囲の中の値が [0, 255] とされたが、測った行（5〜34）が範囲（画像の行 6.4〜38.4）の外の 5 行目を含んでいた。
  // MuPDF は範囲に掛かる SMask の画素も 255 にする（実測: 行 6〜38 は一様、範囲の外の行 5・39 は元の縞）。この試験は修正なしで通る
  it('E6: 画像の SMask の、範囲の中の値が一様になる（秘密の形が残らない）', () => {
    const w = 120;
    const h = 40;
    const bytes = build((doc, font) => {
      const res = fontRes(doc, font);
      const base = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, w, h], false);
      base.clear(0);
      const mask = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, w, h], false);
      const mp = mask.getPixels();
      // 形: 左半分に縞模様（範囲の中）と、右端の縞模様（範囲の外。残る）
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) mp[y * w + x] = (x < 60 || x >= 110) && (x >> 2) % 2 === 0 ? 255 : 0;
      const img = doc.addImage(new mupdf.Image(base));
      img.put('SMask', doc.addImage(new mupdf.Image(mask)));
      const xo = doc.newDictionary();
      xo.put('Im1', img);
      res.put('XObject', xo);
      // 画像は利用者空間 (200,680)〜(500,730)。1 画素 = 2.5pt × 1.25pt
      addPage(doc, res, 'q 300 0 0 50 200 680 cm /Im1 Do Q BT /F1 14 Tf 72 600 Td (KEEP1) Tj ET');
    });
    const r = run(bytes);
    expect(r.report.ok).toBe(true);
    const doc = openBytes(r.bytes);
    const masks: { inside: Set<number>; outside: Set<number> }[] = [];
    doc
      .loadPage(0)
      .getObject()
      .getInheritable('Resources')
      .get('XObject')
      .forEach((v) => {
        if (!v.get('Subtype').isName() || v.get('Subtype').asName() !== 'Image' || v.get('SMask').isNull()) return;
        const p = doc.loadImage(v.get('SMask')).toPixmap();
        const px = p.getPixels();
        const n = p.getNumberOfComponents();
        const inside = new Set<number>();
        const outside = new Set<number>();
        // 範囲 x 240..400 → 画像の列 16..80、y 682..722 → 画像の行（上から）6..38。縁を 2 画素除く
        for (let y = 8; y < 36; y++) for (let x = 18; x < 78; x++) inside.add(px[(y * p.getWidth() + x) * n]);
        for (let y = 0; y < h; y++) for (let x = 110; x < 120; x++) outside.add(px[(y * p.getWidth() + x) * n]);
        masks.push({ inside, outside });
      });
    expect(masks).toHaveLength(1);
    expect([...masks[0].inside]).toHaveLength(1);
    // 範囲の外の形は残る
    expect([...masks[0].outside].sort((a, b) => a - b)).toEqual([0, 255]);
  });

  it('E7: 文書の情報・しおり・添付・スクリプト・ページラベルを消す（選んだとき）。構造ツリーの /T は範囲のページなら常に消す', () => {
    const bytes = build((doc, font) => {
      const pageRef = addPage(doc, fontRes(doc, font), 'BT /F1 14 Tf 250 700 Td (SECRET-X) Tj ET BT /F1 14 Tf 72 600 Td (KEEP1) Tj ET');
      const trailer = doc.getTrailer();
      const info = doc.newDictionary();
      info.put('Title', doc.newString('SECRET-INFO-TITLE'));
      trailer.put('Info', doc.addObject(info));
      const root = trailer.get('Root');
      const md = doc.newDictionary();
      md.put('Type', doc.newName('Metadata'));
      md.put('Subtype', doc.newName('XML'));
      root.put('Metadata', doc.addRawStream('<x:xmpmeta><dc:title>SECRET-XMP</dc:title></x:xmpmeta>', md));
      const outlines = doc.addObject(doc.newDictionary());
      const item = doc.addObject(doc.newDictionary());
      item.put('Title', doc.newString('SECRET-OUTLINE'));
      item.put('Parent', outlines);
      outlines.put('First', item);
      outlines.put('Last', item);
      root.put('Outlines', outlines);
      const ef = doc.newDictionary();
      ef.put('Type', doc.newName('EmbeddedFile'));
      const fs = doc.newDictionary();
      fs.put('Type', doc.newName('Filespec'));
      fs.put('F', doc.newString('secret.txt'));
      const efd = doc.newDictionary();
      efd.put('F', doc.addRawStream('SECRET-EMBEDDED-DATA', ef));
      fs.put('EF', efd);
      const names = doc.newDictionary();
      const efTree = doc.newDictionary();
      const nm = doc.newArray();
      nm.push(doc.newString('secret.txt'));
      nm.push(doc.addObject(fs));
      efTree.put('Names', nm);
      names.put('EmbeddedFiles', efTree);
      const jsTree = doc.newDictionary();
      const jn = doc.newArray();
      jn.push(doc.newString('a'));
      const js = doc.newDictionary();
      js.put('S', doc.newName('JavaScript'));
      js.put('JS', doc.newString('var s = "SECRET-JS";'));
      jn.push(doc.addObject(js));
      jsTree.put('Names', jn);
      names.put('JavaScript', jsTree);
      root.put('Names', names);
      pageRef.put('StructParents', 0);
      const str = doc.addObject(doc.newDictionary());
      str.put('Type', doc.newName('StructTreeRoot'));
      const elem = doc.addObject(doc.newDictionary());
      elem.put('Type', doc.newName('StructElem'));
      elem.put('S', doc.newName('Figure'));
      elem.put('P', str);
      elem.put('Pg', pageRef);
      elem.put('K', 0);
      elem.put('T', doc.newString('SECRET-STRUCT-T'));
      str.put('K', elem);
      root.put('StructTreeRoot', str);
      const pl = doc.newDictionary();
      const nums = doc.newArray();
      nums.push(0);
      const l = doc.newDictionary();
      l.put('P', doc.newString('SECRET-PAGELABEL'));
      nums.push(l);
      pl.put('Nums', nums);
      root.put('PageLabels', pl);
    });
    const docItems = ['SECRET-INFO-TITLE', 'SECRET-XMP', 'SECRET-OUTLINE', 'SECRET-EMBEDDED-DATA', 'SECRET-JS', 'SECRET-PAGELABEL'];
    const stripped = run(bytes, none, true);
    expect(stripped.report.ok).toBe(true);
    const s = raw(stripped.bytes);
    for (const k of [...docItems, 'SECRET-STRUCT-T', 'SECRET-X']) expect(s.includes(k), k).toBe(false);
    expect(s).toContain('KEEP1');
    expect(stripped.removedDocItems).toEqual(['文書の情報（Info）', 'XMP メタデータ', 'しおり', '添付ファイル', 'JavaScript', 'ページラベル']);
    // 選ばなければ文書の情報は残す（構造ツリーの /T は範囲のページなので消す）
    const kept = run(bytes, none, false);
    const k = raw(kept.bytes);
    expect(k).toContain('SECRET-INFO-TITLE');
    expect(k).toContain('SECRET-OUTLINE');
    expect(k.includes('SECRET-STRUCT-T')).toBe(false);
    expect(kept.removedDocItems).toEqual([]);
  });

  it('E11: /Rect が範囲と交差しない注釈の外観は、/Rect の中に縮めて描かれ、範囲の中には見えない（MuPDF）', () => {
    const bytes = build((doc, font) => {
      const pageRef = addPage(doc, fontRes(doc, font), 'BT /F1 14 Tf 72 600 Td (KEEP1) Tj ET');
      const st = doc.newDictionary();
      st.put('Type', doc.newName('Annot'));
      st.put('Subtype', doc.newName('Stamp'));
      st.put('Rect', arr(doc, [50, 50, 150, 100]));
      st.put('F', 4);
      const fd = doc.newDictionary();
      fd.put('Type', doc.newName('XObject'));
      fd.put('Subtype', doc.newName('Form'));
      fd.put('BBox', arr(doc, [0, 0, 595, 842]));
      fd.put('Resources', fontRes(doc, font));
      const ap = doc.newDictionary();
      ap.put('N', doc.addStream('0 g 240 682 160 40 re f BT /F1 14 Tf 250 700 Td (SECRET-AP) Tj ET', fd));
      st.put('AP', ap);
      addAnnot(doc, pageRef, st);
    });
    // 元の PDF を注釈も描いて描画: 範囲の中は白、/Rect（ページ空間 x 50..150, y 742..792）の中に縮めた黒い四角がある
    const pix = openBytes(bytes).loadPage(0).toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, true);
    const px = pix.getPixels();
    const w = pix.getWidth();
    const dark = (x0: number, y0: number, x1: number, y1: number) => {
      let n = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (px[(y * w + x) * 3] < 128) n++;
      return n;
    };
    expect(dark(240, 120, 400, 160)).toBe(0);
    expect(dark(50, 742, 150, 792)).toBeGreaterThan(0);
  });
});

