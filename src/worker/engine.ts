// ワーカーの中身: 文書を開く・描く・探す・墨消しを適用する。
// ファイルは new mupdf.Stream で必要な部分だけ読む（FileReaderSync で Blob の一部を同期的に読む）
import * as mupdf from 'mupdf';
import type { ApplyResult, LoadResult, OpenResult, RenderResult, Request, SearchResponse } from '../lib/protocol';
import type { ApplyChoice, ApplyOptions, DocInfo, Mark } from '../lib/types';
import { readRedactAnnots, removeRedactAnnotsForView } from './annots';
import { checkOutput, openBytes } from './checks';
import { redactDocument } from './redact';
import { searchDoc } from './search';

// FileReaderSync は専用ワーカーにだけある（tsconfig の DOM の型には無い）
declare const FileReaderSync: { new (): { readAsArrayBuffer(blob: Blob): ArrayBuffer } };

// 読み込みの塊（これ単位で読み、直近のいくつかを覚えておく）
const BLOCK = 256 * 1024;
const CACHE_BLOCKS = 16;

function blobStream(blob: Blob): mupdf.Stream {
  const reader = new FileReaderSync();
  const cache = new Map<number, Uint8Array>();
  const block = (index: number): Uint8Array => {
    let b = cache.get(index);
    if (b) {
      cache.delete(index);
      cache.set(index, b);
      return b;
    }
    const start = index * BLOCK;
    b = new Uint8Array(reader.readAsArrayBuffer(blob.slice(start, Math.min(blob.size, start + BLOCK))));
    cache.set(index, b);
    if (cache.size > CACHE_BLOCKS) cache.delete(cache.keys().next().value as number);
    return b;
  };
  return new mupdf.Stream({
    fileSize: () => blob.size,
    read(memory: Uint8Array, offset: number, length: number, position: number): number {
      if (position >= blob.size || length <= 0) return 0;
      const index = Math.floor(position / BLOCK);
      const b = block(index);
      const from = position - index * BLOCK;
      const n = Math.min(length, b.length - from);
      memory.set(b.subarray(from, from + n), offset);
      return n;
    },
    close() {
      cache.clear();
    },
  });
}

function openBlob(blob: Blob): mupdf.Document {
  return mupdf.Document.openDocument(blobStream(blob), 'application/pdf');
}

interface State {
  file: Blob;
  password?: string;
  source: mupdf.PDFDocument | null; // 表示用（/Redact 注釈は消してある）
  pending: mupdf.Document | null; // パスワード待ち
  result: mupdf.PDFDocument | null;
  view: 'source' | 'result';
}

let state: State | null = null;

function newId(): string {
  return crypto.randomUUID();
}

function docInfo(doc: mupdf.Document): DocInfo {
  const n = doc.countPages();
  const pages = [];
  for (let i = 0; i < n; i++) {
    const [x0, y0, x1, y1] = doc.loadPage(i).getBounds();
    pages.push({ width: x1 - x0, height: y1 - y0 });
  }
  return { pageCount: n, pages };
}

function viewDoc(): mupdf.Document {
  if (!state) throw new Error('文書が開かれていません');
  const d = state.view === 'result' ? state.result : state.source;
  if (!d) throw new Error('文書が開かれていません');
  return d;
}

function finishOpen(doc: mupdf.Document): void {
  if (!state) return;
  const pdf = doc.asPDF();
  if (!pdf) throw new Error('PDF ではありません');
  state.source = pdf;
  state.pending = null;
}

async function toBitmap(pix: mupdf.Pixmap): Promise<RenderResult> {
  const w = pix.getWidth();
  const h = pix.getHeight();
  const rgb = pix.getPixels();
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) {
    rgba[j] = rgb[i];
    rgba[j + 1] = rgb[i + 1];
    rgba[j + 2] = rgb[i + 2];
    rgba[j + 3] = 255;
  }
  const bitmap = await createImageBitmap(new ImageData(rgba, w, h));
  return { bitmap, width: w, height: h };
}

export async function handle(req: Request): Promise<{ result: unknown; transfer?: Transferable[] }> {
  switch (req.op) {
    case 'open': {
      state = { file: req.file, source: null, pending: null, result: null, view: 'source' };
      const doc = openBlob(req.file);
      if (doc.needsPassword()) {
        state.pending = doc;
        return { result: { needsPassword: true } satisfies OpenResult };
      }
      finishOpen(doc);
      return { result: { needsPassword: false } satisfies OpenResult };
    }
    case 'auth': {
      if (!state?.pending) throw new Error('パスワードの入力は不要です');
      if (state.pending.authenticatePassword(req.password) === 0) return { result: { ok: false } };
      state.password = req.password;
      finishOpen(state.pending);
      return { result: { ok: true } };
    }
    case 'load': {
      if (!state?.source) throw new Error('文書が開かれていません');
      const marks = readRedactAnnots(state.source, newId);
      removeRedactAnnotsForView(state.source);
      return { result: { info: docInfo(state.source), marks } satisfies LoadResult };
    }
    case 'render': {
      const page = viewDoc().loadPage(req.page);
      const pix = page.toPixmap(mupdf.Matrix.scale(req.scale, req.scale), mupdf.ColorSpace.DeviceRGB, false, true);
      const r = await toBitmap(pix);
      return { result: r, transfer: [r.bitmap] };
    }
    case 'search': {
      if (!state?.source) throw new Error('文書が開かれていません');
      const r = searchDoc(state.source, req.needle, req.ignoreCase);
      return { result: r satisfies SearchResponse };
    }
    case 'apply': {
      if (!state) throw new Error('文書が開かれていません');
      return { ...(await apply(req.marks, req.choice, req.options)) };
    }
    case 'view': {
      if (!state) throw new Error('文書が開かれていません');
      if (req.target === 'result' && !state.result) throw new Error('適用した結果がありません');
      state.view = req.target;
      return { result: docInfo(viewDoc()) };
    }
    case 'close': {
      state = null;
      return { result: null };
    }
  }
}

async function apply(marks: Mark[], choice: ApplyChoice, options: ApplyOptions): Promise<{ result: ApplyResult; transfer: Transferable[] }> {
  if (!state) throw new Error('文書が開かれていません');
  // 元の文書を開き直した写しに適用する（表示中の文書は変えない）
  const fresh = openBlob(state.file);
  if (fresh.needsPassword() && fresh.authenticatePassword(state.password ?? '') === 0) throw new Error('パスワードで開けません');
  const pdf = fresh.asPDF();
  if (!pdf) throw new Error('PDF ではありません');
  const token = newId();
  const out = redactDocument(pdf, marks, choice, token, options);
  const report = checkOutput(out.bytes, state.password, marks, token);
  state.result = openBytes(out.bytes, state.password);
  const encrypted = mupdf.Document.openDocument(out.bytes, 'application/pdf').needsPassword();
  const bytes = out.bytes.slice();
  const result: ApplyResult = { bytes, report, removedAnnots: out.removedAnnots, removedActualText: out.removedActualText, removedDocItems: out.removedDocItems, encrypted };
  return { result, transfer: [bytes.buffer] };
}
