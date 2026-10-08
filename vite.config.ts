import { defineConfig, type Plugin } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { createRequire } from 'node:module';
import path from 'node:path';
import { noticesPlugin } from './vite-notices.mjs';

// 第三者のライセンス表記（成果物の licenses.txt）。ビルドに入ったパッケージ（svelte・mupdf など）から作る。
// node_modules の場所は vite の置き場所から求める（ワークスペースでも、切り出した単独のリポジトリでも動くように）
const nodeModules = path.dirname(path.dirname(createRequire(import.meta.url).resolve('vite/package.json')));
const notices = noticesPlugin({
  title:
    '精密墨消し — 第三者のソフトウェアのライセンス表記\n\nこのアプリ自体のライセンスは LICENSE.txt（AGPL-3.0-or-later）です。このアプリには、次のソフトウェアが含まれています。',
  nodeModules,
  // ビルドで差し込まれる補助コード（モジュールの読み込みなど）の出どころ
  always: ['vite', 'rolldown'],
  files: { vite: ['LICENSE.md'], rolldown: ['LICENSE'] },
  trim: { vite: (t: string) => t.split('# Licenses of bundled dependencies')[0] },
});

// 精密墨消しアプリ（AGPL-3.0）。本番では本体と同じオリジンの /redact/ に置く。
// セキュリティヘッダは本体と同じ方針（外部接続の禁止とクロスオリジン分離）
function csp(dev: boolean): string {
  return [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "worker-src 'self' blob:",
    `connect-src 'self' blob: data:${dev ? ' ws://localhost:7310 ws://localhost:7311' : ''}`,
    "img-src 'self' blob: data:",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' blob: data:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

function headers(dev: boolean): Record<string, string> {
  return {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Content-Security-Policy': csp(dev),
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  };
}

// ビルドした HTML にも同じ CSP を meta で埋め込む。ヘッダーを付けられない配信先（GitHub Pages）でも、外部への通信を禁止するため。
// meta では frame-ancestors が効かないので外す（ヘッダーを付けられる配信先では、ヘッダーの CSP と両方が効く）
const cspMeta: Plugin = {
  name: 'csp-meta',
  apply: 'build',
  transformIndexHtml: () => [
    {
      tag: 'meta',
      attrs: { 'http-equiv': 'Content-Security-Policy', content: csp(false).replace(/; frame-ancestors [^;]*/, '') },
      injectTo: 'head-prepend',
    },
  ],
};

export default defineConfig({
  // 置き場所。既定は本体と同じオリジンの /redact/。単独で GitHub Pages に置くときは REDACTOR_BASE（例: /pdf-redactor/）で変える
  base: process.env.REDACTOR_BASE ?? '/redact/',
  plugins: [svelte(), notices.main, cspMeta],
  server: {
    // 固定ポート（PG/PORTS.md に登録済み）。本体の開発サーバー（7310）が /redact/ をここへ中継する
    port: 7311,
    strictPort: true,
    headers: headers(true),
  },
  build: {
    // mupdf.js はトップレベル await を使う
    target: 'es2023',
  },
  worker: {
    format: 'es',
    plugins: () => [notices.worker],
  },
  optimizeDeps: {
    exclude: ['mupdf'],
  },
});
