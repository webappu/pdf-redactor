import { describe, expect, it } from 'vitest';
import { scanContent } from './content-lexer';

const enc = (s: string) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));
const dec = (b: Uint8Array) => String.fromCharCode(...b);

describe('マーク付き内容の ActualText・Alt・E の除去', () => {
  it('インラインの辞書から 3 つのキーを取り除き、ほかは残す', () => {
    const src = '/Span <</ActualText (SECRET KEEP) /Lang (ja) /Alt (x) /E (y)>> BDC BT (SECRET) Tj ET EMC';
    const r = scanContent(enc(src), true);
    expect(r.inlineKeys).toBe(3);
    const out = dec(r.bytes);
    expect(out).not.toContain('ActualText');
    expect(out).not.toContain('/Alt');
    expect(out).not.toMatch(/\/E\b/);
    expect(out).toContain('/Lang (ja)');
    expect(out).toContain('BT (SECRET) Tj ET EMC');
    // もう一度調べると 0
    expect(scanContent(r.bytes, false).inlineKeys).toBe(0);
  });

  it('空白のない書き方・入れ子の括弧・エスケープ・16 進の文字列', () => {
    const src = '/Span<</ActualText(a\\)b(c)d)/MCID 3>>BDC/P<</Alt<FEFF0041>>>BDC EMC EMC';
    const r = scanContent(enc(src), true);
    expect(r.inlineKeys).toBe(2);
    expect(dec(r.bytes)).toBe('/Span<< /MCID 3>>BDC/P<< >>BDC EMC EMC');
  });

  it('#xx で書いた名前も見つける', () => {
    const r = scanContent(enc('/Span <</Actual#54ext (S)>> BDC EMC'), true);
    expect(r.inlineKeys).toBe(1);
    expect(dec(r.bytes)).not.toContain('(S)');
  });

  it('名前で参照する /Properties を集める（BDC と DP）', () => {
    const r = scanContent(enc('/Span /MC0 BDC (x) Tj EMC /Artifact /MC1 DP'), false);
    expect(r.propertyNames).toEqual(['MC0', 'MC1']);
    expect(r.inlineKeys).toBe(0);
  });

  it('文字列やコメントの中の BDC・ActualText には反応しない', () => {
    const src = '(<</ActualText (x)>> BDC) Tj % /Span <</ActualText (y)>> BDC\n[(BDC)] TJ';
    const r = scanContent(enc(src), true);
    expect(r.inlineKeys).toBe(0);
    expect(dec(r.bytes)).toBe(src);
  });

  it('インライン画像のデータを飛ばす（データの中の BDC に反応しない）', () => {
    const data = '<</ActualText (z)>> BDC';
    const src = `BI /W 2 /H 2 /BPC 8 /CS /G ID ${data} EI /Span <</Alt (a)>> BDC EMC`;
    const r = scanContent(enc(src), true);
    expect(r.inlineKeys).toBe(1);
    expect(dec(r.bytes)).toContain(data);
    expect(dec(r.bytes)).not.toContain('(a)');
  });

  it('壊れた入力でも止まらない', () => {
    for (const s of ['<<', '(((', '/Span <</ActualText', ']]>>}{', 'BI /W 1 ID xxx', '<</A <</B (c)>> >> BDC']) {
      expect(() => scanContent(enc(s), true)).not.toThrow();
    }
  });

  // 独立の検証（E9a）: 圧縮しないインライン画像のデータに " EI " と "(" があると区切りを見失い、後の ActualText を見逃していた
  it('インライン画像のデータに " EI " と "(" があっても、後の ActualText を見つける（データの長さを W・H・BPC・色から求める）', () => {
    const src = 'BI /W 3 /H 3 /CS /G /BPC 8 ID xx EI (yy EI\n/Span <</ActualText (SECRET-LEX)>> BDC BT ET EMC';
    const r = scanContent(enc(src), true);
    expect(r.inlineKeys).toBe(1);
    expect(dec(r.bytes)).not.toContain('SECRET-LEX');
    expect(dec(r.bytes)).toContain('ID xx EI (yy EI');
  });

  it('圧縮したインライン画像でも、続きが正しい内容になる EI を終わりとみなす', () => {
    const src = 'BI /W 4 /H 4 /CS /RGB /BPC 8 /F /Fl ID \x01 EI (\x02\x03 EI\n/Span <</ActualText (SECRET-FL)>> BDC EMC';
    const r = scanContent(enc(src), true);
    expect(r.inlineKeys).toBe(1);
    expect(dec(r.bytes)).not.toContain('SECRET-FL');
  });

  // 独立の検証（E9b）: 操作対象が辞書 1 つだけの BDC（MuPDF はこれを ActualText として抽出に使う）
  it('操作対象が辞書 1 つだけの BDC・DP も対象にする', () => {
    const r = scanContent(enc('<</ActualText (SECRET-ONE)>> BDC BT ET EMC <</Alt (SECRET-DP)>> DP'), true);
    expect(r.inlineKeys).toBe(2);
    expect(dec(r.bytes)).not.toContain('SECRET');
  });

  // 独立の検証（E9c）: 辞書と BDC の間に別の値がある（MuPDF は直近の辞書を属性に使う）
  it('辞書と BDC の間に数などがあっても、直近の辞書を属性とみなす', () => {
    const r = scanContent(enc('/Span <</ActualText (SECRET-TWO)>> 4.-2 BDC BT ET EMC'), true);
    expect(r.inlineKeys).toBe(1);
    expect(dec(r.bytes)).not.toContain('SECRET-TWO');
  });

  it('BDC の辞書の中の入れ子の辞書は値として飛ばす', () => {
    const src = '/Span <</Foo <</ActualText (inner)>> /E (outer)>> BDC EMC';
    const r = scanContent(enc(src), true);
    // 外側の /E だけを数える（入れ子の辞書は値）
    expect(r.inlineKeys).toBe(1);
    expect(dec(r.bytes)).toContain('(inner)');
    expect(dec(r.bytes)).not.toContain('(outer)');
  });
});
