// 精密墨消しアプリ（apps/redactor）の試験用 PDF を作る（テスト専用。Node + MuPDF）。
// contract.md の「漏洩経路の試料」(a)〜(f) と、パスワード付きの (g)。
//   (a) 消す語と残す語を 1 つの ActualText が包む（インラインの辞書と /Properties の参照、構造ツリーの ActualText）
//   (b) 範囲内に付箋注釈（/Contents に秘密）・FreeText・リンク・見えない文字
//   (c) 範囲を横切る線
//   (d) Form XObject 内の文字（入れ子の Form、/Alt・/E）
//   (e) /Rotate 90 のページ（CropBox のずれもつける）
//   (f) 画像の一部（ぼかしの指定）
//   (g) (a) をパスワード（user: pw-test）で暗号化
// 直接実行すると、引数のフォルダに redactor-*.pdf と redactor-manifest.json（秘密の語・残る語・範囲）を書く。
// 単体テストからも使えるよう、buildRedactFixtures() を書き出す（ファイルには書かない）
import * as mupdf from 'mupdf';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SIZE = 14;
const helv = new mupdf.Font('Helvetica');

// Helvetica で文字列を描いたときの幅（pt）
function textWidth(s, size = SIZE) {
  let w = 0;
  for (const ch of s) w += helv.advanceGlyph(helv.encodeCharacter(ch.codePointAt(0)));
  return w * size;
}

// 文字列を囲む利用者空間の矩形（少し余白をつける）
function textRect(x, y, s, size = SIZE, pad = 2) {
  return [x - pad, y - size * 0.25 - pad, x + textWidth(s, size) + pad, y + size * 0.8 + pad];
}

// 利用者空間の矩形 → ページ空間（/Rotate 0、MediaBox [0 0 595 842]）
function toPageSpace(r, height = 842) {
  return [r[0], height - r[3], r[2], height - r[1]];
}

// UTF-16BE（BOM つき）のバイト列
function utf16be(s) {
  const out = [0xfe, 0xff];
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    out.push(c >> 8, c & 0xff);
  }
  return out;
}

function newDoc() {
  const doc = new mupdf.PDFDocument();
  const font = doc.addSimpleFont(helv);
  return { doc, font };
}

function fontRes(doc, font) {
  const res = doc.newDictionary();
  const fonts = doc.newDictionary();
  fonts.put('F1', font);
  res.put('Font', fonts);
  return res;
}

function addPage(doc, res, content, rotate = 0, mediabox = [0, 0, 595, 842]) {
  const pobj = doc.addPage(mediabox, rotate, res, content);
  doc.insertPage(-1, pobj);
  return doc.findPage(doc.countPages() - 1);
}

const tj = (x, y, s, extra = '') => `BT /F1 ${SIZE} Tf ${extra}${x} ${y} Td (${s}) Tj ET`;

// 本体と同じ形の /Redact 注釈を書く（利用者空間の /Rect と /QuadPoints、/IC、/PDFEditMode）
function addRedactAnnot(doc, pageRef, rect, { color = null, blur = false } = {}) {
  const [x0, y0, x1, y1] = rect;
  const annot = doc.newDictionary();
  annot.put('Type', doc.newName('Annot'));
  annot.put('Subtype', doc.newName('Redact'));
  const r = doc.newArray();
  for (const v of rect) r.push(v);
  annot.put('Rect', r);
  const q = doc.newArray();
  // 左上・右上・左下・右下（利用者空間）
  for (const v of [x0, y1, x1, y1, x0, y0, x1, y0]) q.push(v);
  annot.put('QuadPoints', q);
  if (color) {
    const ic = doc.newArray();
    for (const v of color) ic.push(v);
    annot.put('IC', ic);
  }
  if (blur) annot.put('PDFEditMode', doc.newName('Blur'));
  annot.put('P', pageRef);
  const ref = doc.addObject(annot);
  let annots = pageRef.get('Annots');
  if (!annots.isArray()) {
    pageRef.put('Annots', doc.newArray());
    annots = pageRef.get('Annots');
  }
  annots.push(ref);
  return ref;
}

function addAnnotRaw(doc, pageRef, dict) {
  const ref = doc.addObject(dict);
  let annots = pageRef.get('Annots');
  if (!annots.isArray()) {
    pageRef.put('Annots', doc.newArray());
    annots = pageRef.get('Annots');
  }
  annots.push(ref);
  return ref;
}

function finish(doc) {
  return doc.saveToBuffer('compress').asUint8Array().slice();
}

