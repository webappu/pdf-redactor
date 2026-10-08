// 画面 ↔ ワーカーのやり取りの型
import type { ApplyChoice, ApplyOptions, ApplyResult, DocInfo, Mark } from './types';
import type { SearchHit } from './types';

export type Request =
  | { op: 'open'; file: Blob }
  | { op: 'auth'; password: string }
  | { op: 'load' }
  | { op: 'render'; page: number; scale: number }
  | { op: 'search'; needle: string; ignoreCase: boolean }
  | { op: 'apply'; marks: Mark[]; choice: ApplyChoice; options: ApplyOptions }
  | { op: 'view'; target: 'source' | 'result' }
  | { op: 'close' };

export interface OpenResult {
  needsPassword: boolean;
}

export interface LoadResult {
  info: DocInfo;
  // 開いた PDF にあった /Redact 注釈（墨消しの候補）
  marks: Mark[];
}

export interface RenderResult {
  bitmap: ImageBitmap;
  width: number;
  height: number;
}

export interface SearchResponse {
  hits: SearchHit[];
  truncatedPages: number[];
}

export type { ApplyResult };

export type Envelope = { id: number; req: Request };

export type Reply = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };
