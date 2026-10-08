// PDF の内容ストリームの字句解析（自前）。
// - forEachOp: 演算子ごとに、操作対象（値）とともに呼び出す（内容の解釈の土台。content-walk.ts が使う）
// - scanContent: マーク付き内容（BDC・DP）の属性の辞書から /ActualText・/Alt・/E を取り除く・数える。
//   消す語と残す語を両方包む ActualText が墨消しの後に残る漏洩への対策（設計レビューの実測）
//
// 扱う構文: 空白・コメント・名前（#xx の表記を含む）・数・文字列（入れ子の括弧とエスケープ）・16 進文字列・
// 配列・辞書・演算子・インライン画像（BI … ID <データ> EI）
// インライン画像のデータの終わりは、圧縮していなければ W・H・BPC・色の数から長さを求める。
// 求められないときは、後ろが正しい内容として読める EI を終わりとみなす（データの中の " EI " で区切りを見失わないように）

// 取り除くキー
export const TEXT_KEYS = new Set(['ActualText', 'Alt', 'E']);

// 内容ストリームの演算子（PDF 2.0 の表 A.1）
const OPERATORS = new Set(
  (
    'b B b* B* BDC BI BMC BT BX c cm CS cs d d0 d1 Do DP EI EMC ET EX f F f* G g gs h i ID j J K k l m M MP n q Q re RG rg ri ' +
    's S SC sc SCN scn sh T* Tc Td TD Tf Tj TJ TL Tm Tr Ts Tw Tz v w W W* y \' "'
  ).split(' '),
);

const LF = 10;
const CR = 13;

function isWhite(c: number): boolean {
  return c === 0 || c === 9 || c === 10 || c === 12 || c === 13 || c === 32;
}

function isDelim(c: number): boolean {
  // ( ) < > [ ] { } / %
  return c === 40 || c === 41 || c === 60 || c === 62 || c === 91 || c === 93 || c === 123 || c === 125 || c === 47 || c === 37;
}

export interface Entry {
  key: string;
  start: number; // キーの先頭
  end: number; // 値の末尾（含まない）
  value?: Obj;
}

export interface Obj {
  type: 'name' | 'num' | 'str' | 'hex' | 'array' | 'dict' | 'kw';
  start: number;
  end: number;
  // 名前（#xx を戻したもの）・数・キーワードの文字
  text?: string;
  entries?: Entry[];
  items?: Obj[];
}

export interface ContentScan {
  // 書き換えた内容（strip のときだけ変わる）
  bytes: Uint8Array;
  // インラインの属性の辞書に見つかった（strip のときは取り除いた）キーの数
  inlineKeys: number;
  // BDC・DP が名前で参照した /Properties の名前
  propertyNames: string[];
}

export function numberOf(o: Obj | undefined): number {
  return o && o.type === 'num' ? parseFloat(o.text ?? '') : NaN;
}

class Lexer {
  pos = 0;
  // 閉じていない文字列・辞書・配列に出会った
  bad = false;
  constructor(readonly b: Uint8Array) {}

  skipWhite(): void {
    const b = this.b;
    while (this.pos < b.length) {
      const c = b[this.pos];
      if (isWhite(c)) {
        this.pos++;
      } else if (c === 37) {
        // コメント: 行末まで
        while (this.pos < b.length && b[this.pos] !== LF && b[this.pos] !== CR) this.pos++;
      } else {
        break;
      }
    }
  }

  // 正規の文字の並び（演算子・数・キーワード）
  readRegular(): string {
    const b = this.b;
    const start = this.pos;
    while (this.pos < b.length && !isWhite(b[this.pos]) && !isDelim(b[this.pos])) this.pos++;
    let s = '';
    for (let i = start; i < this.pos; i++) s += String.fromCharCode(b[i]);
    return s;
  }

  readName(): Obj {
    const b = this.b;
    const start = this.pos;
    this.pos++; // '/'
    let s = '';
    while (this.pos < b.length && !isWhite(b[this.pos]) && !isDelim(b[this.pos])) {
      const c = b[this.pos];
      if (c === 35 && this.pos + 2 < b.length) {
        // #xx
        const hex = String.fromCharCode(b[this.pos + 1], b[this.pos + 2]);
        if (/^[0-9a-fA-F]{2}$/.test(hex)) {
          s += String.fromCharCode(parseInt(hex, 16));
          this.pos += 3;
          continue;
        }
      }
      s += String.fromCharCode(c);
      this.pos++;
    }
    return { type: 'name', start, end: this.pos, text: s };
  }

  readLiteralString(): Obj {
    const b = this.b;
    const start = this.pos;
    this.pos++; // '('
    let depth = 1;
    while (this.pos < b.length && depth > 0) {
      const c = b[this.pos];
      if (c === 92) {
        this.pos += 2; // エスケープ: 次の 1 文字を飛ばす（8 進は数字なのでそのまま読み進めてよい）
        continue;
      }
      if (c === 40) depth++;
      else if (c === 41) depth--;
      this.pos++;
    }
    if (depth > 0) this.bad = true;
    if (this.pos > b.length) this.pos = b.length;
    return { type: 'str', start, end: this.pos };
  }

