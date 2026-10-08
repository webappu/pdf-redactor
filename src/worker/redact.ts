// 墨消しの適用（contract.md の「4. 適用」の 1〜6）。元の文書を開き直した写しに対して行う。
//   1. 範囲と交差する既存の注釈を削除（付箋の本文が残る漏洩への対策）
//   2. ぼかしの範囲を、適用前に低解像度で描いておく
//   3. applyRedactions(false, 画素, 覆われた線画を削除（選んだページは触れた線画も）, 文字を削除)
//   4. 内容ストリームと Form XObject のマーク付き内容から ActualText・Alt・E を取り除く
//   5. 塗りの矩形・ぼかし画像を最前面に描く（目印つきの Form XObject。事後検査で覆いを見分ける）
//   6. saveToBuffer('garbage=4,compress,clean,sanitize,objstms')
// 画像化を選んだページは 4 の後でページを画像にし（範囲の画素は白で塗りつぶす）、その上に 5 の覆いを描く
import * as mupdf from 'mupdf';
import { blurRegion } from './blur';
import { concatMatrix, invertMatrix, num, rectCorners, rectsIntersect, type Mat } from '../lib/geom';
import type { ApplyChoice, ApplyOptions, Mark, Rect } from '../lib/types';
import { stripDocumentItems } from './document';
import { scrubPage, scrubStructTree } from './scrub';

export const SAVE_OPTIONS = 'garbage=4,compress,clean,sanitize,objstms';
// 覆いの Form XObject の目印のキー（値はページごとの合言葉）
export const COVER_KEY = 'PDFRedactorCover';
// 画像化するときの解像度
export const RASTER_DPI = 200;
// 墨消ししたページから消す付属物（元の内容の写しを持ちうるもの）
export const PAGE_COPIES = ['Thumb', 'PieceInfo', 'Metadata'];

export interface RedactOutput {
  bytes: Uint8Array;
  removedAnnots: number;
  removedActualText: number;
  // 消した文書の項目（文書の情報・しおり・添付・スクリプトなど。選んだときだけ）
  removedDocItems: string[];
}

export function coverToken(token: string, page: number): string {
  return `${token}:${page}`;
}

function groupByPage(marks: Mark[]): Map<number, Mark[]> {
  const m = new Map<number, Mark[]>();
  for (const mark of marks) {
    const list = m.get(mark.page) ?? [];
    list.push(mark);
    m.set(mark.page, list);
  }
  return new Map([...m.entries()].sort((a, b) => a[0] - b[0]));
}

// 既存の /Redact 注釈をすべて消す（候補は画面の範囲の一覧に読み込み済み。出力に候補を残さない）
function deleteRedactAnnots(doc: mupdf.PDFDocument): void {
  const n = doc.countPages();
  for (let i = 0; i < n; i++) {
    const page = doc.loadPage(i);
    for (const a of [...page.getAnnotations()]) {
      if (a.getType() === 'Redact') page.deleteAnnotation(a);
    }
  }
}

function annotRect(a: mupdf.PDFAnnotation): Rect {
  try {
    return a.getBounds() as Rect;
  } catch {
    return a.getRect() as Rect;
  }
}

