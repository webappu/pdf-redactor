# 精密墨消しアプリの約束（apps/redactor/、AGPL-3.0-or-later、ソース公開）

PDF の「文字データを保ったまま」、指定した範囲の内容を**確実に消す**単独の Web アプリ。MuPDF.js（AGPL）を使う。
本体（apps/editor、非公開）とは**コードを共有しない**。交換するのは標準の PDF ファイルだけ（下記の引き継ぎ）。
本番では本体と同じオリジンの `/redact/` に置く（vite の `base: '/redact/'`）。開発サーバーは 7311（strictPort）。

## 機能

1. 開く: ファイル選択・ドロップ・本体からの引き継ぎ。パスワード付き PDF も開ける（入力ダイアログ。パスワードは保存しない）
2. 表示: MuPDF をワーカーで動かし、ページを描画する
   - サムネイルとページビューを持ち、拡大・縮小できる
   - ファイルは `new mupdf.Stream({ fileSize, read, close })` で必要な部分だけ読む
   - 大きな文書でも、見えているページから描く
3. 墨消しの指定
   - 矩形をドラッグで描く（移動・大きさ変更・削除）
   - 文字列の検索で一致箇所を一括でマークする（`page.search`）
   - 開いた PDF に既にある `/Redact` 注釈（本体から引き継いだもの）を読み込んで表示する
   - 方式は「塗りつぶし（色を選べる。既定は黒）」か「ぼかし」
4. 適用（ボタン1つ。確認画面で件数を示す）。手順は次のとおり（設計レビューの実測で見つかった漏洩経路への対策）
   1. 範囲と交差する既存の注釈（付箋 Text・Popup・FreeText・Widget など）を削除する。付箋の本文 /Contents が残る漏洩への対策
   2. ぼかしの範囲は、適用前に低解像度で描画しておく（行の高さ以上のブロックで平均 → 色を量子化 → 暗号乱数のノイズ → ガウスぼかし）
   3. `page.applyRedactions(false, REDACT_IMAGE_PIXELS, REDACT_LINE_ART_REMOVE_IF_COVERED, REDACT_TEXT_REMOVE)`
   4. 墨消ししたページの内容ストリームと、そこから使われる Form XObject から、マーク付き内容の /ActualText・/Alt・/E を取り除く（自前の字句解析器。インラインの辞書と /Properties の参照の両方）。消す語と残す語を両方包む ActualText が残る漏洩への対策
   5. 塗りつぶしの矩形、またはぼかし画像を最前面に描く
   6. `saveToBuffer('garbage=4,compress,clean,sanitize,objstms')`（`linearize` は非対応なので使わない）
   7. 事後検査: 保存した PDF を開き直し、範囲ごとに次の4点を確かめる
      - ①注釈を描かずに描画した範囲内の画素が、塗り色（またはぼかし画像）だけである
      - ②構造化テキストで範囲内の文字が 0
      - ③墨消しページに ActualText・Alt・E が残っていない
      - ④範囲と交差する注釈が 0
   8. ①に失敗したとき（一部だけ覆われた線画が残る場合）は、「線も削除（REDACT_LINE_ART_REMOVE_IF_TOUCHED）して再適用」か「そのページを画像化」を選ばせる。既定は画像化
5. 出力: 「保存」（ダウンロード）または「編集アプリに戻す」（下記）。検査結果を画面に表示する
6. 画面に、このアプリのソースコードの入手先へのリンクと、ライセンス（AGPL-3.0）の表示を置く（AGPL §13）
   - リンク先は `src/config.ts` の `SOURCE_URL` で設定する。未設定なら「ソースコード: 準備中」と表示する
7. CSP・COOP/COEP は本体と同じ方針（vite.config.ts 済み）。外部への通信をしない

## 本体との引き継ぎの取り決め（BroadcastChannel、チャンネル名 `pdf-editor-handoff-v1`）

ディスクには書かない。PDF は Blob で直接渡す。どちらのアプリも、自分が知らない id のメッセージは無視する。

```
本体 → redactor（行き）
  1. 本体: クリック処理の中で同期的に window.open('/redact/#handoff=<id>')  ※ id は推測できない乱数（crypto.randomUUID）
  2. redactor: 起動時に URL の #handoff=<id> を読み、チャンネルへ { type: 'ready', id } を送る（届くまで 300ms ごとに最大 10 回）
  2a. 本体: 最初の ready を受けたらすぐに { type: 'preparing', id } を送り、渡す PDF を作り始める
      redactor: preparing を受けたら ready の再送を止め、「編集アプリが PDF を作っています…」と示して payload を最大 10 分待つ（過ぎたら受け取れなかったと示す）。
      preparing が来なければ、ready を 10 回送ったところで諦める（本体が閉じている・別のタブ）
  3. 本体: { type: 'payload', id, name, blob } を送る（name はファイル名。PDF の中に /Redact 注釈として墨消しの候補が入っていることがある）
  3a. 本体: PDF を作れなかったとき（取り消しを含む）は、payload の代わりに { type: 'failed', id, message } を送る。redactor は message を示して待つのをやめる
  4. redactor: { type: 'received', id } を送る。本体は手元の参照を捨てる
redactor → 本体（戻し）
  5. redactor: { type: 'return', id, name, blob } を送る
  6. 本体（同じ id を待っているタブ）: 受け取ったら、文書を開く前にすぐ { type: 'returned', id } を返し、その後で新しい文書として開く
  7. redactor: 2 秒以内に 'returned' が来なければ、本体が閉じているとみなし、ダウンロードを案内する
```

- `payload` の `name` は元のファイル名（例: `contract.pdf`）。`return` の `name` は `<元の名前>_墨消し.pdf`（例: `contract_墨消し.pdf`。元の名前の末尾の `.pdf` は除く）。英語の画面では `<元の名前>_redacted.pdf`（保存するときの名前も同じ）。本体は名前を読み取らずに使う

### 墨消しの候補の /Redact 注釈の形（本体が書き、redactor が読む）

- `/Subtype /Redact`、`/Rect`（範囲の外接矩形）、`/QuadPoints`（範囲の四隅。回転した枠もあり得る。8 つの数 = 1 つの四角形。PDF の利用者空間）
- 塗りの色: `/IC [r g b]`（0〜1）。なければ黒
- 方式: 独自のキー `/PDFEditMode /Blur` があれば「ぼかし」、なければ「塗りつぶし」（`/PDFEditMode` は本体と redactor の間だけの取り決め）
- /QuadPoints がなければ /Rect を範囲とする

## 合格基準（Playwright。redactor 単独の開発サーバー 7311 か、統合 preview 7312）

- 漏洩経路の試料（`apps/redactor/scripts/make-redact-fixtures.mjs` で生成。テスト専用）
  - (a) 消す語と残す語を 1 つの ActualText が包む
  - (b) 範囲内に付箋注釈（/Contents に秘密）
  - (c) 範囲を横切る線
  - (d) Form XObject 内の文字
  - (e) /Rotate 90 のページ
  - (f) 画像の一部
- 試料ごとに、適用後の PDF で、秘密の文字列が抽出できず、事後検査①〜④が合格する。範囲外の文字は抽出できる
- 引き継ぎ: テスト用の「本体役」のページ（同一オリジンの試験用 HTML）から PDF を渡して開け、戻しのメッセージが届く
- 外部へのリクエストが 0 件