// (a) ActualText
function fixtureA() {
  const { doc, font } = newDoc();
  const res = fontRes(doc, font);
  const props = doc.newDictionary();
  const mc0 = doc.addObject(doc.newDictionary());
  mc0.put('ActualText', doc.newByteString(utf16be('SECRET-A2 KEEP-A2')));
  mc0.put('Alt', doc.newString('SECRET-A2 alt'));
  mc0.put('E', doc.newString('SECRET-A2 expansion'));
  props.put('MC0', mc0);
  res.put('Properties', props);
  const content = [
    '/Span <</ActualText (SECRET-A1 KEEP-A1) /E (SECRET-A1) /MCID 0>> BDC',
    `BT /F1 ${SIZE} Tf 72 700 Td (SECRET-A1) Tj ( KEEP-A1) Tj ET`,
    'EMC',
    '/Span /MC0 BDC',
    `BT /F1 ${SIZE} Tf 72 660 Td (SECRET-A2) Tj ( KEEP-A2) Tj ET`,
    'EMC',
    tj(72, 620, 'OUTSIDE-A'),
  ].join('\n');
  const pageRef = addPage(doc, res, content);
  pageRef.put('StructParents', 0);
  // 元の内容の写しを持ちうるページの付属物: 埋め込みのサムネイル（データに秘密の文字列を含む無圧縮の画像）と、作成アプリの私的なデータ
  const thumbDict = doc.newDictionary();
  thumbDict.put('Width', 9);
  thumbDict.put('Height', 1);
  thumbDict.put('ColorSpace', doc.newName('DeviceGray'));
  thumbDict.put('BitsPerComponent', 8);
  pageRef.put('Thumb', doc.addRawStream('SECRET-A4', thumbDict));
  const piece = doc.newDictionary();
  const app = doc.newDictionary();
  app.put('Private', doc.newString('SECRET-A5 original text'));
  app.put('LastModified', doc.newString('D:20261007000000'));
  piece.put('ExampleApp', app);
  pageRef.put('PieceInfo', piece);
  // 構造ツリー: MCID 0 を包む要素に ActualText（秘密）
  const root = doc.getTrailer().get('Root');
  const str = doc.addObject(doc.newDictionary());
  str.put('Type', doc.newName('StructTreeRoot'));
  const elem = doc.addObject(doc.newDictionary());
  elem.put('Type', doc.newName('StructElem'));
  elem.put('S', doc.newName('Span'));
  elem.put('P', str);
  elem.put('Pg', pageRef);
  elem.put('K', 0);
  elem.put('ActualText', doc.newString('SECRET-A3 struct'));
  str.put('K', elem);
  root.put('StructTreeRoot', str);
  const r1 = textRect(72, 700, 'SECRET-A1');
  const r2 = textRect(72, 660, 'SECRET-A2');
  addRedactAnnot(doc, pageRef, r1);
  addRedactAnnot(doc, pageRef, r2, { color: [0.8, 0, 0] });
  return {
    name: 'redactor-a-actualtext.pdf',
    bytes: finish(doc),
    secrets: ['SECRET-A1', 'SECRET-A2', 'SECRET-A3', 'SECRET-A4', 'SECRET-A5'],
    keeps: ['KEEP-A1', 'KEEP-A2', 'OUTSIDE-A'],
    regions: [
      { page: 0, rect: toPageSpace(r1) },
      { page: 0, rect: toPageSpace(r2), color: [0.8, 0, 0] },
    ],
    markBy: 'annot',
  };
}

