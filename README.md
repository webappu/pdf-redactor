# 精密墨消し（pdf-redactor）

PDF の墨消しを、文字のデータごと取り除いて行うブラウザのアプリです。PDF はサーバーに送らず、すべてブラウザの中で処理します。

- 使う: https://webappu.github.io/pdf-redactor/
- PDF 編集アプリ（https://pdfedit-free.pages.dev/ ）の「文字データのまま墨消し」からも開けます。編集アプリから開いたときは、墨消しした PDF を編集アプリへ戻せます

## できること

- 範囲を囲む、文字を検索してまとめて指定する、PDF の中の墨消しの注釈（/Redact）を読み込む
- 塗りつぶし、または復元できないぼかし
- 適用すると、範囲の文字・画像・線を MuPDF で取り除き、ActualText・Alt などに残った文字も消し、範囲に掛かる注釈を削除する
- 保存した PDF を開き直して、範囲から文字が取れないことなどを確かめ、結果を画面に出す

## 開発

```sh
npm ci
npm run dev      # 開発サーバー（http://localhost:7311/redact/）
npm test         # 単体の試験（Node + MuPDF）
npm run check    # 型検査
npm run build    # dist/ に出力。置き場所は環境変数 REDACTOR_BASE（既定 /redact/）
```

試験用の PDF は `node scripts/make-redact-fixtures.mjs <出力先>` で作れます。

## ライセンス

AGPL-3.0-or-later（LICENSE）。MuPDF（AGPL-3.0）を使っています。第三者のソフトウェアのライセンス表記は、ビルドすると dist/licenses.txt に出ます。
