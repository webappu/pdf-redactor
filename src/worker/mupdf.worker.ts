// MuPDF を動かす専用ワーカーの入口。
// 受け付けを先に用意し、MuPDF（wasm の読み込みでトップレベル await を使う）は後から読み込む
import type { Envelope, Reply } from '../lib/protocol';

const engine = import('./engine');
// 処理は 1 つずつ（MuPDF の文書を同時に触らない）
let chain: Promise<void> = Promise.resolve();

self.onmessage = (ev: MessageEvent<Envelope>) => {
  const { id, req } = ev.data;
  chain = chain.then(async () => {
    try {
      const { handle } = await engine;
      const { result, transfer } = await handle(req);
      self.postMessage({ id, ok: true, result } satisfies Reply, { transfer: transfer ?? [] });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      self.postMessage({ id, ok: false, error } satisfies Reply);
    }
  });
};