// (b) 付箋・FreeText・リンク・見えない文字
function fixtureB() {
  const { doc, font } = newDoc();
  const res = fontRes(doc, font);
  const content = [tj(72, 700, 'KEEP-B1'), tj(250, 700, 'SECRET-B'), tj(420, 700, 'KEEP-B2'), tj(250, 680, 'SECRET-B-HIDDEN', '3 Tr '), tj(72, 600, 'KEEP-B3')].join('\n');
  const pageRef = addPage(doc, res, content);
  // 範囲（利用者空間）: x 240〜400, y 670〜716
  const region = [240, 670, 400, 716];
  const text = doc.newDictionary();
  text.put('Type', doc.newName('Annot'));
  text.put('Subtype', doc.newName('Text'));
  const tr = doc.newArray();
  for (const v of [330, 690, 348, 708]) tr.push(v);
  text.put('Rect', tr);
  text.put('Contents', doc.newString('SECRET-B-NOTE'));
  text.put('P', pageRef);
  const textRef = addAnnotRaw(doc, pageRef, text);
  const popup = doc.newDictionary();
  popup.put('Type', doc.newName('Annot'));
  popup.put('Subtype', doc.newName('Popup'));
  const pr = doc.newArray();
  for (const v of [400, 450, 560, 560]) pr.push(v);
  popup.put('Rect', pr);
  popup.put('Parent', textRef);
  popup.put('P', pageRef);
  const popupRef = addAnnotRaw(doc, pageRef, popup);
  textRef.put('Popup', popupRef);
  const free = doc.newDictionary();
  free.put('Type', doc.newName('Annot'));
  free.put('Subtype', doc.newName('FreeText'));
  const fr = doc.newArray();
  for (const v of [250, 672, 330, 684]) fr.push(v);
  free.put('Rect', fr);
  free.put('Contents', doc.newString('SECRET-B-FREE'));
  free.put('DA', doc.newString('/Helv 8 Tf 0 g'));
  free.put('P', pageRef);
  addAnnotRaw(doc, pageRef, free);
  const link = doc.newDictionary();
  link.put('Type', doc.newName('Annot'));
  link.put('Subtype', doc.newName('Link'));
  const lr = doc.newArray();
  for (const v of [250, 695, 330, 712]) lr.push(v);
  link.put('Rect', lr);
  const action = doc.newDictionary();
  action.put('S', doc.newName('URI'));
  action.put('URI', doc.newString('https://example.invalid/SECRET-B-LINK'));
  link.put('A', action);
  link.put('P', pageRef);
  addAnnotRaw(doc, pageRef, link);
  return {
    name: 'redactor-b-note.pdf',
    bytes: finish(doc),
    secrets: ['SECRET-B'],
    keeps: ['KEEP-B1', 'KEEP-B2', 'KEEP-B3'],
    regions: [{ page: 0, rect: toPageSpace(region) }],
    markBy: 'draw',
  };
}

// (c) 範囲を横切る線
function fixtureC() {
  const { doc, font } = newDoc();
  const res = fontRes(doc, font);
  const content = [tj(72, 700, 'KEEP-C1'), tj(250, 700, 'SECRET-C'), tj(420, 700, 'KEEP-C2'), '1 0 0 RG 1.5 w 60 704 m 540 704 l S', tj(72, 640, 'KEEP-C3')].join('\n');
  const pageRef = addPage(doc, res, content);
  const r = textRect(250, 700, 'SECRET-C');
  addRedactAnnot(doc, pageRef, r);
  return {
    name: 'redactor-c-line.pdf',
    bytes: finish(doc),
    secrets: ['SECRET-C'],
    keeps: ['KEEP-C1', 'KEEP-C2', 'KEEP-C3'],
    regions: [{ page: 0, rect: toPageSpace(r) }],
    markBy: 'annot',
  };
}

// (d) Form XObject 内の文字（入れ子・/Alt・/E）
function fixtureD() {
  const { doc, font } = newDoc();
  const res = fontRes(doc, font);
  const inner = doc.newDictionary();
  inner.put('Type', doc.newName('XObject'));
  inner.put('Subtype', doc.newName('Form'));
  const bb = doc.newArray();
  for (const v of [0, 0, 595, 842]) bb.push(v);
  inner.put('BBox', bb);
  inner.put('Resources', fontRes(doc, font));
  const fm2 = doc.addStream(['/Span <</Alt (SECRET-D-ALT) /E (SECRET-D-E)>> BDC', tj(250, 600, 'SECRET-D2'), 'EMC', tj(72, 600, 'KEEP-D3')].join('\n'), inner);
  const outer = doc.newDictionary();
  outer.put('Type', doc.newName('XObject'));
  outer.put('Subtype', doc.newName('Form'));
  const bb2 = doc.newArray();
  for (const v of [0, 0, 595, 842]) bb2.push(v);
  outer.put('BBox', bb2);
  const ores = fontRes(doc, font);
  const oxo = doc.newDictionary();
  oxo.put('Fm2', fm2);
  ores.put('XObject', oxo);
  outer.put('Resources', ores);
  const fm1 = doc.addStream([tj(72, 700, 'KEEP-D1'), tj(250, 700, 'SECRET-D'), 'q /Fm2 Do Q'].join('\n'), outer);
  const xo = doc.newDictionary();
  xo.put('Fm1', fm1);
  res.put('XObject', xo);
  addPage(doc, res, ['q /Fm1 Do Q', tj(72, 650, 'KEEP-D2')].join('\n'));
  return {
    name: 'redactor-d-form.pdf',
    bytes: finish(doc),
    secrets: ['SECRET-D'],
    keeps: ['KEEP-D1', 'KEEP-D2', 'KEEP-D3'],
    regions: [
      { page: 0, rect: toPageSpace(textRect(250, 700, 'SECRET-D')) },
      { page: 0, rect: toPageSpace(textRect(250, 600, 'SECRET-D2')) },
    ],
    markBy: 'search',
    search: 'SECRET-D',
  };
}