// /Annots の要素の /Rect（利用者空間）をページ空間の外接矩形にする
export function rawAnnotRect(annot: mupdf.PDFObject, ctm: Mat): Rect | null {
  const r = annot.get('Rect');
  if (!r.isArray() || r.length !== 4) return null;
  const v = [0, 1, 2, 3].map((k) => r.get(k).asNumber());
  if (v.some((x) => !Number.isFinite(x))) return null;
  const pts = rectCorners([v[0], v[1], v[2], v[3]], ctm);
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

// 欄の木（AcroForm）から、ウィジェットが 1 つも残っていない欄を外す（独立の検証 E1）。
// MuPDF はウィジェットを消すと親の /Kids と /Fields からは外すが、親の欄（/V に値）は残す。
// ほかのページにウィジェットが残る欄は、その値がそこに見えているので残す
function pruneEmptyFields(doc: mupdf.PDFDocument, parents: mupdf.PDFObject[]): void {
  // 文書に残っている注釈（ウィジェットを含む）のオブジェクト番号
  const alive = new Set<number>();
  for (let i = 0; i < doc.countPages(); i++) {
    const arr = doc.findPage(i).get('Annots');
    if (!arr.isArray()) continue;
    for (let k = 0; k < arr.length; k++) {
      const a = arr.get(k);
      if (a.isIndirect()) alive.add(a.asIndirect());
    }
  }
  const hasWidget = (field: mupdf.PDFObject, depth: number): boolean => {
    if (depth > 32) return true;
    if (field.isIndirect() && alive.has(field.asIndirect())) return true;
    const kids = field.get('Kids');
    if (!kids.isArray()) return false;
    for (let k = 0; k < kids.length; k++) if (hasWidget(kids.get(k), depth + 1)) return true;
    return false;
  };
  const removeFrom = (arr: mupdf.PDFObject, num: number) => {
    if (!arr.isArray()) return;
    for (let k = arr.length - 1; k >= 0; k--) {
      const v = arr.get(k);
      if (v.isIndirect() && v.asIndirect() === num) arr.delete(k);
    }
  };
  const acro = doc.getTrailer().get('Root').get('AcroForm');
  const done = new Set<number>();
  for (let field of parents) {
    // 下から上へ: 空になった欄を外し、その親も確かめる
    for (let depth = 0; depth < 32 && field.isIndirect(); depth++) {
      const num = field.asIndirect();
      if (done.has(num) || hasWidget(field, 0)) break;
      done.add(num);
      const up = field.get('Parent');
      if (up.isDictionary()) removeFrom(up.get('Kids'), num);
      if (acro.isDictionary()) removeFrom(acro.get('Fields'), num);
      if (!up.isIndirect()) break;
      field = up;
    }
  }
}

// 1. 範囲と交差する注釈を削除する。
//    MuPDF.js の一覧（注釈・ウィジェット）は deleteAnnotation で消す（ポップアップ・フォームの欄も一緒に消える）。
//    ポップアップが交差するときは親（付箋など）も消す。
//    一覧に出ないもの（リンク・親のないポップアップなど）は /Annots から直接外す
function deleteIntersectingAnnots(doc: mupdf.PDFDocument, page: mupdf.PDFPage, rects: Rect[]): number {
  const hit = (r: Rect | null) => r !== null && rects.some((x) => rectsIntersect(x, r));
  const ctm = page.getTransform() as Mat;
  const pageObj = page.getObject();
  const parents = new Set<number>();
  const arr0 = pageObj.get('Annots');
  if (arr0.isArray()) {
    for (let i = 0; i < arr0.length; i++) {
      const a = arr0.get(i);
      if (a.get('Subtype').isName() && a.get('Subtype').asName() === 'Popup' && hit(rawAnnotRect(a, ctm))) {
        const parent = a.get('Parent');
        if (parent.isIndirect()) parents.add(parent.asIndirect());
      }
    }
  }
  const targets = [...page.getAnnotations()].filter((a) => {
    const o = a.getObject();
    return (o.isIndirect() && parents.has(o.asIndirect())) || hit(annotRect(a));
  });
  const widgets = [...page.getWidgets()].filter((w) => hit(annotRect(w)));
  // 消すウィジェットの親の欄（/V を持ちうる）。消した後に、ほかにウィジェットがなければ欄ごと外す
  const fieldParents: mupdf.PDFObject[] = [];
  for (const w of widgets) {
    const parent = w.getObject().get('Parent');
    if (parent.isIndirect()) fieldParents.push(parent);
  }
  let removed = 0;
  for (const a of [...targets, ...widgets]) {
    try {
      page.deleteAnnotation(a);
      removed++;
    } catch {
      // 親と一緒に消えたポップアップなど
    }
  }
  if (fieldParents.length) pruneEmptyFields(doc, fieldParents);
  // 残りを /Annots から直接外す
  const arr = page.getObject().get('Annots');
  if (arr.isArray()) {
    for (let i = arr.length - 1; i >= 0; i--) {
      const a = arr.get(i);
      if (hit(rawAnnotRect(a, ctm))) {
        arr.delete(i);
        removed++;
      }
    }
  }
  return removed;
}

// 範囲に掛かる行の高さ（なければ 12pt）
function lineHeight(page: mupdf.PDFPage, rect: Rect): number {
  let h = 0;
  const st = page.toStructuredText('');
  st.walk({
    beginLine(bbox) {
      const b = bbox as Rect;
      if (rectsIntersect(b, rect)) h = Math.max(h, Math.min(b[2] - b[0], b[3] - b[1]));
    },
  });
  return h > 0 ? h : 12;
}

// 範囲を描く（注釈なし）。bbox は画素の範囲（scale 倍したページ空間）
export function renderContents(page: mupdf.PDFPage, bbox: Rect, scale: number, alpha: boolean): mupdf.Pixmap {
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, bbox, alpha);
  if (alpha) pix.clear();
  else pix.clear(255);
  const dev = new mupdf.DrawDevice(mupdf.Matrix.identity, pix);
  try {
    page.runPageContents(dev, mupdf.Matrix.scale(scale, scale));
  } finally {
    dev.close();
  }
  return pix;
}

