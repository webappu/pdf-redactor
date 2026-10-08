// 文書全体に付く写し（範囲とは関係なく内容の一部を持ちうるもの）を消す（独立の検証 E7。既定で行い、画面で外せる）。
// 対象: 文書の情報（Info）・XMP メタデータ・しおり・添付ファイル（名前の木・注釈・関連づけ）・JavaScript（名前の木・
// 開いたときの動作・追加の動作・注釈の動作）・ページラベル・作成アプリの私的なデータ（/PieceInfo）
import type * as mupdf from 'mupdf';

type PDFObject = mupdf.PDFObject;

function nameOf(o: PDFObject): string {
  return o.isName() ? o.asName() : '';
}

function isJavaScriptAction(a: PDFObject): boolean {
  return a.isDictionary() && nameOf(a.get('S')) === 'JavaScript';
}

// 消した項目の名前を返す（あったものだけ。順は固定）
export function stripDocumentItems(doc: mupdf.PDFDocument): string[] {
  const removed: string[] = [];
  const trailer = doc.getTrailer();
  const root = trailer.get('Root');

  if (!trailer.get('Info').isNull()) {
    trailer.delete('Info');
    removed.push('文書の情報（Info）');
  }
  if (!root.get('Metadata').isNull()) {
    root.delete('Metadata');
    removed.push('XMP メタデータ');
  }
  if (!root.get('Outlines').isNull()) {
    root.delete('Outlines');
    if (nameOf(root.get('PageMode')) === 'UseOutlines') root.delete('PageMode');
    removed.push('しおり');
  }

  // 添付ファイル
  let attachments = false;
  const names = root.get('Names');
  if (names.isDictionary() && !names.get('EmbeddedFiles').isNull()) {
    names.delete('EmbeddedFiles');
    attachments = true;
  }
  if (!root.get('AF').isNull()) {
    root.delete('AF');
    attachments = true;
  }
  // JavaScript
  let scripts = false;
  if (names.isDictionary() && !names.get('JavaScript').isNull()) {
    names.delete('JavaScript');
    scripts = true;
  }
  const open = root.get('OpenAction');
  if (isJavaScriptAction(open)) {
    root.delete('OpenAction');
    scripts = true;
  }
  if (!root.get('AA').isNull()) {
    root.delete('AA');
    scripts = true;
  }
  // ページごと: 追加の動作、添付ファイルの注釈、注釈の JavaScript の動作、ページの関連づけ
  const n = doc.countPages();
  for (let i = 0; i < n; i++) {
    const page = doc.loadPage(i);
    const pageObj = page.getObject();
    if (!pageObj.get('AA').isNull()) {
      pageObj.delete('AA');
      scripts = true;
    }
    if (!pageObj.get('AF').isNull()) {
      pageObj.delete('AF');
      attachments = true;
    }
    for (const a of [...page.getAnnotations()]) {
      if (a.getType() === 'FileAttachment') {
        page.deleteAnnotation(a);
        attachments = true;
      }
    }
    const arr = pageObj.get('Annots');
    if (!arr.isArray()) continue;
    for (let k = arr.length - 1; k >= 0; k--) {
      const a = arr.get(k);
      if (nameOf(a.get('Subtype')) === 'FileAttachment') {
        arr.delete(k);
        attachments = true;
        continue;
      }
      if (isJavaScriptAction(a.get('A'))) {
        a.delete('A');
        scripts = true;
      }
      if (!a.get('AA').isNull()) {
        a.delete('AA');
        scripts = true;
      }
    }
  }
  if (attachments) removed.push('添付ファイル');
  if (scripts) removed.push('JavaScript');

  if (!root.get('PageLabels').isNull()) {
    root.delete('PageLabels');
    removed.push('ページラベル');
  }
  if (!root.get('PieceInfo').isNull()) {
    root.delete('PieceInfo');
    removed.push('作成アプリの私的なデータ');
  }
  return removed;
}
