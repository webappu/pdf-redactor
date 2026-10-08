// 編集アプリ（本体）との引き継ぎの redactor 側（BroadcastChannel。ディスクには書かない）。
// 取り決めは contract.md の「本体との引き継ぎの取り決め」:
//   行き: URL の #handoff=<id> を読み、ready を 300ms ごとに最大 10 回送る
//         → preparing が来たら ready の再送を止め、payload を長めに（10 分）待つ
//         → payload を受けたら received を返す。failed が来たら、その知らせを出して待つのをやめる
//   戻し: return を送り、2 秒以内に returned が来なければ本体が閉じているとみなす
// 自分が知らない id のメッセージは無視する
export const HANDOFF_CHANNEL = 'pdf-editor-handoff-v1';
export const READY_INTERVAL = 300;
export const READY_TRIES = 10;
// preparing の後に payload を待つ時間（本体は画像処理を含めて PDF を作る）
export const PAYLOAD_TIMEOUT = 10 * 60 * 1000;
export const RETURN_TIMEOUT = 2000;

type Message =
  | { type: 'ready'; id: string }
  | { type: 'preparing'; id: string }
  | { type: 'payload'; id: string; name: string; blob: Blob }
  | { type: 'failed'; id: string; message: string }
  | { type: 'received'; id: string }
  | { type: 'return'; id: string; name: string; blob: Blob }
  | { type: 'returned'; id: string };

// URL の #handoff=<id> を読む（id は推測できない乱数。形だけ確かめる）
export function readHandoffId(hash: string): string | null {
  const m = /^#handoff=([A-Za-z0-9-]{8,128})$/.exec(hash);
  return m ? m[1] : null;
}

// 戻すときの名前: <元の名前>_墨消し.pdf（元の名前の末尾の .pdf は除く）
export function returnName(name: string): string {
  const base = name.replace(/\.pdf$/i, '') || '文書';
  return `${base}_墨消し.pdf`;
}

export interface ReceiveCallbacks {
  onPayload: (name: string, blob: Blob) => void;
  // 本体が PDF を作り始めた
  onPreparing?: () => void;
  // 本体が PDF を作れなかった（取り消しを含む）
  onFailed: (message: string) => void;
  // 本体から応答がない（閉じている・別のタブ）、または payload が来ないまま待ちきった
  onTimeout: () => void;
}

export interface ReceiveTiming {
  readyInterval?: number;
  readyTries?: number;
  payloadTimeout?: number;
}

// 本体から PDF を受け取る。止めるための関数を返す
export function receiveHandoff(id: string, cb: ReceiveCallbacks, timing: ReceiveTiming = {}): () => void {
  const readyInterval = timing.readyInterval ?? READY_INTERVAL;
  const readyTries = timing.readyTries ?? READY_TRIES;
  const payloadTimeout = timing.payloadTimeout ?? PAYLOAD_TIMEOUT;
  const channel = new BroadcastChannel(HANDOFF_CHANNEL);
  let tries = 0;
  let finished = false;
  let readyTimer: ReturnType<typeof setInterval> | null = null;
  let payloadTimer: ReturnType<typeof setTimeout> | null = null;

  const finish = () => {
    finished = true;
    if (readyTimer !== null) clearInterval(readyTimer);
    if (payloadTimer !== null) clearTimeout(payloadTimer);
    readyTimer = null;
    payloadTimer = null;
    channel.close();
  };

  const sendReady = () => {
    if (finished) return;
    if (tries >= readyTries) {
      finish();
      cb.onTimeout();
      return;
    }
    tries++;
    channel.postMessage({ type: 'ready', id } satisfies Message);
  };

  channel.onmessage = (ev: MessageEvent<Message>) => {
    const m = ev.data;
    if (finished || !m || typeof m !== 'object' || m.id !== id) return;
    if (m.type === 'preparing') {
      // ready の再送を止め、payload を長めに待つ
      if (readyTimer !== null) clearInterval(readyTimer);
      readyTimer = null;
      if (payloadTimer === null) {
        payloadTimer = setTimeout(() => {
          if (finished) return;
          finish();
          cb.onTimeout();
        }, payloadTimeout);
        cb.onPreparing?.();
      }
    } else if (m.type === 'payload') {
      if (!(m.blob instanceof Blob) || typeof m.name !== 'string') return;
      channel.postMessage({ type: 'received', id } satisfies Message);
      finish();
      cb.onPayload(m.name, m.blob);
    } else if (m.type === 'failed') {
      finish();
      cb.onFailed(typeof m.message === 'string' && m.message ? m.message : '編集アプリが PDF を作れませんでした');
    }
  };
  readyTimer = setInterval(sendReady, readyInterval);
  sendReady();
  return () => {
    if (!finished) finish();
  };
}

// 本体へ戻す。returned が来れば true、来なければ false（本体が閉じている）
export function returnToEditor(id: string, name: string, blob: Blob, timeout = RETURN_TIMEOUT): Promise<boolean> {
  return new Promise((resolve) => {
    const channel = new BroadcastChannel(HANDOFF_CHANNEL);
    const timer = setTimeout(() => {
      channel.close();
      resolve(false);
    }, timeout);
    channel.onmessage = (ev: MessageEvent<Message>) => {
      const m = ev.data;
      if (!m || typeof m !== 'object' || m.id !== id || m.type !== 'returned') return;
      clearTimeout(timer);
      channel.close();
      resolve(true);
    };
    channel.postMessage({ type: 'return', id, name, blob } satisfies Message);
  });
}
