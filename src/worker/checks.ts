// 事後検査（contract.md の 4-7）。保存した PDF を開き直し、範囲ごとに確かめる。
//   ① 画素: 注釈を描かずに描いたとき、範囲の中は覆い（塗り色・ぼかし画像）だけ。次の 3 つで確かめる
//      (i)  覆いだけを描くと、範囲の中がすべて不透明（覆いが範囲を覆いきっている）
//      (ii) ふつうに描いた範囲の中が、覆いだけを描いたものと同じ（覆いの上に何も描かれていない）
//      (iii) 覆いを外して描いた範囲の中が一様（覆いの下に元の内容が残っていない。一部だけ覆われた線画はここで見つかる）
//   ②〜④と①の描画は、非表示のレイヤーもすべて表示して行う
//   ② 構造化テキストで、中心が範囲の中にある文字（空白を除く）が 0
//   ③ 墨消ししたページに ActualText・Alt・E が残っていない（内容・Form XObject・/Properties・構造ツリー）
//   ④ 範囲と交差する注釈が 0（/Annots を直接調べる）
import * as mupdf from 'mupdf';
import { pointInRect, quadCenter, rectsIntersect, type Mat } from '../lib/geom';
import type { CheckReport, Mark, MarkCheck, Rect } from '../lib/types';
import { COVER_KEY, coverToken, rawAnnotRect, renderContents } from './redact';
import { scrubPage, scrubStructTree } from './scrub';

// 画素の比較の許容差（各チャンネル）
const TOLERANCE = 4;

export function openBytes(bytes: Uint8Array, password?: string): mupdf.PDFDocument {
  const doc = mupdf.Document.openDocument(bytes, 'application/pdf');
  if (doc.needsPassword()) {
    if (!password || doc.authenticatePassword(password) === 0) throw new Error('出力を開けません（パスワード）');
  }
  const pdf = doc.asPDF();
  if (!pdf) throw new Error('PDF ではありません');
  return pdf;
}

// 検査では非表示のレイヤー（オプショナルコンテンツ）もすべて表示して描く・読む。
// 非表示の線画が範囲を横切って残っても、表示したままの描画では見えず①が合格していた（独立の検証 E3a）
function showAllLayers(doc: mupdf.PDFDocument): mupdf.PDFDocument {
  const n = doc.countLayers();
  for (let i = 0; i < n; i++) doc.setLayerVisible(i, true);
  return doc;
}

// ページの資源から、目印の合言葉が一致する覆いの名前を探す
function findCover(page: mupdf.PDFPage, token: string): { name: string; obj: mupdf.PDFObject } | null {
  const res = page.getObject().getInheritable('Resources');
  if (!res.isDictionary()) return null;
  const xo = res.get('XObject');
  if (!xo.isDictionary()) return null;
  let found: { name: string; obj: mupdf.PDFObject } | null = null;
  xo.forEach((v, k) => {
    const t = v.get(COVER_KEY);
    if (!found && t.isString() && t.asString() === token) found = { name: String(k), obj: v };
  });
  return found;
}

function regionScale(rect: Rect): number {
  const minDim = Math.max(0.1, Math.min(rect[2] - rect[0], rect[3] - rect[1]));
  return Math.min(8, Math.max(2, 16 / minDim));
}

interface Region {
  data: Uint8ClampedArray;
  n: number; // チャンネル数
  w: number;
  ox: number;
  oy: number;
}

function render(page: mupdf.PDFPage, rect: Rect, scale: number, alpha: boolean): Region {
  const bbox: Rect = [Math.floor(rect[0] * scale), Math.floor(rect[1] * scale), Math.ceil(rect[2] * scale), Math.ceil(rect[3] * scale)];
  const pix = renderContents(page, bbox, scale, alpha);
  // getNumberOfComponents はアルファを含む数
  return { data: pix.getPixels().slice(), n: pix.getNumberOfComponents(), w: pix.getWidth(), ox: pix.getX(), oy: pix.getY() };
}

// 範囲の内側（縁の 1 画素を除く）の画素の位置
function interior(rect: Rect, scale: number): { x0: number; y0: number; x1: number; y1: number } {
  return {
    x0: Math.ceil(rect[0] * scale + 1),
    y0: Math.ceil(rect[1] * scale + 1),
    x1: Math.floor(rect[2] * scale - 1), // この値を含まない
    y1: Math.floor(rect[3] * scale - 1),
  };
}

