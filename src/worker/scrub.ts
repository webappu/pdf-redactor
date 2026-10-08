// 墨消ししたページから /ActualText・/Alt・/E を取り除く・数える（PDF の構造をたどる部分）。
// 対象: ページの内容ストリーム、そこから使われる Form XObject とタイルの模様（入れ子も）、
// 名前で参照されるマーク付き内容の属性（/Properties）、構造ツリーの要素（そのページに掛かるもの）
import type * as mupdf from 'mupdf';
import { scanContent, TEXT_KEYS } from './content-lexer';

type PDFObject = mupdf.PDFObject;

function objNum(o: PDFObject): number | null {
  return o.isIndirect() ? o.asIndirect() : null;
}

function nameOf(o: PDFObject): string {
  return o.isName() ? o.asName() : '';
}

// ページの内容ストリーム（配列なら各要素）
export function contentStreams(pageObj: PDFObject): PDFObject[] {
  const c = pageObj.get('Contents');
  if (c.isArray()) {
    const out: PDFObject[] = [];
    for (let i = 0; i < c.length; i++) {
      const s = c.get(i);
      if (s.isStream()) out.push(s);
    }
    return out;
  }
  return c.isStream() ? [c] : [];
}

// 構造ツリーの要素では、題名（/T）も範囲の内容を写しうるので消す（独立の検証 E7）
const STRUCT_KEYS = new Set([...TEXT_KEYS, 'T']);

function countAndDeleteKeys(dict: PDFObject, strip: boolean, keys: Set<string> = TEXT_KEYS): number {
  let n = 0;
  for (const k of keys) {
    if (!dict.get(k).isNull()) {
      n++;
      if (strip) dict.delete(k);
    }
  }
  return n;
}

function scrubStream(stream: PDFObject, res: PDFObject | null, strip: boolean): number {
  const bytes = stream.readStream().asUint8Array().slice();
  const r = scanContent(bytes, strip);
  if (strip && r.inlineKeys > 0) stream.writeStream(r.bytes);
  let n = r.inlineKeys;
  if (r.propertyNames.length && res && res.isDictionary()) {
    const props = res.get('Properties');
    if (props.isDictionary()) {
      for (const name of new Set(r.propertyNames)) {
        const p = props.get(name);
        if (p.isDictionary()) n += countAndDeleteKeys(p, strip);
      }
    }
  }
  return n;
}

// 資源から使われうる Form XObject とタイルの模様を（入れ子も）たどる
function scrubResources(res: PDFObject | null, strip: boolean, visited: Set<number>, depth: number): number {
  if (!res || !res.isDictionary() || depth > 32) return 0;
  let n = 0;
  for (const kind of ['XObject', 'Pattern']) {
    const d = res.get(kind);
    if (!d.isDictionary()) continue;
    const items: PDFObject[] = [];
    d.forEach((v) => items.push(v));
    for (const v of items) {
      if (!v.isStream()) continue;
      const num = objNum(v);
      if (num !== null) {
        if (visited.has(num)) continue;
        visited.add(num);
      }
      if (kind === 'XObject' && nameOf(v.get('Subtype')) !== 'Form') continue;
      const own = v.get('Resources');
      const childRes = own.isDictionary() ? own : res;
      n += scrubStream(v, childRes, strip);
      n += scrubResources(childRes, strip, visited, depth + 1);
    }
  }
  return n;
}

// ページ（内容と、そこから使われるもの）の ActualText・Alt・E を数える。strip なら取り除く
export function scrubPage(pageObj: PDFObject, strip: boolean): number {
  const resRaw = pageObj.getInheritable('Resources');
  const res = resRaw.isDictionary() ? resRaw : null;
  let n = 0;
  for (const s of contentStreams(pageObj)) n += scrubStream(s, res, strip);
  n += scrubResources(res, strip, new Set(), 0);
  return n;
}

// 構造ツリーの要素のうち、指定したページ（オブジェクト番号）に掛かるものの ActualText・Alt・E を数える・取り除く。
// 子孫のどれかがそのページにあれば、その要素（祖先を含む）を対象にする（祖先の ActualText も子孫の文字を含みうるため）
export function scrubStructTree(doc: mupdf.PDFDocument, pageNums: Set<number>, strip: boolean): number {
  const root = doc.getTrailer().get('Root').get('StructTreeRoot');
  if (!root.isDictionary() || pageNums.size === 0) return 0;
  let count = 0;
  const memo = new Map<number, boolean>();

  const onPage = (pg: number | null) => pg !== null && pageNums.has(pg);

  function visitKids(k: PDFObject, pg: number | null, depth: number): boolean {
    if (depth > 256) return false;
    if (k.isArray()) {
      let t = false;
      for (let i = 0; i < k.length; i++) t = visitKids(k.get(i), pg, depth + 1) || t;
      return t;
    }
    if (k.isNumber()) return onPage(pg);
    if (k.isDictionary()) {
      const type = nameOf(k.get('Type'));
      if (type === 'MCR' || type === 'OBJR') {
        const p = k.get('Pg');
        return onPage(p.isNull() ? pg : objNum(p));
      }
      return visitElem(k, pg, depth + 1);
    }
    return false;
  }

  function visitElem(elem: PDFObject, pg: number | null, depth: number): boolean {
    const num = objNum(elem);
    if (num !== null) {
      const m = memo.get(num);
      if (m !== undefined) return m;
      memo.set(num, false); // 循環の防止
    }
    const own = elem.get('Pg');
    const epg = own.isNull() ? pg : objNum(own);
    let touches = onPage(epg);
    touches = visitKids(elem.get('K'), epg, depth) || touches;
    if (touches) count += countAndDeleteKeys(elem, strip, STRUCT_KEYS);
    if (num !== null) memo.set(num, touches);
    return touches;
  }

  visitKids(root.get('K'), null, 0);
  return count;
}
