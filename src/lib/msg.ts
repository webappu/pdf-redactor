// 訳す文言の目印と、ワーカーから画面へ渡す文。
// ワーカーでは訳さない。日本語の文言を鍵（コード）にして、埋め込む値と分けて渡し、画面の側で t() を通して今の言語の文にする。
// こうすると、ワーカーは言語を知らずに済み、結果を出した後で言語を切り替えても表示が切り替わる。
// ワーカーでも読み込むので、画面の仕組み（i18n.svelte.ts。Svelte のルーンを使う）には頼らない
export type Vars = Record<string, string | number>;

export interface Msg {
  key: string;
  vars?: Vars;
}

// 訳す文言の目印（その場では訳さず、表示するときに t() で訳す）。辞書の漏れの見張り（i18n.test.ts）は鍵として数える
export const tk = (ja: string): string => ja;

// ワーカーから画面へ渡す文（鍵は日本語の文言、vars は {名前} に埋め込む値）
export const msg = (key: string, vars?: Vars): Msg => (vars ? { key, vars } : { key });
