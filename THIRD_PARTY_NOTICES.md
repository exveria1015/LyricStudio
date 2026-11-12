# 第三者ソフトウェア・辞書

LyricStudio独自のコード、公開文書、同梱サンプル歌詞は [MIT License](LICENSE) で提供します。以下の第三者のコード・辞書には、それぞれのライセンスが適用されます。

## 辞書

| 対象 | 用途 | ライセンス・出典 |
|---|---|---|
| CMU Pronouncing Dictionary | 全見出しから生成した英語シラブル索引をアプリに同梱 | [原文のライセンス](public/dictionary/LICENSE)、[変換内容と出典](public/dictionary/provenance.json) |
| SudachiPy | ローカルでの日本語解析 | [Apache-2.0](backend/licenses/SudachiPy-APACHE-2.0.txt) |
| SudachiDict Full | セットアップ時に取得する日本語辞書 | [Apache-2.0](backend/licenses/SudachiDict-APACHE-2.0.txt)、[UniDic・NEologd等の通知](backend/licenses/SudachiDict-LEGAL.txt)、[版と出典](backend/provenance.json) |

CMUdictの元の著作権表示と再配布条件は生成物でも保持します。Sudachiの辞書本体はGitリポジトリやブラウザー用ビルドに含めず、利用者のローカル環境へセットアップ時に取得します。

## JavaScript依存関係

React、Tiptap / ProseMirror、Lucideなどを使用しています。直接・間接依存の確定版とライセンス識別子は `package-lock.json`、各パッケージの正式なライセンス本文はインストール先の `LICENSE` / `COPYING` 等を参照してください。

`npm run build` は、lockfile上の実行時依存物のライセンス・通知本文を `dist/THIRD_PARTY_LICENSES.txt` へ収録し、本体のMITライセンスを `dist/LICENSE.txt` にコピーします。CMUdictの通知は `dist/dictionary/` に入ります。Lucideに同梱されたFeather由来のMIT通知も元の本文に含めて保持します。依存物のライセンス本文が欠けている場合はビルドを止めるため、配布条件を確認してください。

ビルド済みアプリを配布するときは、これらの通知を含む `dist` 全体を配布してください。開発用依存物の条件を、そのままアプリ本体全体のライセンスと解釈しないでください。

独自の歌詞を入力・取り込んでも、その歌詞の権利やライセンスを変更するものではありません。
