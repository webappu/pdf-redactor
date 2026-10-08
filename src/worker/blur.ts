// ぼかしの画像を作る（画素だけの計算。MuPDF には依存しない）。
// 手順: 行の高さ以上のブロックで平均 → 色を量子化 → 暗号乱数のノイズ → 拡大してガウスぼかし。
// ブロックの平均と量子化で元の字形の情報を捨て、ノイズで平均値の推定もしにくくする。
// 最後のぼかしは見た目を整えるためだけのもの（安全性はその前の段で決まる）

export interface BlurInput {
  // RGB（3 チャンネル）。1 画素 = 1pt で描いた範囲
  pixels: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
  // ブロックの一辺（画素）。行の高さ以上
  block: number;
  // 出力の 1pt あたりの画素数
  outScale: number;
  // 乱数（既定は crypto.getRandomValues）
  random?: (n: number) => Uint8Array;
}

export interface BlurOutput {
  pixels: Uint8Array; // RGB
  width: number;
  height: number;
}

// 量子化の段数（各チャンネル）
const LEVELS = 8;
// ノイズの幅（±）
const NOISE = 12;
// 出力の画素数の上限
const MAX_OUT_PIXELS = 4_000_000;

function cryptoRandom(n: number): Uint8Array {
  const out = new Uint8Array(n);
  // getRandomValues は 1 回に 65536 バイトまで
  for (let i = 0; i < n; i += 65536) crypto.getRandomValues(out.subarray(i, Math.min(n, i + 65536)));
  return out;
}

export function blurRegion(input: BlurInput): BlurOutput {
  const { pixels, width, height } = input;
  const block = Math.max(1, Math.round(input.block));
  const random = input.random ?? cryptoRandom;
  const bw = Math.max(1, Math.ceil(width / block));
  const bh = Math.max(1, Math.ceil(height / block));
  // 1. ブロックの平均
  const avg = new Float64Array(bw * bh * 3);
  const cnt = new Uint32Array(bw * bh);
  for (let y = 0; y < height; y++) {
    const by = Math.min(bh - 1, Math.floor(y / block));
    for (let x = 0; x < width; x++) {
      const bx = Math.min(bw - 1, Math.floor(x / block));
      const bi = by * bw + bx;
      const pi = (y * width + x) * 3;
      avg[bi * 3] += pixels[pi];
      avg[bi * 3 + 1] += pixels[pi + 1];
      avg[bi * 3 + 2] += pixels[pi + 2];
      cnt[bi]++;
    }
  }
  // 2. 量子化 3. ノイズ
  const noise = random(bw * bh * 3);
  const blocks = new Uint8Array(bw * bh * 3);
  for (let bi = 0; bi < bw * bh; bi++) {
    const n = cnt[bi] || 1;
    for (let c = 0; c < 3; c++) {
      const mean = avg[bi * 3 + c] / n;
      const q = (Math.round((mean / 255) * (LEVELS - 1)) / (LEVELS - 1)) * 255;
      const r = (noise[bi * 3 + c] % (2 * NOISE + 1)) - NOISE;
      blocks[bi * 3 + c] = Math.max(0, Math.min(255, Math.round(q + r)));
    }
  }
  // 4. 出力の大きさに拡大（ブロックごとに同じ色）
  let scale = input.outScale;
  if (width * height * scale * scale > MAX_OUT_PIXELS) scale = Math.sqrt(MAX_OUT_PIXELS / (width * height));
  const ow = Math.max(1, Math.round(width * scale));
  const oh = Math.max(1, Math.round(height * scale));
  const out = new Float32Array(ow * oh * 3);
  for (let y = 0; y < oh; y++) {
    const by = Math.min(bh - 1, Math.floor(y / scale / block));
    for (let x = 0; x < ow; x++) {
      const bx = Math.min(bw - 1, Math.floor(x / scale / block));
      const bi = (by * bw + bx) * 3;
      const oi = (y * ow + x) * 3;
      out[oi] = blocks[bi];
      out[oi + 1] = blocks[bi + 1];
      out[oi + 2] = blocks[bi + 2];
    }
  }
  // 5. ガウスぼかし（箱型を 3 回で近似）。σ はブロックの 1/3
  const sigma = (block * scale) / 3;
  for (const r of boxRadii(sigma, 3)) {
    boxBlurH(out, ow, oh, r);
    boxBlurV(out, ow, oh, r);
  }
  const res = new Uint8Array(ow * oh * 3);
  for (let i = 0; i < res.length; i++) res[i] = Math.max(0, Math.min(255, Math.round(out[i])));
  return { pixels: res, width: ow, height: oh };
}

// σ のガウスを n 回の箱型で近似するときの半径（W. Jarosz の方法）
function boxRadii(sigma: number, n: number): number[] {
  if (sigma < 0.5) return [];
  const wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let wl = Math.floor(wIdeal);
  if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const mIdeal = (12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4);
  const m = Math.round(mIdeal);
  const radii: number[] = [];
  for (let i = 0; i < n; i++) radii.push(((i < m ? wl : wu) - 1) / 2);
  return radii.filter((r) => r > 0);
}

// 横方向の箱型の平均（端は端の画素を延長）
function boxBlurH(d: Float32Array, w: number, h: number, r: number): void {
  const line = new Float32Array(w * 3);
  const len = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const base = y * w * 3;
    for (let c = 0; c < 3; c++) {
      let acc = 0;
      for (let k = -r; k <= r; k++) acc += d[base + Math.min(w - 1, Math.max(0, k)) * 3 + c];
      for (let x = 0; x < w; x++) {
        line[x * 3 + c] = acc / len;
        const add = Math.min(w - 1, x + r + 1);
        const sub = Math.max(0, x - r);
        acc += d[base + add * 3 + c] - d[base + sub * 3 + c];
      }
    }
    d.set(line, base);
  }
}

function boxBlurV(d: Float32Array, w: number, h: number, r: number): void {
  const col = new Float32Array(h);
  const len = 2 * r + 1;
  for (let x = 0; x < w; x++) {
    for (let c = 0; c < 3; c++) {
      let acc = 0;
      for (let k = -r; k <= r; k++) acc += d[(Math.min(h - 1, Math.max(0, k)) * w + x) * 3 + c];
      for (let y = 0; y < h; y++) {
        col[y] = acc / len;
        const add = Math.min(h - 1, y + r + 1);
        const sub = Math.max(0, y - r);
        acc += d[(add * w + x) * 3 + c] - d[(sub * w + x) * 3 + c];
      }
      for (let y = 0; y < h; y++) d[(y * w + x) * 3 + c] = col[y];
    }
  }
}
