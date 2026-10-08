// 引き継ぎの redactor 側の単体テスト（Node の BroadcastChannel で本体役を動かす。時間は実時間）
import { afterEach, describe, expect, it } from 'vitest';
import { HANDOFF_CHANNEL, readHandoffId, receiveHandoff, returnName, returnToEditor } from './handoff';

type Msg = { type: string; id: string; [k: string]: unknown };

const opened: BroadcastChannel[] = [];
afterEach(() => {
  for (const c of opened.splice(0)) c.close();
});

// 本体役: 届いたメッセージを記録し、handler で返事をする
function editor(handler: (m: Msg, ch: BroadcastChannel) => void): Msg[] {
  const ch = new BroadcastChannel(HANDOFF_CHANNEL);
  opened.push(ch);
  const log: Msg[] = [];
  ch.onmessage = (ev: MessageEvent<Msg>) => {
    log.push(ev.data);
    try {
      handler(ev.data, ch);
    } catch {
      // 試験の後始末でチャンネルを閉じた後に届いたもの
    }
  };
  return log;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Outcome {
  kind: 'payload' | 'failed' | 'timeout';
  name?: string;
  text?: string;
  message?: string;
  at: number;
  preparing: boolean;
}

function receive(id: string): Promise<Outcome> {
  const t0 = Date.now();
  let preparing = false;
  return new Promise((resolve) => {
    receiveHandoff(id, {
      onPreparing: () => (preparing = true),
      onPayload: async (name, blob) => resolve({ kind: 'payload', name, text: await blob.text(), at: Date.now() - t0, preparing }),
      onFailed: (message) => resolve({ kind: 'failed', message, at: Date.now() - t0, preparing }),
      onTimeout: () => resolve({ kind: 'timeout', at: Date.now() - t0, preparing }),
    });
  });
}

describe('引き継ぎ（redactor 側）', () => {
  it('preparing の後は 3 秒を超えても payload を受け取れ、ready の再送は止まる', async () => {
    const id = 'id-preparing-1';
    let sent = false;
    const log = editor((m, ch) => {
      if (m.id !== id || m.type !== 'ready' || sent) return;
      sent = true;
      ch.postMessage({ type: 'preparing', id });
      // 3.6 秒かけて PDF を作ってから渡す
      setTimeout(() => ch.postMessage({ type: 'payload', id, name: 'contract.pdf', blob: new Blob(['%PDF-1.7 test']) }), 3600);
    });
    const r = await receive(id);
    expect(r.kind).toBe('payload');
    expect(r.preparing).toBe(true);
    expect(r.name).toBe('contract.pdf');
    expect(r.text).toBe('%PDF-1.7 test');
    expect(r.at).toBeGreaterThan(3500);
    await sleep(50);
    const types = log.map((m) => m.type);
    // ready は preparing の前の 1 回だけ。受け取ったら received
    expect(types.filter((t) => t === 'ready')).toHaveLength(1);
    expect(types[types.length - 1]).toBe('received');
  });

  it('failed が来たら、その知らせで待つのをやめる', async () => {
    const id = 'id-failed-1';
    editor((m, ch) => {
      if (m.id !== id || m.type !== 'ready') return;
      ch.postMessage({ type: 'preparing', id });
      setTimeout(() => ch.postMessage({ type: 'failed', id, message: '取り消されました' }), 100);
    });
    const r = await receive(id);
    expect(r.kind).toBe('failed');
    expect(r.message).toBe('取り消されました');
    expect(r.at).toBeLessThan(2000);
  });

  it('preparing が来なければ、ready を 10 回送って諦める', async () => {
    const id = 'id-nobody-1';
    const log = editor(() => {});
    const r = await receive(id);
    expect(r.kind).toBe('timeout');
    expect(r.preparing).toBe(false);
    expect(log.filter((m) => m.type === 'ready' && m.id === id)).toHaveLength(10);
    // 300ms × 10 回の後
    expect(r.at).toBeGreaterThanOrEqual(2900);
    expect(r.at).toBeLessThan(4500);
  });

  it('止めた後に届いた payload は受け取らず、received も返さない', async () => {
    const id = 'id-stopped-1';
    let stop: () => void = () => {};
    const log = editor((m, ch) => {
      if (m.id !== id || m.type !== 'ready') return;
      ch.postMessage({ type: 'preparing', id });
      setTimeout(() => ch.postMessage({ type: 'payload', id, name: 'late.pdf', blob: new Blob(['late']) }), 400);
    });
    const got: string[] = [];
    await new Promise<void>((resolve) => {
      stop = receiveHandoff(id, {
        onPreparing: () => {
          // 待っている間に利用者が別のファイルを開いた
          stop();
          setTimeout(resolve, 800);
        },
        onPayload: (name) => got.push(`payload ${name}`),
        onFailed: (message) => got.push(`failed ${message}`),
        onTimeout: () => got.push('timeout'),
      });
    });
    expect(got).toEqual([]);
    expect(log.map((m) => m.type)).not.toContain('received');
  });

  it('知らない id のメッセージは無視する', async () => {
    const id = 'id-mine-1';
    editor((m, ch) => {
      if (m.type !== 'ready' || m.id !== id) return;
      ch.postMessage({ type: 'failed', id: 'id-other', message: 'よその失敗' });
      ch.postMessage({ type: 'payload', id: 'id-other', name: 'other.pdf', blob: new Blob(['x']) });
      ch.postMessage({ type: 'payload', id, name: 'mine.pdf', blob: new Blob(['y']) });
    });
    const r = await receive(id);
    expect(r.kind).toBe('payload');
    expect(r.name).toBe('mine.pdf');
  });

  it('戻し: returned が来れば true、来なければ 2 秒で false', async () => {
    const id = 'id-return-1';
    editor((m, ch) => {
      if (m.type === 'return' && m.id === id) ch.postMessage({ type: 'returned', id });
    });
    // Node の BroadcastChannel は、同じ処理の中で Blob を 2 度目に送ると失敗することがある（実測。ブラウザでは起きない）。
    // ここでは取り決めの流れだけを確かめ、Blob の受け渡しは E2E（ブラウザ）で確かめる
    const stand = { size: 1 } as unknown as Blob;
    expect(await returnToEditor(id, 'a_墨消し.pdf', stand)).toBe(true);
    const t0 = Date.now();
    expect(await returnToEditor('id-return-nobody', 'a_墨消し.pdf', stand)).toBe(false);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1900);
  });

  it('URL の id と、戻すときの名前', () => {
    expect(readHandoffId('#handoff=0f8fad5b-d9cb-469f-a165-70867728950e')).toBe('0f8fad5b-d9cb-469f-a165-70867728950e');
    expect(readHandoffId('#handoff=<script>')).toBeNull();
    expect(readHandoffId('')).toBeNull();
    expect(returnName('contract.pdf')).toBe('contract_墨消し.pdf');
    expect(returnName('報告書.PDF')).toBe('報告書_墨消し.pdf');
    expect(returnName('memo')).toBe('memo_墨消し.pdf');
  });
});
