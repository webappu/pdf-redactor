// 画面の言語（日本語・英語）と、文言の翻訳。
// 文言は日本語をそのまま鍵にする（t('PDF を開く')）。英語のときは辞書（en.ts）から引き、なければ日本語のまま出す。
// 初めの言語: 本人が切り替えて保存した言語 → なければアクセス元の国（Cloudflare の /cdn-cgi/trace の loc。日本なら日本語、
// それ以外は英語）。国が分かるまでは、端末の時間帯（Asia/Tokyo なら日本語）で仮に決めて、待たずに表示する。
// 取れないとき（開発サーバー・GitHub Pages など Cloudflare でない配信）は時間帯のまま。
// 自動で決めた言語は保存しない（本人が切り替えたときだけ覚える）。
// 本体（編集アプリ）とはコードを共有しない（AGPL の分離）。同じ考え方の小さな仕組みを、ここに自前で持つ
import { en } from './en';
import type { Msg, Vars } from './lib/msg';

export { tk } from './lib/msg';

export type Lang = 'ja' | 'en';

// 本体と同じ鍵（Cloudflare では本体と同じオリジンの /redact/ に置くので、言語がそろう）
const KEY = 'pdfapp-lang';
const TRACE_TIMEOUT_MS = 1500;

export const lang = $state<{ current: Lang }>({ current: 'ja' });

function saved(): Lang | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'ja' || v === 'en' ? v : null;
  } catch {
    return null;
  }
}

function byTimezone(): Lang {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone === 'Asia/Tokyo' ? 'ja' : 'en';
  } catch {
    return 'ja';
  }
}

function apply(): void {
  document.documentElement.lang = lang.current;
  document.title = t('精密墨消し');
}

// 画面を作る前に呼ぶ（main.ts）
export function initLang(): void {
  const s = saved();
  lang.current = s ?? byTimezone();
  apply();
  if (!s) void detectByCountry();
}

// アクセス元の国で決め直す（1.5 秒まで待つ）。取れないときは時間帯で決めたまま
async function detectByCountry(): Promise<void> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TRACE_TIMEOUT_MS);
    // 置き場所（/redact/ や /pdf-redactor/）によらず、オリジンの直下を見る
    const res = await fetch('/cdn-cgi/trace', { cache: 'no-store', signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return;
    const loc = /^loc=([A-Z]{2})$/m.exec(await res.text())?.[1];
    // 待っている間に本人が切り替えていたら、そちらを優先する
    if (!loc || saved()) return;
    const next: Lang = loc === 'JP' ? 'ja' : 'en';
    if (next !== lang.current) {
      lang.current = next;
      apply();
    }
  } catch {
    // 国が分からなくても使える（時間帯で決めたまま）
  }
}

// 本人が切り替えた（保存する）
export function setLang(next: Lang): void {
  lang.current = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    // 保存できなくても、今の画面は切り替える
  }
  apply();
}

// 文言を今の言語にする。vars は {名前} を置き換える（英語の辞書の値が関数なら、それに渡す。複数形など）
export function t(ja: string, vars?: Vars): string {
  const entry = lang.current === 'en' ? en[ja] : undefined;
  const text = typeof entry === 'function' ? entry(vars ?? {}) : (entry ?? ja);
  return vars ? text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : text;
}

// ワーカーから届いた文（鍵と値）を、今の言語の文にする
export function tm(m: Msg): string {
  return t(m.key, m.vars);
}
