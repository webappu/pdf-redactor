// 英語の辞書の漏れの見張り（本体の i18n/coverage.test.ts と同じ考え方。コードは共有しない）。
// 1. ソースの t('…')・tk('…')・msg('…') の鍵（日本語）が、すべて英語の辞書にある
// 2. t() を通さない日本語の文字列が残っていない（コメント・試験・console の文は除く）。ワーカーの文も対象にする
//    （ワーカーは訳さず、鍵に目印 tk()・msg() を付けて画面へ渡す）
// 3. 辞書の英語に、かな・漢字が残っていない。英語の {名前} は、日本語の鍵にあるものだけ
// 4. 辞書の鍵が、すべてソースで使われている（使わなくなった訳を残さない）
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { en } from './en';

const SRC = import.meta.dirname;
// かな・カタカナ（「・」を含む）・漢字
const JA = /[぀-ヿ㐀-鿿]/;

// 2 の対象から外すファイル（辞書そのもの・試験）
const SKIP_FILE = (f: string) => /\.test\.ts$|\.d\.ts$/.test(f) || f === 'en.ts';
// わざと訳さない文字列
// - 言語のボタンは、切り替え先の言語で書く
// - 開発者向けの誤り（利用者には出ない。画面を作れないとき・内容ストリームに書く数が壊れているとき）
const ALLOW = new Set(['日本語', '#app が見つかりません', '数値が不正です: ${v}']);

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(svelte|ts)$/.test(e.name)) out.push(p);
  }
  return out;
}

// コメントを除く（文字列の中の // は残す）
function stripComments(src: string): string {
  return src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => {
      let q: string | null = null;
      for (let i = 0; i < l.length; i++) {
        const c = l[i];
        if (q) {
          if (c === '\\') i++;
          else if (c === q) q = null;
        } else if (c === "'" || c === '"' || c === '`') q = c;
        else if (c === '/' && l[i + 1] === '/') return l.slice(0, i);
      }
      return l;
    })
    .join('\n');
}

const sources = walk(SRC)
  .map((f) => path.relative(SRC, f).replaceAll('\\', '/'))
  .filter((f) => !SKIP_FILE(f))
  .map((file) => ({ file, src: stripComments(fs.readFileSync(path.join(SRC, file), 'utf8')) }));

// t('…')・tk('…')・msg('…') の鍵
function keysOf(src: string): string[] {
  return [...src.matchAll(/\b(?:tk?|msg)\(\s*(['"])((?:\\.|(?!\1).)*)\1/g)].map((m) => m[2].replace(/\\(.)/g, '$1'));
}

// どの名前を引いても 2 を返す（辞書の関数を試しに呼ぶ）
const anyVars = new Proxy({}, { get: () => 2 }) as Record<string, number>;

describe('英語の辞書', () => {
  it("ソースの t('…')・tk('…')・msg('…') の鍵が、すべて辞書にある", () => {
    const missing: string[] = [];
    for (const { file, src } of sources) {
      for (const key of keysOf(src)) if (JA.test(key) && !(key in en)) missing.push(`${file}: ${key}`);
    }
    expect(missing, `辞書にない鍵:\n${missing.join('\n')}`).toEqual([]);
  });

  it('t() を通さない日本語の文字列が残っていない', () => {
    const left: string[] = [];
    for (const { file, src } of sources) {
      for (const m of src.matchAll(/(['"`])((?:\\.|(?!\1)[^\n])*)\1|>([^<>{}]+)</g)) {
        const text = (m[2] ?? m[3] ?? '').trim();
        if (!text || !JA.test(text) || ALLOW.has(text)) continue;
        // t( などの直後の文字列は鍵（1 で確かめる）
        const before = src.slice(Math.max(0, m.index - 40), m.index);
        if (/\b(?:tk?|msg)\(\s*$/.test(before)) continue;
        const line = src.slice(src.lastIndexOf('\n', m.index) + 1, src.indexOf('\n', m.index));
        if (/console\.(log|error|warn|debug)\(/.test(line)) continue;
        left.push(`${file}: ${text}`);
      }
    }
    expect(left, `訳していない日本語:\n${left.join('\n')}`).toEqual([]);
  });

  it('辞書の英語に、かな・漢字が残っておらず、{名前} は日本語の鍵にあるものだけ', () => {
    const bad: string[] = [];
    for (const [ja, entry] of Object.entries(en)) {
      const text = typeof entry === 'function' ? entry(anyVars) : entry;
      if (JA.test(text)) bad.push(`${ja} → ${text}`);
      if (typeof entry === 'string') {
        for (const m of entry.matchAll(/\{(\w+)\}/g)) if (!ja.includes(m[0])) bad.push(`${ja} → ${entry}（${m[0]} が鍵にない）`);
      }
    }
    expect(bad, `直す訳:\n${bad.join('\n')}`).toEqual([]);
  });

  it('辞書の鍵が、すべてソースで使われている', () => {
    const used = new Set(sources.flatMap(({ src }) => keysOf(src)));
    const unused = Object.keys(en).filter((k) => !used.has(k));
    expect(unused, `使われていない訳:\n${unused.join('\n')}`).toEqual([]);
  });
});
