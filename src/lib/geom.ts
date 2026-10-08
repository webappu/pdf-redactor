// 矩形・四角形・行列の小さな計算（画面とワーカーの両方で使う）
import type { Quad, Rect } from './types';

export type Mat = [number, number, number, number, number, number];

export function normRect(r: Rect): Rect {
  return [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];
}

export function quadBounds(q: Quad | number[]): Rect {
  const xs = [q[0], q[2], q[4], q[6]];
  const ys = [q[1], q[3], q[5], q[7]];
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

export function rectWidth(r: Rect): number {
  return r[2] - r[0];
}

export function rectHeight(r: Rect): number {
  return r[3] - r[1];
}

// 面積のある重なりがあるか（辺が接するだけは重ならない）
export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
}

export function pointInRect(x: number, y: number, r: Rect): boolean {
  return x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3];
}

export function quadCenter(q: Quad | number[]): [number, number] {
  return [(q[0] + q[2] + q[4] + q[6]) / 4, (q[1] + q[3] + q[5] + q[7]) / 4];
}

export function transformPoint(m: Mat, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

export function invertMatrix(m: Mat): Mat {
  const det = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(det) < 1e-12) throw new Error('逆行列がありません');
  const a = m[3] / det;
  const b = -m[1] / det;
  const c = -m[2] / det;
  const d = m[0] / det;
  return [a, b, c, d, -(m[4] * a + m[5] * c), -(m[4] * b + m[5] * d)];
}

// one を適用してから two を適用する行列
export function concatMatrix(one: Mat, two: Mat): Mat {
  return [
    one[0] * two[0] + one[1] * two[2],
    one[0] * two[1] + one[1] * two[3],
    one[2] * two[0] + one[3] * two[2],
    one[2] * two[1] + one[3] * two[3],
    one[4] * two[0] + one[5] * two[2] + two[4],
    one[4] * two[1] + one[5] * two[3] + two[5],
  ];
}

// 矩形の四隅を行列で写す（左上・右上・右下・左下の順）
export function rectCorners(r: Rect, m: Mat): [number, number][] {
  return [
    transformPoint(m, r[0], r[1]),
    transformPoint(m, r[2], r[1]),
    transformPoint(m, r[2], r[3]),
    transformPoint(m, r[0], r[3]),
  ];
}

// 数値を内容ストリームに書く形にする（指数表記を使わない）
export function num(v: number): string {
  if (!Number.isFinite(v)) throw new Error(`数値が不正です: ${v}`);
  const s = (Math.round(v * 10000) / 10000).toFixed(4);
  return s.replace(/\.?0+$/, '') || '0';
}
