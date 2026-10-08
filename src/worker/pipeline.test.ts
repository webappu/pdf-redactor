// 墨消しの手順（適用・事後検査）を Node の MuPDF で確かめる。試料は apps/redactor/scripts/make-redact-fixtures.mjs と同じもの
import * as mupdf from 'mupdf';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ApplyChoice, Mark, Rect } from '../lib/types';
import { readRedactAnnots } from './annots';
import { checkOutput, openBytes } from './checks';
import { COVER_KEY, redactDocument } from './redact';
import { searchDoc } from './search';

interface Fixture {
  name: string;
  bytes: Uint8Array;
  secrets: string[];
  keeps: string[];
  regions: { page: number; rect: Rect; color?: [number, number, number]; mode?: 'fill' | 'blur' }[];
  markBy: 'annot' | 'draw' | 'search';
  search?: string;
  password?: string;
  secretColor?: [number, number, number];
}

let fixtures: Fixture[] = [];
const builder = new URL('../../scripts/make-redact-fixtures.mjs', import.meta.url).href;

beforeAll(async () => {
  const mod = (await import(/* @vite-ignore */ builder)) as { buildRedactFixtures: () => Fixture[] };
  fixtures = mod.buildRedactFixtures();
});

const get = (name: string) => {
  const f = fixtures.find((x) => x.name === name);
  if (!f) throw new Error(`試料がありません: ${name}`);
  return f;
};

let seq = 0;
const newId = () => `m${++seq}`;

function marksFor(f: Fixture): Mark[] {
  const doc = openBytes(f.bytes, f.password);
  if (f.markBy === 'annot') return readRedactAnnots(doc, newId);
  if (f.markBy === 'search') {
    return searchDoc(doc, f.search ?? '', true).hits.flatMap((h) => h.rects.map((rect) => ({ id: newId(), page: h.page, rect, mode: 'fill' as const, color: [0, 0, 0] as [number, number, number], source: 'search' as const })));
  }
  return f.regions.map((r) => ({ id: newId(), page: r.page, rect: r.rect, mode: r.mode ?? 'fill', color: r.color ?? [0, 0, 0], source: 'draw' as const }));
}

function run(f: Fixture, marks: Mark[], choice: ApplyChoice = { lineArtTouchedPages: [], rasterPages: [] }) {
  const doc = openBytes(f.bytes, f.password);
  const token = `t${Math.random().toString(16).slice(2)}`;
  const out = redactDocument(doc, marks, choice, token);
  const report = checkOutput(out.bytes, f.password, marks, token);
  return { ...out, report };
}

// 出力のすべての文字（構造化テキスト・注釈の本文）と、展開・復号した中身のバイト列
function leakSurface(bytes: Uint8Array, password?: string): { text: string; raw: string } {
  const doc = openBytes(bytes, password);
  let text = '';
  for (let i = 0; i < doc.countPages(); i++) {
    const page = doc.loadPage(i);
    text += page.toStructuredText('').asText() + '\n';
    for (const a of page.getAnnotations()) text += a.getContents() + '\n';
  }
  const raw = Buffer.from(doc.saveToBuffer('decompress,encrypt=none').asUint8Array()).toString('latin1');
  return { text, raw };
}

function encodings(s: string): string[] {
  const ascii = s;
  const utf16 = [...s].map((c) => '\0' + c).join('');
  const hex = Buffer.from(s, 'latin1').toString('hex');
  const hex16 = Buffer.from(utf16, 'latin1').toString('hex');
  return [ascii, utf16, hex, hex.toUpperCase(), hex16, hex16.toUpperCase()];
}

function expectNoLeak(bytes: Uint8Array, f: Fixture) {
  const { text, raw } = leakSurface(bytes, f.password);
  // 調べ方が効いている（展開・復号できている）ことの確認: 残る語は中身のバイト列にも見える（画像化したページを除く）
  if (f.keeps.length && text.includes(f.keeps[0])) expect(raw).toContain(f.keeps[0]);
  for (const s of f.secrets) {
    expect(text, `抽出した文字に ${s}`).not.toContain(s);
    for (const e of encodings(s)) expect(raw.includes(e), `中身に ${s}（${JSON.stringify(e).slice(0, 30)}）`).toBe(false);
  }
  return text;
}