interface BlurImage {
  image: mupdf.Image;
  bbox: Rect; // ページ空間（整数に丸めた外接）
}

// 2. ぼかしの画像（適用前の内容から作る）
function makeBlurImage(page: mupdf.PDFPage, rect: Rect): BlurImage {
  const bbox: Rect = [Math.floor(rect[0]), Math.floor(rect[1]), Math.ceil(rect[2]), Math.ceil(rect[3])];
  const pix = renderContents(page, bbox, 1, false);
  const w = pix.getWidth();
  const h = pix.getHeight();
  const rgb = pix.getPixels().slice();
  const block = Math.max(8, lineHeight(page, rect));
  const out = blurRegion({ pixels: rgb, width: w, height: h, block, outScale: 2 });
  const outPix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, out.width, out.height], false);
  outPix.getPixels().set(out.pixels);
  return { image: new mupdf.Image(outPix), bbox };
}

// ページの資源の辞書（継承しているときはページに写してから使う）
function ownResources(doc: mupdf.PDFDocument, pageObj: mupdf.PDFObject): mupdf.PDFObject {
  const own = pageObj.get('Resources');
  if (own.isDictionary()) return own;
  const inherited = pageObj.getInheritable('Resources');
  const res = doc.newDictionary();
  if (inherited.isDictionary()) inherited.forEach((v, k) => res.put(k, v));
  pageObj.put('Resources', res);
  return pageObj.get('Resources');
}

function uniqueName(dict: mupdf.PDFObject, base: string): string {
  let name = base;
  for (let i = 1; !dict.get(name).isNull(); i++) name = `${base}${i}`;
  return name;
}

function appendContent(doc: mupdf.PDFDocument, pageObj: mupdf.PDFObject, text: string): void {
  const stream = doc.addStream(text, doc.newDictionary());
  const old = pageObj.get('Contents');
  const arr = doc.newArray();
  if (old.isArray()) {
    for (let i = 0; i < old.length; i++) arr.push(old.get(i));
  } else if (!old.isNull()) {
    arr.push(old);
  }
  arr.push(stream);
  pageObj.put('Contents', arr);
}

function pathOps(rect: Rect, inv: Mat): string {
  const c = rectCorners(rect, inv);
  return `${num(c[0][0])} ${num(c[0][1])} m ${num(c[1][0])} ${num(c[1][1])} l ${num(c[2][0])} ${num(c[2][1])} l ${num(c[3][0])} ${num(c[3][1])} l h`;
}

// 画像の単位正方形 → ページ空間の bbox（1 行目が上）→ 利用者空間
function imageMatrix(bbox: Rect, inv: Mat): Mat {
  const toPage: Mat = [bbox[2] - bbox[0], 0, 0, -(bbox[3] - bbox[1]), bbox[0], bbox[3]];
  return concatMatrix(toPage, inv);
}

// 5. 覆いを最前面に描く
function addCover(doc: mupdf.PDFDocument, page: mupdf.PDFPage, marks: Mark[], blurs: Map<string, BlurImage>, token: string): void {
  const pageObj = page.getObject();
  const inv = invertMatrix(page.getTransform() as Mat);
  const xobj = doc.newDictionary();
  let ops = '';
  let i = 0;
  for (const m of marks) {
    const path = pathOps(m.rect, inv);
    const blur = blurs.get(m.id);
    if (m.mode === 'blur' && blur) {
      const name = `Im${i++}`;
      xobj.put(name, doc.addImage(blur.image));
      const mat = imageMatrix(blur.bbox, inv);
      ops += `q ${path} W n ${mat.map(num).join(' ')} cm /${name} Do Q\n`;
    } else {
      const [r, g, b] = m.color;
      ops += `q ${num(r)} ${num(g)} ${num(b)} rg ${path} f Q\n`;
    }
  }
  const formRes = doc.newDictionary();
  formRes.put('XObject', xobj);
  const media = pageObj.getInheritable('MediaBox');
  const bboxArr = doc.newArray();
  const mb = media.isArray() && media.length === 4 ? [0, 1, 2, 3].map((k) => media.get(k).asNumber()) : [-14400, -14400, 14400, 14400];
  for (const v of mb) bboxArr.push(v);
  const dict = doc.newDictionary();
  dict.put('Type', doc.newName('XObject'));
  dict.put('Subtype', doc.newName('Form'));
  dict.put('BBox', bboxArr);
  dict.put('Resources', formRes);
  dict.put(COVER_KEY, doc.newString(token));
  const form = doc.addStream(ops, dict);
  const res = ownResources(doc, pageObj);
  let xo = res.get('XObject');
  if (!xo.isDictionary()) {
    res.put('XObject', doc.newDictionary());
    xo = res.get('XObject');
  }
  const name = uniqueName(xo, 'RdcCover');
  xo.put(name, form);
  appendContent(doc, pageObj, `q /${name} Do Q\n`);
}

