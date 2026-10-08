// 文字列の検索（page.search）。一致した箇所の四角形を外接矩形にして返す
import type * as mupdf from 'mupdf';
import { quadBounds } from '../lib/geom';
import type { Rect, SearchHit } from '../lib/types';

// MuPDF.js の page.search は 1 ページあたり 500 個の四角形までしか返さない
export const MAX_QUADS_PER_PAGE = 500;

export interface SearchResult {
  hits: SearchHit[];
  // 上限に達したページ（取りこぼしの可能性）
  truncatedPages: number[];
}

export function searchDoc(doc: mupdf.Document, needle: string, ignoreCase: boolean): SearchResult {
  const hits: SearchHit[] = [];
  const truncatedPages: number[] = [];
  if (!needle.trim()) return { hits, truncatedPages };
  const n = doc.countPages();
  for (let i = 0; i < n; i++) {
    const page = doc.loadPage(i);
    const found = page.search(needle, ignoreCase ? 'ignore-case' : '');
    let quads = 0;
    for (const hit of found) {
      const rects: Rect[] = hit.map((q) => quadBounds(q));
      quads += hit.length;
      hits.push({ page: i, rects });
    }
    if (quads >= MAX_QUADS_PER_PAGE) truncatedPages.push(i);
  }
  return { hits, truncatedPages };
}