describe('墨消しの適用と事後検査（漏洩の試料）', () => {
  it('(a) ActualText が消す語と残す語を包む', () => {
    const f = get('redactor-a-actualtext.pdf');
    const marks = marksFor(f);
    expect(marks).toHaveLength(2);
    expect(marks[1].color[0]).toBeCloseTo(0.8, 5);
    expect(marks[1].color.slice(1)).toEqual([0, 0]);
    const r = run(f, marks);
    expect(r.report.marks.map((m) => [m.pixels, m.chars, m.actualText, m.annots])).toEqual([
      [true, 0, 0, 0],
      [true, 0, 0, 0],
    ]);
    expect(r.report.ok).toBe(true);
    expect(r.removedActualText).toBeGreaterThanOrEqual(5);
    const text = expectNoLeak(r.bytes, f);
    for (const k of f.keeps) expect(text).toContain(k);
  });

  it('(b) 範囲内の付箋・FreeText・リンク・見えない文字', () => {
    const f = get('redactor-b-note.pdf');
    const r = run(f, marksFor(f));
    expect(r.report.ok).toBe(true);
    expect(r.removedAnnots).toBeGreaterThanOrEqual(3);
    const text = expectNoLeak(r.bytes, { ...f, secrets: [...f.secrets, 'SECRET-B-NOTE', 'SECRET-B-FREE', 'SECRET-B-LINK', 'SECRET-B-HIDDEN'] });
    for (const k of f.keeps) expect(text).toContain(k);
  });

  it('(c) 範囲を横切る線: ①で見つかり、線も削除・画像化のどちらでも合格する', () => {
    const f = get('redactor-c-line.pdf');
    const marks = marksFor(f);
    const first = run(f, marks);
    expect(first.report.marks[0].pixels).toBe(false);
    expect(first.report.pixelFailedPages).toEqual([0]);
    const touched = run(f, marks, { lineArtTouchedPages: [0], rasterPages: [] });
    expect(touched.report.ok).toBe(true);
    const text = expectNoLeak(touched.bytes, f);
    for (const k of f.keeps) expect(text).toContain(k);
    const raster = run(f, marks, { lineArtTouchedPages: [], rasterPages: [0] });
    expect(raster.report.ok).toBe(true);
    expectNoLeak(raster.bytes, f);
  });

  it('(d) Form XObject 内の文字（入れ子・/Alt・/E）', () => {
    const f = get('redactor-d-form.pdf');
    const marks = marksFor(f);
    expect(marks).toHaveLength(2);
    const r = run(f, marks);
    expect(r.report.ok).toBe(true);
    const text = expectNoLeak(r.bytes, { ...f, secrets: [...f.secrets, 'SECRET-D-ALT', 'SECRET-D-E'] });
    for (const k of f.keeps) expect(text).toContain(k);
  });

  it('(e) /Rotate 90 のページ', () => {
    const f = get('redactor-e-rotate.pdf');
    const marks = marksFor(f);
    expect(marks).toHaveLength(1);
    const r = run(f, marks);
    expect(r.report.ok).toBe(true);
    const text = expectNoLeak(r.bytes, f);
    for (const k of f.keeps) expect(text).toContain(k);
  });

  it('(f) 画像の一部（ぼかし）: 覆いを外しても元の画素が残らない', () => {
    const f = get('redactor-f-image.pdf');
    const marks = marksFor(f);
    expect(marks.map((m) => m.mode)).toEqual(['blur']);
    const r = run(f, marks);
    expect(r.report.ok).toBe(true);
    const text = expectNoLeak(r.bytes, f);
    for (const k of f.keeps) expect(text).toContain(k);
    // 覆いを空にして描き、範囲に赤（元の秘密の部分）が無いこと
    const doc = openBytes(r.bytes);
    const page = doc.loadPage(0);
    page.getObject().getInheritable('Resources').get('XObject').forEach((v) => {
      if (v.get(COVER_KEY).isString()) v.writeStream('');
    });
    const pix = doc.loadPage(0).toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, false);
    const px = pix.getPixels();
    const w = pix.getWidth();
    const rect = marks[0].rect;
    let red = 0;
    for (let y = Math.ceil(rect[1]); y < Math.floor(rect[3]); y++) {
      for (let x = Math.ceil(rect[0]); x < Math.floor(rect[2]); x++) {
        const i = (y * w + x) * 3;
        if (px[i] > 150 && px[i + 1] < 100 && px[i + 2] < 100) red++;
      }
    }
    expect(red).toBe(0);
  });

  it('ぼかしは、回転したページ・画像化したページ・線も削除したページでも検査に合格する', () => {
    const e = get('redactor-e-rotate.pdf');
    const re = run(e, marksFor(e).map((m) => ({ ...m, mode: 'blur' as const })));
    expect(re.report.ok).toBe(true);
    expectNoLeak(re.bytes, e);
    const c = get('redactor-c-line.pdf');
    const blurC = marksFor(c).map((m) => ({ ...m, mode: 'blur' as const }));
    expect(run(c, blurC, { lineArtTouchedPages: [], rasterPages: [0] }).report.ok).toBe(true);
    expect(run(c, blurC, { lineArtTouchedPages: [0], rasterPages: [] }).report.ok).toBe(true);
  });

  it('事後検査は、墨消ししていない PDF では①〜④の失敗を見つける', () => {
    const a = get('redactor-a-actualtext.pdf');
    const ra = checkOutput(a.bytes, undefined, marksFor(a), 'none');
    expect(ra.ok).toBe(false);
    expect(ra.marks[0].pixels).toBe(false);
    expect(ra.marks[0].pixelsDetail).toBe('覆いが見つかりません');
    expect(ra.marks[0].chars).toBeGreaterThan(0);
    expect(ra.marks[0].actualText).toBeGreaterThanOrEqual(5);
    const b = get('redactor-b-note.pdf');
    const rb = checkOutput(b.bytes, undefined, marksFor(b), 'none');
    expect(rb.marks[0].annots).toBeGreaterThanOrEqual(3);
    // 覆いはあるが、その下に線が残る（(c) の 1 回目）: 覆いの外れ・違いはなく、下の内容だけが見つかる
    const c = get('redactor-c-line.pdf');
    const first = run(c, marksFor(c));
    expect(first.report.marks[0].pixelsDetail).toMatch(/^覆いの下に内容が残っている/);
  });

  it('(g) パスワード付き: 出力もパスワードのまま、検査に合格する', () => {
    const f = get('redactor-g-encrypted.pdf');
    const marks = marksFor(f);
    const r = run(f, marks);
    expect(r.report.ok).toBe(true);
    expect(mupdf.Document.openDocument(r.bytes, 'application/pdf').needsPassword()).toBe(true);
    expectNoLeak(r.bytes, f);
  });
});