  readHexString(): Obj {
    const b = this.b;
    const start = this.pos;
    this.pos++; // '<'
    while (this.pos < b.length && b[this.pos] !== 62) this.pos++;
    if (this.pos < b.length) this.pos++; // '>'
    else this.bad = true;
    return { type: 'hex', start, end: this.pos };
  }

  readArray(): Obj {
    const b = this.b;
    const start = this.pos;
    const items: Obj[] = [];
    this.pos++; // '['
    for (;;) {
      this.skipWhite();
      if (this.pos >= b.length) {
        this.bad = true;
        break;
      }
      if (b[this.pos] === 93) {
        this.pos++;
        break;
      }
      const before = this.pos;
      const o = this.readObject();
      if (this.pos === before) this.pos++; // 読めない文字は 1 つ飛ばす（壊れた入力で止まらないように）
      else items.push(o);
    }
    return { type: 'array', start, end: this.pos, items };
  }

  readDict(): Obj {
    const b = this.b;
    const start = this.pos;
    this.pos += 2; // '<<'
    const entries: Entry[] = [];
    for (;;) {
      this.skipWhite();
      if (this.pos >= b.length) {
        this.bad = true;
        break;
      }
      if (b[this.pos] === 62 && b[this.pos + 1] === 62) {
        this.pos += 2;
        break;
      }
      const before = this.pos;
      const key = this.readObject();
      if (this.pos === before) {
        this.pos++;
        continue;
      }
      if (key.type !== 'name') continue; // 壊れた辞書: キーでないものは読み捨てる
      this.skipWhite();
      if (this.pos >= b.length) {
        this.bad = true;
        break;
      }
      if (b[this.pos] === 62 && b[this.pos + 1] === 62) {
        // 値のないキー
        entries.push({ key: key.text ?? '', start: key.start, end: key.end });
        this.pos += 2;
        break;
      }
      const vBefore = this.pos;
      const value = this.readObject();
      if (this.pos === vBefore) this.pos++;
      entries.push({ key: key.text ?? '', start: key.start, end: value.end, value });
    }
    return { type: 'dict', start, end: this.pos, entries };
  }

  // 値を 1 つ読む。正規の文字の並びは数かキーワード（演算子を含む）として返す
  readObject(): Obj {
    const b = this.b;
    const c = b[this.pos];
    if (c === 47) return this.readName();
    if (c === 40) return this.readLiteralString();
    if (c === 60) return b[this.pos + 1] === 60 ? this.readDict() : this.readHexString();
    if (c === 91) return this.readArray();
    const start = this.pos;
    const text = this.readRegular();
    if (text === '') return { type: 'kw', start, end: this.pos, text };
    // 数: MuPDF と同じく、途中の符号は読み捨てる（例: 4.-2 は数として読む）
    const type = /^[0-9.+-]+$/.test(text) && /[0-9]/.test(text) ? 'num' : 'kw';
    return { type, start, end: this.pos, text };
  }

  // EI の後ろが正しい内容として読めるか（数個の字句を読み、閉じていない括弧・知らない演算子・8 ビットの文字がないこと）
  validAfter(at: number): boolean {
    const lx = new Lexer(this.b);
    lx.pos = at;
    for (let n = 0; n < 8; n++) {
      lx.skipWhite();
      if (lx.pos >= this.b.length) return true;
      const c = this.b[lx.pos];
      if (c >= 0x80) return false;
      const before = lx.pos;
      const o = lx.readObject();
      if (lx.bad) return false;
      if (lx.pos === before) return false;
      if (o.type === 'kw' && o.text !== 'true' && o.text !== 'false' && o.text !== 'null') {
        if (!OPERATORS.has(o.text ?? '')) return false;
        if (o.text === 'BI') return true;
      }
    }
    return true;
  }

  isEI(i: number): boolean {
    const b = this.b;
    return b[i] === 69 && b[i + 1] === 73 && (i + 2 >= b.length || isWhite(b[i + 2]) || isDelim(b[i + 2]));
  }

  // インライン画像のデータを飛ばす（ID の直後から EI の直後まで）。length は分かっていればデータの長さ
  skipInlineImageData(length: number | null): void {
    const b = this.b;
    // ID の後の空白 1 つ
    if (this.pos < b.length && isWhite(b[this.pos])) this.pos++;
    const start = this.pos;
    if (length !== null && Number.isFinite(length) && length >= 0) {
      let i = start + length;
      while (i < b.length && isWhite(b[i])) i++;
      if (this.isEI(i)) {
        this.pos = i + 2;
        return;
      }
    }
    for (let i = start; i + 1 < b.length; i++) {
      if ((i === start || isWhite(b[i - 1])) && this.isEI(i) && this.validAfter(i + 2)) {
        this.pos = i + 2;
        return;
      }
    }
    this.pos = b.length;
  }
}

function entryValue(entries: Entry[], ...keys: string[]): Obj | undefined {
  for (const e of entries) if (keys.includes(e.key)) return e.value;
  return undefined;
}