function checkPixels(pageA: mupdf.PDFPage, pageB: mupdf.PDFPage | null, pageC: mupdf.PDFPage | null, rect: Rect): { ok: boolean; detail: string } {
  if (!pageB || !pageC) return { ok: false, detail: '覆いが見つかりません' };
  const s = regionScale(rect);
  const a = render(pageA, rect, s, false);
  const b = render(pageB, rect, s, true);
  const c = render(pageC, rect, s, false);
  const box = interior(rect, s);
  if (box.x1 <= box.x0 || box.y1 <= box.y0) return { ok: true, detail: '範囲が小さく画素の検査は省略' };
  let notOpaque = 0;
  let differs = 0;
  const min = [255, 255, 255];
  const max = [0, 0, 0];
  for (let y = box.y0; y < box.y1; y++) {
    for (let x = box.x0; x < box.x1; x++) {
      const ia = ((y - a.oy) * a.w + (x - a.ox)) * a.n;
      const ib = ((y - b.oy) * b.w + (x - b.ox)) * b.n;
      const ic = ((y - c.oy) * c.w + (x - c.ox)) * c.n;
      if (b.data[ib + 3] !== 255) notOpaque++;
      else if (Math.abs(a.data[ia] - b.data[ib]) > TOLERANCE || Math.abs(a.data[ia + 1] - b.data[ib + 1]) > TOLERANCE || Math.abs(a.data[ia + 2] - b.data[ib + 2]) > TOLERANCE) differs++;
      for (let k = 0; k < 3; k++) {
        const v = c.data[ic + k];
        if (v < min[k]) min[k] = v;
        if (v > max[k]) max[k] = v;
      }
    }
  }
  const spread = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  const problems: string[] = [];
  if (notOpaque) problems.push(`覆いの外れ ${notOpaque} 画素`);
  if (differs) problems.push(`覆いと違う画素 ${differs}`);
  if (spread > TOLERANCE) problems.push(`覆いの下に内容が残っている（濃淡の幅 ${spread}）`);
  return { ok: problems.length === 0, detail: problems.join('、') || '合格' };
}

function countChars(page: mupdf.PDFPage, rect: Rect): number {
  let n = 0;
  page.toStructuredText('').walk({
    onChar(c, _origin, _font, _size, quad) {
      if (c.trim() === '') return;
      const [x, y] = quadCenter(quad);
      if (pointInRect(x, y, rect)) n++;
    },
  });
  return n;
}

function countAnnots(page: mupdf.PDFPage, rect: Rect): number {
  const arr = page.getObject().get('Annots');
  if (!arr.isArray()) return 0;
  const ctm = page.getTransform() as Mat;
  let n = 0;
  for (let i = 0; i < arr.length; i++) {
    const r = rawAnnotRect(arr.get(i), ctm);
    if (r && rectsIntersect(r, rect)) n++;
  }
  return n;
}

export function checkOutput(bytes: Uint8Array, password: string | undefined, marks: Mark[], token: string): CheckReport {
  const docA = showAllLayers(openBytes(bytes, password));
  const docB = showAllLayers(openBytes(bytes, password));
  const docC = showAllLayers(openBytes(bytes, password));
  const pages = [...new Set(marks.map((m) => m.page))].sort((x, y) => x - y);
  const results: MarkCheck[] = [];
  for (const index of pages) {
    const pageA = docA.loadPage(index);
    const t = coverToken(token, index);
    // B: 覆いだけを描くページ、C: 覆いを空にしたページ
    let pageB: mupdf.PDFPage | null = null;
    let pageC: mupdf.PDFPage | null = null;
    const coverB = findCover(docB.loadPage(index), t);
    if (coverB) {
      docB.loadPage(index).getObject().put('Contents', docB.addStream(`q /${coverB.name} Do Q`, docB.newDictionary()));
      pageB = docB.loadPage(index);
    }
    const coverC = findCover(docC.loadPage(index), t);
    if (coverC) {
      coverC.obj.writeStream('');
      pageC = docC.loadPage(index);
    }
    const pageObj = pageA.getObject();
    const nums = new Set<number>(pageObj.isIndirect() ? [pageObj.asIndirect()] : []);
    const actualText = scrubPage(pageObj, false) + scrubStructTree(docA, nums, false);
    for (const m of marks.filter((x) => x.page === index)) {
      const px = checkPixels(pageA, pageB, pageC, m.rect);
      const chars = countChars(pageA, m.rect);
      const annots = countAnnots(pageA, m.rect);
      results.push({
        markId: m.id,
        page: index,
        pixels: px.ok,
        pixelsDetail: px.detail,
        chars,
        actualText,
        annots,
        ok: px.ok && chars === 0 && actualText === 0 && annots === 0,
      });
    }
  }
  const pixelFailed = new Set(results.filter((r) => !r.pixels).map((r) => r.page));
  const otherFailed = new Set(results.filter((r) => r.chars > 0 || r.actualText > 0 || r.annots > 0).map((r) => r.page));
  return {
    marks: results,
    ok: results.every((r) => r.ok),
    pixelFailedPages: [...pixelFailed].sort((x, y) => x - y),
    otherFailedPages: [...otherFailed].sort((x, y) => x - y),
  };
}
