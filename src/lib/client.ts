// 画面側からワーカーを呼ぶ（要求ごとに id をつけ、返事を待つ）
import { t } from '../i18n.svelte';
import type { ApplyResult, LoadResult, OpenResult, RenderResult, Reply, Request, SearchResponse } from './protocol';
import type { ApplyChoice, ApplyOptions, DocInfo, Mark } from './types';

export class PdfWorker {
  private worker: Worker;
  private seq = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  constructor() {
    this.worker = new Worker(new URL('../worker/mupdf.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (ev: MessageEvent<Reply>) => {
      const r = ev.data;
      const p = this.pending.get(r.id);
      if (!p) return;
      this.pending.delete(r.id);
      if (r.ok) p.resolve(r.result);
      else p.reject(new Error(r.error));
    };
    this.worker.onerror = (ev) => {
      const err = new Error(t('ワーカーで失敗しました: {m}', { m: ev.message || t('不明') }));
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    };
  }

  private call<T>(req: Request, transfer: Transferable[] = []): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.worker.postMessage({ id, req }, transfer);
    });
  }

  open(file: Blob): Promise<OpenResult> {
    return this.call({ op: 'open', file });
  }

  auth(password: string): Promise<{ ok: boolean }> {
    return this.call({ op: 'auth', password });
  }

  load(): Promise<LoadResult> {
    return this.call({ op: 'load' });
  }

  render(page: number, scale: number): Promise<RenderResult> {
    return this.call({ op: 'render', page, scale });
  }

  search(needle: string, ignoreCase: boolean): Promise<SearchResponse> {
    return this.call({ op: 'search', needle, ignoreCase });
  }

  // marks は複製できる素のオブジェクトで渡す（Svelte の $state のプロキシは送れない）
  apply(marks: Mark[], choice: ApplyChoice, options: ApplyOptions): Promise<ApplyResult> {
    return this.call({ op: 'apply', marks, choice, options });
  }

  view(target: 'source' | 'result'): Promise<DocInfo> {
    return this.call({ op: 'view', target });
  }

  close(): Promise<null> {
    return this.call({ op: 'close' });
  }
}