// 画像化: 墨消し後の内容（覆いなし・注釈なし）を描き、範囲の画素を白で塗りつぶしてから、ページの内容をその画像だけにする
function rasterizePage(doc: mupdf.PDFDocument, page: mupdf.PDFPage, rects: Rect[]): void {
  const scale = RASTER_DPI / 72;
  const pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, false);
  const px = pix.getPixels();
  const w = pix.getWidth();
  const h = pix.getHeight();
  const ox = pix.getX();
  const oy = pix.getY();
  for (const r of rects) {
    // 範囲に少しでも掛かる画素（1 画素広げる）
    const x0 = Math.max(0, Math.floor(r[0] * scale) - ox - 1);
    const y0 = Math.max(0, Math.floor(r[1] * scale) - oy - 1);
    const x1 = Math.min(w, Math.ceil(r[2] * scale) - ox + 1);
    const y1 = Math.min(h, Math.ceil(r[3] * scale) - oy + 1);
    for (let y = y0; y < y1; y++) px.fill(255, (y * w + x0) * 3, (y * w + x1) * 3);
  }
  const image = doc.addImage(new mupdf.Image(pix));
  const inv = invertMatrix(page.getTransform() as Mat);
  const bbox: Rect = [ox / scale, oy / scale, (ox + w) / scale, (oy + h) / scale];
  const mat = imageMatrix(bbox, inv);
  const pageObj = page.getObject();
  const res = doc.newDictionary();
  const xo = doc.newDictionary();
  xo.put('RdcPage', image);
  res.put('XObject', xo);
  pageObj.put('Resources', res);
  pageObj.put('Contents', doc.addStream(`q ${mat.map(num).join(' ')} cm /RdcPage Do Q\n`, doc.newDictionary()));
}

export function redactDocument(doc: mupdf.PDFDocument, marks: Mark[], choice: ApplyChoice, token: string, options: ApplyOptions = { stripDocument: false }): RedactOutput {
  const byPage = groupByPage(marks);
  const touched = new Set(choice.lineArtTouchedPages);
  const raster = new Set(choice.rasterPages);
  let removedAnnots = 0;
  let removedActualText = 0;
  deleteRedactAnnots(doc);
  const pageNums = new Set<number>();
  for (const [index, pageMarks] of byPage) {
    const rects = pageMarks.map((m) => m.rect);
    // 1
    removedAnnots += deleteIntersectingAnnots(doc, doc.loadPage(index), rects);
    let page = doc.loadPage(index);
    // 2
    const blurs = new Map<string, BlurImage>();
    for (const m of pageMarks) if (m.mode === 'blur') blurs.set(m.id, makeBlurImage(page, m.rect));
    // 3
    for (const m of pageMarks) {
      const a = page.createAnnotation('Redact');
      a.setRect(m.rect);
    }
    page.applyRedactions(
      false,
      mupdf.PDFPage.REDACT_IMAGE_PIXELS,
      touched.has(index) ? mupdf.PDFPage.REDACT_LINE_ART_REMOVE_IF_TOUCHED : mupdf.PDFPage.REDACT_LINE_ART_REMOVE_IF_COVERED,
      mupdf.PDFPage.REDACT_TEXT_REMOVE,
    );
    page = doc.loadPage(index);
    const pageObj = page.getObject();
    if (pageObj.isIndirect()) pageNums.add(pageObj.asIndirect());
    // 4
    removedActualText += scrubPage(pageObj, true);
    // 元の内容の写しを持ちうるページの付属物も消す（埋め込みのサムネイル /Thumb、作成アプリの私的なデータ /PieceInfo、ページの XMP）
    for (const key of PAGE_COPIES) pageObj.delete(key);
    // 画像化
    if (raster.has(index)) {
      rasterizePage(doc, page, rects);
      page = doc.loadPage(index);
    }
    // 5
    addCover(doc, page, pageMarks, blurs, coverToken(token, index));
  }
  removedActualText += scrubStructTree(doc, pageNums, true);
  // 文書の情報・しおり・添付・スクリプトなど（選んだとき。独立の検証 E7）
  const removedDocItems = options.stripDocument ? stripDocumentItems(doc) : [];
  // 6
  const buf = doc.saveToBuffer(SAVE_OPTIONS);
  return { bytes: buf.asUint8Array().slice(), removedAnnots, removedActualText, removedDocItems };
}