// (e) /Rotate 90（CropBox のずれつき）
function fixtureE() {
  const { doc, font } = newDoc();
  const res = fontRes(doc, font);
  const content = [tj(72, 700, 'KEEP-E1'), tj(250, 700, 'SECRET-E'), tj(420, 700, 'KEEP-E2'), tj(72, 400, 'KEEP-E3')].join('\n');
  const pageRef = addPage(doc, res, content, 90);
  const crop = doc.newArray();
  for (const v of [20, 30, 575, 812]) crop.push(v);
  pageRef.put('CropBox', crop);
  return {
    name: 'redactor-e-rotate.pdf',
    bytes: finish(doc),
    secrets: ['SECRET-E'],
    keeps: ['KEEP-E1', 'KEEP-E2', 'KEEP-E3'],
    // 範囲は検索で決める（ページ空間は回転とずれを反映したもの）
    regions: [],
    markBy: 'search',
    search: 'SECRET-E',
  };
}

// (f) 画像の一部（ぼかし）
function fixtureF() {
  const { doc, font } = newDoc();
  const res = fontRes(doc, font);
  // 200x200 の画像: 左は青、右上に赤い「秘密」の四角（150..190 x 10..50）、右下は緑
  const w = 200;
  const h = 200;
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, w, h], false);
  const px = pix.getPixels();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      let c = x < 100 ? [40, 80, 200] : y < 100 ? [230, 230, 230] : [40, 170, 60];
      if (x >= 150 && x < 190 && y >= 10 && y < 50) c = [220, 20, 20];
      px[i] = c[0];
      px[i + 1] = c[1];
      px[i + 2] = c[2];
    }
  }
  const img = doc.addImage(new mupdf.Image(pix));
  const xo = doc.newDictionary();
  xo.put('Im1', img);
  res.put('XObject', xo);
  // 画像は利用者空間 (200,400)〜(400,600)。赤い四角は x 350..390, y 550..590
  const pageRef = addPage(doc, res, ['q 200 0 0 200 200 400 cm /Im1 Do Q', tj(72, 700, 'KEEP-F1'), tj(72, 300, 'KEEP-F2')].join('\n'));
  // 範囲は画像の右上の四分の一と、その外へはみ出す部分
  const r = [300, 500, 430, 620];
  addRedactAnnot(doc, pageRef, r, { blur: true });
  return {
    name: 'redactor-f-image.pdf',
    bytes: finish(doc),
    secrets: [],
    keeps: ['KEEP-F1', 'KEEP-F2'],
    regions: [{ page: 0, rect: toPageSpace(r), mode: 'blur' }],
    markBy: 'annot',
    // 範囲の中にあった赤（元の画像の秘密の部分）
    secretColor: [220, 20, 20],
  };
}

// (g) パスワード付き（(a) を暗号化）
function fixtureG(a) {
  const doc = mupdf.Document.openDocument(a.bytes, 'application/pdf').asPDF();
  const bytes = doc.saveToBuffer('encrypt=aes-256,user-password=pw-test,owner-password=pw-owner').asUint8Array().slice();
  return { ...a, name: 'redactor-g-encrypted.pdf', bytes, password: 'pw-test' };
}

export function buildRedactFixtures() {
  const a = fixtureA();
  return [a, fixtureB(), fixtureC(), fixtureD(), fixtureE(), fixtureF(), fixtureG(a)];
}

// 直接実行したときだけファイルに書く（出力先は引数。省略時は今いるフォルダの redactor-fixtures）
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const outDir = path.resolve(process.argv[2] ?? 'redactor-fixtures');
  fs.mkdirSync(outDir, { recursive: true });
  const manifest = {};
  for (const f of buildRedactFixtures()) {
    fs.writeFileSync(path.join(outDir, f.name), f.bytes);
    const { bytes, ...meta } = f;
    manifest[f.name] = meta;
    console.log('生成:', f.name, bytes.length, 'bytes');
  }
  fs.writeFileSync(path.join(outDir, 'redactor-manifest.json'), JSON.stringify(manifest, null, 2));
}
