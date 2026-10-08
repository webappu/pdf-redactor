// 開いた PDF にある /Redact 注釈（本体から引き継いだ墨消しの候補）を範囲として読む。
// 形の取り決め（contract.md）: /Rect・/QuadPoints（利用者空間）、/IC [r g b]（なければ黒）、/PDFEditMode /Blur ならぼかし。
// MuPDF の getRect・getQuadPoints はページ空間（/Rotate・CropBox を反映）で返す。
// 四角形は外接矩形にする（MuPDF 1.28.1 は /QuadPoints の外接矩形で文字を消すため。実測）
import type * as mupdf from 'mupdf';
import { normRect, quadBounds } from '../lib/geom';
import type { Mark, RGB, Rect } from '../lib/types';

function colorOf(obj: mupdf.PDFObject): RGB {
  const ic = obj.get('IC');
  if (!ic.isArray()) return [0, 0, 0];
  const v: number[] = [];
  for (let i = 0; i < ic.length; i++) v.push(Math.max(0, Math.min(1, ic.get(i).asNumber())));
  if (v.length === 1) return [v[0], v[0], v[0]];
  if (v.length === 3) return [v[0], v[1], v[2]];
  if (v.length === 4) {
    // CMYK を簡単に RGB へ
    const k = v[3];
    return [(1 - v[0]) * (1 - k), (1 - v[1]) * (1 - k), (1 - v[2]) * (1 - k)];
  }
  return [0, 0, 0];
}

export function readRedactAnnots(doc: mupdf.PDFDocument, newId: () => string): Mark[] {
  const marks: Mark[] = [];
  const n = doc.countPages();
  for (let i = 0; i < n; i++) {
    const page = doc.loadPage(i);
    for (const a of page.getAnnotations()) {
      if (a.getType() !== 'Redact') continue;
      const obj = a.getObject();
      const mode = obj.get('PDFEditMode').isName() && obj.get('PDFEditMode').asName() === 'Blur' ? 'blur' : 'fill';
      const color = colorOf(obj);
      let rects: Rect[] = [];
      try {
        if (a.hasQuadPoints()) rects = a.getQuadPoints().map((q) => quadBounds(q));
      } catch {
        rects = [];
      }
      if (rects.length === 0) rects = [normRect(a.getRect() as Rect)];
      for (const rect of rects) {
        if (rect[2] - rect[0] <= 0.01 || rect[3] - rect[1] <= 0.01) continue;
        marks.push({ id: newId(), page: i, rect, mode, color, source: 'annot' });
      }
    }
  }
  return marks;
}

// 表示用の文書から /Redact 注釈を消す（画面では範囲として重ねて描くため。保存はしない）
export function removeRedactAnnotsForView(doc: mupdf.PDFDocument): void {
  const n = doc.countPages();
  for (let i = 0; i < n; i++) {
    const page = doc.loadPage(i);
    for (const a of [...page.getAnnotations()]) if (a.getType() === 'Redact') page.deleteAnnotation(a);
  }
}
