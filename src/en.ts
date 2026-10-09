// 英語の辞書（日本語の文言 → 英語）。値は文字列か、埋め込みの値を受け取る関数（英語の複数形など）。{名前} は t() が置き換える。
// 用語: 精密墨消し → Precision Redaction／墨消し → Redact（名詞は Redaction）／塗りつぶす → Fill／ぼかす → Blur／
// 事後検査 → Verification／範囲 → Area／編集アプリ（本体）→ PDF Editor／画像化 → Convert to image
// 英語の書き方: 短く自然な UI の英語。ボタン・項目は文頭だけ大文字。区切りの「・」は「 · 」か「, 」にする（かなを残さない）
import type { Vars } from './lib/msg';

export type Entry = string | ((v: Vars) => string);

// 1 なら単数、それ以外は複数
const pl = (n: number | string | undefined, one: string, many: string) => (Number(n) === 1 ? one : many);

export const en: Record<string, Entry> = {
  // ---- 区切り ----
  '・': ', ',
  '、': ', ',

  // ---- 上の帯 ----
  精密墨消し: 'Precision Redaction',
  'PDF を開く': 'Open PDF',
  '拡大・縮小': 'Zoom',
  縮小: 'Zoom out',
  拡大: 'Zoom in',
  幅に合わせる: 'Fit width',
  道具: 'Tools',
  矩形を描く: 'Draw rectangle',
  選ぶ: 'Select',
  新しい範囲の方式: 'Method for new areas',
  塗りつぶし: 'Fill',
  ぼかし: 'Blur',
  塗りの色: 'Fill color',
  '墨消しを適用（{n}）': 'Apply redaction ({n})',
  指定に戻る: 'Back to editing',
  保存: 'Save',
  編集アプリに戻す: 'Send back to PDF Editor',

  // ---- 状態の帯 ----
  '開いています…': 'Opening…',
  '墨消しの候補を {n} 件読み込みました': (v) => `Loaded ${v.n} redaction ${pl(v.n, 'candidate', 'candidates')}`,
  '墨消しを適用しています…': 'Applying redaction…',
  '適用しました。事後検査はすべて合格です': 'Applied. All areas passed verification',
  '適用しましたが、事後検査に合格しない範囲があります': 'Applied, but some areas failed verification',
  '編集アプリから受け取っています…': 'Receiving from PDF Editor…',
  '編集アプリが PDF を作っています…': 'PDF Editor is preparing the PDF…',
  '編集アプリから PDF を受け取れませんでした: {message}': 'Could not receive the PDF from PDF Editor: {message}',
  '編集アプリから PDF を受け取れませんでした。編集アプリの画面からもう一度開くか、ファイルを開いてください':
    'Could not receive the PDF from PDF Editor. Open it again from PDF Editor, or open a file.',
  '編集アプリが PDF を作れませんでした': 'PDF Editor could not create the PDF',
  引き継ぎをやめる: 'Cancel transfer',
  'ワーカーで失敗しました: {m}': 'Worker failed: {m}',
  不明: 'unknown',

  // ---- 検索 ----
  文字列で探してマーク: 'Find and mark text',
  消したい文字列: 'Text to redact',
  探す: 'Find',
  大文字と小文字を区別しない: 'Ignore case',
  見つかりませんでした: 'No matches found',
  '{hits} か所が見つかり、{added} 件の範囲を追加しました（{pages} ページ）': (v) =>
    `Found ${v.hits} ${pl(v.hits, 'match', 'matches')} and added ${v.added} ${pl(v.added, 'area', 'areas')} (${v.pages} ${pl(v.pages, 'page', 'pages')})`,
  '。{list} ページは件数が多く、すべては拾えていない可能性があります': (v) =>
    `. ${pl(v.n, 'Page', 'Pages')} ${v.list} ${pl(v.n, 'has', 'have')} too many matches; some may have been missed`,

  // ---- 範囲 ----
  選んだ範囲: 'Selected area',
  この範囲を消す: 'Remove this area',
  墨消しの範囲: 'Redaction areas',
  '{n} 件': '{n}',
  '塗りつぶし {fill} 件・ぼかし {blur} 件・{pages} ページ': (v) => `Fill ${v.fill} · Blur ${v.blur} · ${v.pages} ${pl(v.pages, 'page', 'pages')}`,
  '・重なり {n} か所': (v) => ` · ${v.n} ${pl(v.n, 'overlap', 'overlaps')}`,
  '{p} ページ・{source}・{mode}': 'Page {p} · {source} · {mode}',
  描いた範囲: 'Drawn',
  検索: 'Search',
  引き継いだ候補: 'From PDF Editor',
  塗り: 'Fill',
  消す: 'Remove',
  すべて消す: 'Remove all',
  'ページの上をドラッグして範囲を描くか、文字列で探してマークします。': 'Drag on a page to draw an area, or find text to mark it.',
  墨消しの範囲の数: 'Number of redaction areas',
  '{n} ページ': 'Page {n}',

  // ---- 適用の結果 ----
  適用の結果: 'Result',
  '事後検査: {n} 件すべて合格': (v) => (Number(v.n) === 1 ? 'Verification: 1 area passed' : `Verification: all ${v.n} areas passed`),
  '事後検査: {n} 件中 {bad} 件が不合格': 'Verification: {bad} of {n} failed',
  '削除した注釈 {annots} 件・取り除いた ActualText などの属性 {attrs} 件':
    'Annotations removed: {annots} · ActualText and similar attributes removed: {attrs}',
  '・画像化したページ {list}': ' · Pages converted to images: {list}',
  '・線も削除したページ {list}': ' · Pages with touching lines removed: {list}',
  '消した文書の項目: {items}': 'Document items removed: {items}',
  '消した文書の項目: なし（もともとありません）': 'Document items removed: none (the document had none)',
  '文書の情報・しおり・添付・スクリプトは残しています': 'Document info, bookmarks, attachments and scripts were kept',
  '出力は元と同じパスワードで保護されています。': 'The output is protected with the same password as the original.',
  範囲: 'Area',
  '画素（覆いだけが見え、下に内容が残らない）': 'Pixels (only the cover is visible; nothing remains beneath it)',
  範囲内の文字: 'Text in the area',
  'ActualText・Alt・E': 'ActualText, Alt, E',
  交差する注釈: 'Intersecting annotations',
  '{i}（{p}p）': '{i} (p. {p})',
  合格: 'Pass',
  不合格: 'Fail',
  '{n} 字': (v) => `${v.n} ${pl(v.n, 'char', 'chars')}`,
  なし: 'None',
  '不合格の範囲があるため、保存・戻しはできません。': 'Some areas failed, so the file cannot be saved or sent back. ',
  もう一度適用する: 'Apply again',
  '編集アプリへ戻しています…': 'Sending back to PDF Editor…',
  '編集アプリに戻しました。このタブは閉じてかまいません。': 'Sent back to PDF Editor. You can close this tab.',
  '編集アプリから応答がありません（閉じられた可能性があります）。「保存」でダウンロードしてください。':
    'No response from PDF Editor (it may have been closed). Use “Save” to download the file.',
  // 保存・戻しのファイル名（<元の名前>_墨消し.pdf。名前がないときは 文書_墨消し.pdf）
  文書: 'document',
  _墨消し: '_redacted',

  // ---- ①の説明（ワーカーから鍵と値で届く。worker/checks.ts） ----
  覆いが見つかりません: 'Cover not found',
  範囲が小さく画素の検査は省略: 'Area too small; pixel check skipped',
  '覆いの外れ {n} 画素': (v) => `${v.n} ${pl(v.n, 'pixel is', 'pixels are')} not covered`,
  '覆いと違う画素 {n}': (v) => `${v.n} ${pl(v.n, 'pixel differs', 'pixels differ')} from the cover`,
  '覆いの下に内容が残っている（濃淡の幅 {n}）': 'Content remains under the cover (tone range {n})',

  // ---- 消した文書の項目（ワーカーから届く。worker/document.ts。一覧の中に並ぶので小文字で始める） ----
  '文書の情報（Info）': 'document info (Info)',
  'XMP メタデータ': 'XMP metadata',
  しおり: 'bookmarks',
  添付ファイル: 'attachments',
  ページラベル: 'page labels',
  作成アプリの私的なデータ: "creator app's private data",

  // ---- ワーカーの誤り（worker/engine.ts・checks.ts、lib/geom.ts） ----
  文書が開かれていません: 'No document is open',
  'PDF ではありません': 'Not a PDF',
  パスワードの入力は不要です: 'No password is needed',
  適用した結果がありません: 'There is no redacted result',
  パスワードで開けません: 'Cannot open with the password',
  '出力を開けません（パスワード）': 'Cannot open the output (password)',
  逆行列がありません: 'The matrix is not invertible',

  // ---- 空の画面 ----
  '読み込んでいます…': 'Loading…',
  '墨消しする PDF を開いてください（ここへドロップもできます）。': 'Open a PDF to redact (you can also drop it here).',
  '文字データを残したまま、指定した範囲の文字・画像・線・注釈・ActualText を消し、消えたことを確かめてから保存します。':
    'Removes the text, images, lines, annotations and ActualText in the areas you choose while keeping the rest of the text data, and verifies the removal before saving.',
  'ファイルはこの端末の中だけで処理し、外部へは送りません。': 'Files are processed only on this device and are never sent anywhere.',

  // ---- 下の帯 ----
  ソースコード: 'Source code',
  'ソースコード: 準備中': 'Source code: coming soon',
  'ライセンス:': 'License:',
  第三者のライセンス: 'Third-party licenses',
  'MuPDF（Artifex Software, AGPL-3.0）を使用': 'Uses MuPDF (Artifex Software, AGPL-3.0)',
  'クロスオリジン分離: {state}': 'Cross-origin isolation: {state}',
  有効: 'on',
  無効: 'off',

  // ---- パスワード ----
  パスワード: 'Password',
  'この PDF はパスワードで保護されています。パスワードは保存しません。': 'This PDF is password-protected. The password is not stored.',
  パスワードが違います: 'Incorrect password',
  やめる: 'Cancel',
  開く: 'Open',

  // ---- 適用の確認 ----
  墨消しを適用しますか: 'Apply redaction?',
  '{n} 件の範囲（{pages} ページ。塗りつぶし {fill} 件・ぼかし {blur} 件）': (v) =>
    `${v.n} ${pl(v.n, 'area', 'areas')} (${v.pages} ${pl(v.pages, 'page', 'pages')}; Fill ${v.fill}, Blur ${v.blur})`,
  '範囲の文字・画像の画素・覆われた線を消し、範囲と交差する注釈（付箋など）を削除します':
    'Removes text, image pixels and covered lines in the areas, and deletes annotations (such as sticky notes) that intersect them',
  '墨消ししたページの ActualText・Alt・E を取り除きます': 'Removes ActualText, Alt and E from redacted pages',
  '保存した PDF を開き直して、消えたことを確かめます': 'Reopens the saved PDF to verify that the content is gone',
  '文書の情報・しおり・添付・スクリプトも消す（推奨）': 'Also remove document info, bookmarks, attachments and scripts (recommended)',
  '文書の情報（題名・作成者など）・XMP・しおり・添付ファイル・JavaScript・ページラベルは、範囲の内容の写しを持つことがあります。元のファイルは変わりません。':
    'Document info (title, author, etc.), XMP, bookmarks, attachments, JavaScript and page labels can contain copies of redacted content. The original file is not changed.',
  適用する: 'Apply',

  // ---- 再適用の選択 ----
  事後検査に合格しないページがあります: 'Some pages failed verification',
  '範囲の下に、一部だけ覆われた線や図形が残っています。ページごとに対処を選んでください。':
    'Partly covered lines or shapes remain under some areas. Choose how to handle each page.',
  '文字・ActualText・注釈が残っているページは、画像化で対処します。': 'Pages with remaining text, ActualText or annotations will be converted to images.',
  'ページを画像化（既定。このページの文字は画像になります）': 'Convert the page to an image (default; text on this page becomes an image)',
  '範囲に触れる線も削除して適用し直す（範囲の外の部分も消えます）':
    'Also remove lines touching the areas and reapply (parts outside the areas are removed too)',
  閉じる: 'Close',
  選んだ方法で適用し直す: 'Reapply with selected options',
  '墨消しを適用し、事後検査をしています…': 'Applying redaction and verifying…',
};
