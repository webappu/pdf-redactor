// 画面とワーカーで共有する型。座標はすべて MuPDF の「ページ空間」
// （/Rotate と CropBox を反映した、左上が原点・下向きが +y・単位 pt の空間）で表す

import type { Msg } from './msg';

export type Rect = [number, number, number, number]; // x0, y0, x1, y1
export type Quad = [number, number, number, number, number, number, number, number];
export type RGB = [number, number, number]; // 各 0〜1

export type MarkMode = 'fill' | 'blur';

// 墨消しの範囲 1 つ。MuPDF 1.28.1 は /QuadPoints の四角形を外接矩形として扱うため（実測）、範囲は軸に平行な矩形で持つ
export interface Mark {
  id: string;
  page: number;
  rect: Rect;
  mode: MarkMode;
  color: RGB;
  // どこから来たか（描いた・検索・既存の /Redact 注釈）
  source: 'draw' | 'search' | 'annot';
}

export interface PageSize {
  width: number;
  height: number;
}

export interface DocInfo {
  pageCount: number;
  pages: PageSize[];
}

// 事後検査の結果（範囲ごと）
export interface MarkCheck {
  markId: string;
  page: number;
  // ① 画素: 覆いだけが見え、覆いの下に元の内容が残っていない
  pixels: boolean;
  // ①の説明（鍵は日本語の文言。画面の側で t() を通して今の言語の文にする）
  pixelsDetail: Msg[];
  // ② 範囲内の文字（空白を除く）の数
  chars: number;
  // ③ そのページに残る ActualText・Alt・E の数（内容ストリーム・Form XObject・構造ツリー）
  actualText: number;
  // ④ 範囲と交差する注釈の数
  annots: number;
  ok: boolean;
}

export interface CheckReport {
  marks: MarkCheck[];
  ok: boolean;
  // ①に失敗したページ（線も削除・画像化の選択の対象）
  pixelFailedPages: number[];
  // ①以外（②〜④）に失敗したページ
  otherFailedPages: number[];
}

// 適用のしかた（ページごとの再適用の選択）
export interface ApplyChoice {
  // 線も削除（REDACT_LINE_ART_REMOVE_IF_TOUCHED）するページ
  lineArtTouchedPages: number[];
  // 画像化するページ
  rasterPages: number[];
}

// 適用の設定
export interface ApplyOptions {
  // 文書の情報（Info・XMP）・しおり・添付ファイル・JavaScript・ページラベルも消す（推奨。既定で入れる）
  stripDocument: boolean;
}

export interface ApplyResult {
  bytes: Uint8Array;
  report: CheckReport;
  // 適用で削除した注釈の数（付箋など）
  removedAnnots: number;
  // 取り除いた ActualText・Alt・E の数
  removedActualText: number;
  // 消した文書の項目（名前は日本語の文言。画面の側で t() を通して今の言語にする）
  removedDocItems: string[];
  // 出力が暗号化されているか（元のパスワードのまま）
  encrypted: boolean;
}

export interface SearchHit {
  page: number;
  rects: Rect[];
}
