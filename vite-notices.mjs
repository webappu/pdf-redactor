// （scripts/vite-notices.mjs の写し。公開リポジトリへ切り出したときにこのフォルダだけで完結するよう、apps/redactor に置く）
// 本番ビルドに入った第三者のコードのライセンス表記を、成果物の licenses.txt にまとめる（Vite のプラグイン）。
// - 実際にバンドルに入ったモジュールから node_modules のパッケージを集める（本体とワーカーの両方）
// - public/ から配る実行時データ（OCR のモデル・フォントなど）は extras で足す
// 使い方: const n = noticesPlugin({...}); plugins: [n.main], worker: { plugins: () => [n.worker] }
import fs from 'node:fs';
import path from 'node:path';

const LICENSE_FILE = /^(licen[cs]e|copying|notice|third[-_]?party)/i;

// パッケージの直下と、1 段下のフォルダにあるライセンスの文書（pdf.js の wasm/LICENSE_*、mozjpeg の codec/LICENSE.codec.md など）
function licenseFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isFile() && LICENSE_FILE.test(e.name)) out.push(path.join(dir, e.name));
    else if (e.isDirectory() && e.name !== 'node_modules') {
      for (const f of fs.readdirSync(path.join(dir, e.name), { withFileTypes: true })) {
        if (f.isFile() && LICENSE_FILE.test(f.name)) out.push(path.join(dir, e.name, f.name));
      }
    }
  }
  return out.sort();
}

// モジュールの id から、属するパッケージの名前とフォルダを求める（入れ子の node_modules は最も内側）
function packageOf(id) {
  const p = id.replace(/^\0/, '').split('?')[0].replace(/\\/g, '/');
  const re = /\/node_modules\/((?:@[^/]+\/)?[^/]+)\//g;
  let m;
  let last = null;
  while ((m = re.exec(p))) last = { name: m[1], dir: p.slice(0, m.index + m[0].length - 1) };
  return last;
}

const RULE = '='.repeat(78);

/**
 * @param {{
 *   title: string,
 *   // 本文の代わりに使う文（ライセンスの文書を同梱していないパッケージ）
 *   fallback?: Record<string, string>,
 *   // 本文の一部だけを使う（Vite の LICENSE.md は Vite 自身の部分だけ。同梱の依存はバンドルに入らない）
 *   trim?: Record<string, (text: string) => string>,
 *   // 使うライセンスの文書を限る（パッケージのフォルダからの相対パス。rolldown の THIRD-PARTY-LICENSE はビルドの道具自身の依存で、バンドルに入らない）
 *   files?: Record<string, string[]>,
 *   // バンドルの外で配るもの
 *   extras?: { name: string, license: string, note?: string, text?: string, file?: string }[],
 *   // id に node_modules を含まないが、ビルドで差し込まれる補助コードの出どころ
 *   always?: string[],
 *   nodeModules: string,
 * }} opts
 */
export function noticesPlugin(opts) {
  const pkgs = new Map();
  const add = (name, dir) => {
    if (!pkgs.has(name)) pkgs.set(name, dir);
  };
  const collect = (bundle) => {
    for (const chunk of Object.values(bundle)) {
      if (chunk.type !== 'chunk') continue;
      for (const id of chunk.moduleIds ?? Object.keys(chunk.modules ?? {})) {
        const p = packageOf(id);
        if (p) add(p.name, p.dir);
      }
    }
  };
  const worker = {
    name: 'notices-collect-worker',
    apply: 'build',
    generateBundle(_o, bundle) {
      collect(bundle);
    },
  };
  const main = {
    name: 'notices',
    apply: 'build',
    // ワーカーのバンドルは本体の変換の途中で作られるので、本体の generateBundle の時点で揃っている
    generateBundle(_o, bundle) {
      collect(bundle);
      for (const name of opts.always ?? []) add(name, path.join(opts.nodeModules, name));
      const parts = [opts.title, ''];
      // 文書が見つからないパッケージは、まとめて知らせる
      const missing = [];
      for (const name of [...pkgs.keys()].sort()) {
        const dir = pkgs.get(name);
        const pj = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
        const license = typeof pj.license === 'string' ? pj.license : (pj.license?.type ?? '不明');
        parts.push(RULE, `${name} ${pj.version}（${license}）`, RULE, '');
        const files = opts.files?.[name] ? opts.files[name].map((f) => path.join(dir, f)) : licenseFiles(dir);
        if (files.length === 0) {
          const text = opts.fallback?.[name];
          if (text) parts.push(text.trim(), '');
          else missing.push(`${name} ${pj.version}（${license}）`);
          continue;
        }
        for (const f of files) {
          let text = fs.readFileSync(f, 'utf8');
          if (opts.trim?.[name]) text = opts.trim[name](text);
          if (files.length > 1) parts.push(`--- ${path.relative(dir, f).replace(/\\/g, '/')} ---`);
          parts.push(text.trim(), '');
        }
      }
      if (missing.length > 0) this.error(`ライセンスの文書が見つかりません（fallback に本文を足してください）: ${missing.join('、')}`);
      for (const e of opts.extras ?? []) {
        parts.push(RULE, `${e.name}（${e.license}）`, RULE, '');
        if (e.note) parts.push(e.note.trim(), '');
        if (e.file) {
          if (!fs.existsSync(e.file)) this.error(`ライセンスの文書がありません: ${e.file}（npm run assets で配置してください）`);
          parts.push(fs.readFileSync(e.file, 'utf8').trim(), '');
        }
        if (e.text) parts.push(e.text.trim(), '');
      }
      this.emitFile({ type: 'asset', fileName: 'licenses.txt', source: parts.join('\n') });
    },
  };
  return { main, worker };
}