// 圧縮していないインライン画像のデータの長さ（求められなければ null）
function inlineDataLength(entries: Entry[]): number | null {
  const l = numberOf(entryValue(entries, 'L', 'Length'));
  if (Number.isFinite(l)) return l;
  if (entryValue(entries, 'F', 'Filter')) return null;
  const w = numberOf(entryValue(entries, 'W', 'Width'));
  const h = numberOf(entryValue(entries, 'H', 'Height'));
  const im = entryValue(entries, 'IM', 'ImageMask');
  const mask = im?.type === 'kw' && im.text === 'true';
  const bpc = mask ? 1 : numberOf(entryValue(entries, 'BPC', 'BitsPerComponent'));
  let comps = NaN;
  if (mask) comps = 1;
  else {
    const cs = entryValue(entries, 'CS', 'ColorSpace');
    const name = cs?.type === 'name' ? cs.text : cs?.type === 'array' && cs.items?.[0]?.type === 'name' ? cs.items[0].text : undefined;
    if (name === 'G' || name === 'DeviceGray' || name === 'I' || name === 'Indexed') comps = 1;
    else if (name === 'RGB' || name === 'DeviceRGB') comps = 3;
    else if (name === 'CMYK' || name === 'DeviceCMYK') comps = 4;
  }
  if (![w, h, bpc, comps].every((v) => Number.isFinite(v) && v >= 0)) return null;
  return h * Math.ceil((w * bpc * comps) / 8);
}

// 演算子ごとに呼ぶ。インライン画像は op 'BI' で、操作対象に辞書（entries）を 1 つ渡す
export function forEachOp(bytes: Uint8Array, cb: (op: string, operands: Obj[], start: number, end: number) => void): void {
  const lx = new Lexer(bytes);
  const b = bytes;
  const operands: Obj[] = [];
  for (;;) {
    lx.skipWhite();
    if (lx.pos >= b.length) break;
    const c = b[lx.pos];
    if (c === 93 || c === 41 || c === 123 || c === 125 || (c === 62 && b[lx.pos + 1] !== 62)) {
      // 対応のない閉じ括弧などは読み捨てる
      lx.pos++;
      continue;
    }
    if (c === 62) {
      lx.pos += 2;
      continue;
    }
    const before = lx.pos;
    const obj = lx.readObject();
    if (lx.pos === before) {
      lx.pos++;
      continue;
    }
    if (obj.type !== 'kw' || obj.text === 'true' || obj.text === 'false' || obj.text === 'null') {
      operands.push(obj);
      continue;
    }
    const op = obj.text ?? '';
    if (op === 'BI') {
      // インライン画像: ID までの辞書を読み、データを飛ばす
      const entries: Entry[] = [];
      const start = obj.start;
      for (;;) {
        lx.skipWhite();
        if (lx.pos >= b.length) break;
        const p = lx.pos;
        const o = lx.readObject();
        if (lx.pos === p) {
          lx.pos++;
          continue;
        }
        if (o.type === 'kw' && o.text === 'ID') {
          lx.skipInlineImageData(inlineDataLength(entries));
          break;
        }
        if (o.type === 'name') {
          lx.skipWhite();
          const vp = lx.pos;
          const v = lx.readObject();
          if (lx.pos === vp) lx.pos++;
          entries.push({ key: o.text ?? '', start: o.start, end: v.end, value: v });
        }
      }
      cb('BI', [{ type: 'dict', start, end: lx.pos, entries }], start, lx.pos);
    } else {
      cb(op, operands.slice(), operands[0]?.start ?? obj.start, obj.end);
    }
    operands.length = 0;
  }
}

// BDC・DP の属性: MuPDF と同じく、直近の辞書（なければ 2 つ目以降の名前）を属性とみなす
export function markedContentProperties(operands: Obj[]): Obj | undefined {
  for (let i = operands.length - 1; i >= 0; i--) if (operands[i].type === 'dict') return operands[i];
  const names = operands.filter((o) => o.type === 'name');
  return names.length >= 2 ? names[names.length - 1] : undefined;
}

export function scanContent(bytes: Uint8Array, strip: boolean): ContentScan {
  const removals: [number, number][] = [];
  const propertyNames: string[] = [];
  let inlineKeys = 0;
  forEachOp(bytes, (op, operands) => {
    if (op !== 'BDC' && op !== 'DP') return;
    const props = markedContentProperties(operands);
    if (props?.type === 'dict') {
      for (const e of props.entries ?? []) {
        if (TEXT_KEYS.has(e.key)) {
          inlineKeys++;
          removals.push([e.start, e.end]);
        }
      }
    } else if (props?.type === 'name') {
      propertyNames.push(props.text ?? '');
    }
  });
  if (!strip || removals.length === 0) return { bytes, inlineKeys, propertyNames };
  // 取り除く範囲を空白 1 つに置き換える
  removals.sort((x, y) => x[0] - y[0]);
  const b = bytes;
  const parts: Uint8Array[] = [];
  let at = 0;
  for (const [s, e] of removals) {
    if (s < at) continue;
    parts.push(b.subarray(at, s), new Uint8Array([32]));
    at = e;
  }
  parts.push(b.subarray(at));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return { bytes: out, inlineKeys, propertyNames };
}
