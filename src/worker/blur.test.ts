import { describe, expect, it } from 'vitest';
import { blurRegion } from './blur';

// 決まった乱数（試験用）
const fixedRandom = (n: number) => new Uint8Array(n).fill(12); // ノイズ 0（12 % 25 - 12 = 0）

function makeText(width: number, height: number, seed: number): Uint8Array {
  // 白地に黒い細かい模様（字形の代わり）
  const px = new Uint8Array(width * height * 3).fill(255);
  let s = seed;
  for (let i = 0; i < width * height; i++) {
    s = (s * 1103515245 + 12345) >>> 0;
    if (s % 3 === 0) px.fill(0, i * 3, i * 3 + 3);
  }
  return px;
}

// ブロックの中で画素を並べ替える（ブロックの平均は同じ）
function shuffleInBlocks(px: Uint8Array, width: number, height: number, block: number): Uint8Array {
  const out = new Uint8Array(px.length);
  for (let by = 0; by < height; by += block) {
    for (let bx = 0; bx < width; bx += block) {
      const idx: number[] = [];
      for (let y = by; y < Math.min(height, by + block); y++) for (let x = bx; x < Math.min(width, bx + block); x++) idx.push(y * width + x);
      const rev = [...idx].reverse();
      idx.forEach((p, k) => out.set(px.subarray(rev[k] * 3, rev[k] * 3 + 3), p * 3));
    }
  }
  return out;
}

describe('ぼかしの画像', () => {
  it('ブロックの平均が同じなら、中の字形が違っても同じ画像になる（字形の情報が残らない）', () => {
    const w = 60;
    const h = 24;
    const a = makeText(w, h, 1);
    const b = shuffleInBlocks(a, w, h, 12);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
    const oa = blurRegion({ pixels: a, width: w, height: h, block: 12, outScale: 2, random: fixedRandom });
    const ob = blurRegion({ pixels: b, width: w, height: h, block: 12, outScale: 2, random: fixedRandom });
    expect(oa.width).toBe(120);
    expect(oa.height).toBe(48);
    expect(Buffer.from(oa.pixels).equals(Buffer.from(ob.pixels))).toBe(true);
  });

  it('暗号乱数のノイズが入る（同じ入力でも毎回違う）', () => {
    const w = 40;
    const h = 20;
    const a = makeText(w, h, 7);
    const o1 = blurRegion({ pixels: a, width: w, height: h, block: 10, outScale: 1 });
    const o2 = blurRegion({ pixels: a, width: w, height: h, block: 10, outScale: 1 });
    expect(Buffer.from(o1.pixels).equals(Buffer.from(o2.pixels))).toBe(false);
  });

  it('出力は滑らか（隣り合う画素の差が小さい）', () => {
    const w = 80;
    const h = 30;
    const o = blurRegion({ pixels: makeText(w, h, 3), width: w, height: h, block: 15, outScale: 2, random: fixedRandom });
    let maxDiff = 0;
    for (let y = 0; y < o.height; y++) {
      for (let x = 1; x < o.width; x++) {
        const i = (y * o.width + x) * 3;
        maxDiff = Math.max(maxDiff, Math.abs(o.pixels[i] - o.pixels[i - 3]));
      }
    }
    expect(maxDiff).toBeLessThan(16);
  });

  it('大きな範囲は出力の画素数を抑える', () => {
    const w = 2000;
    const h = 1500;
    const o = blurRegion({ pixels: new Uint8Array(w * h * 3).fill(200), width: w, height: h, block: 20, outScale: 2, random: fixedRandom });
    expect(o.width * o.height).toBeLessThanOrEqual(4_000_000 * 1.01);
  });
});
