# 開発・貢献の案内

不具合や改善案は [Issues](https://github.com/exveria1015/LyricStudio/issues) へお願いします。質問もIssueで受け付けます。セキュリティに関する報告は [SECURITY.md](SECURITY.md) を先に確認してください。

## 開発環境

[READMEの導入手順](README.md#導入)に従ってセットアップしてください。Windows PowerShellでも同じnpmコマンドを使用できます。Node.js 24系を推奨します（対応範囲は22.13以上の22系・24系・26系以上）。読み探索にはPython 3.10以上が必要です。

```sh
npm ci
npm run setup:readings
npx playwright install chromium
npm run dev
```

変更後は、影響範囲に応じて以下を実行します。CIはWindowsとLinuxで実行する構成です。

```sh
npm run lint
npm test
npm run test:readings
npm run build
npm run test:e2e
npm audit
```

Linuxでブラウザーのシステム依存が不足する場合は `npx playwright install --with-deps chromium` を使用してください。E2Eは専用のブラウザープロファイルで実行します。普段使っているアプリを終了してから実行すると、テスト用サーバーとの取り違えを避けられます。

`package.json` の `overrides` は、ESLint / typescript-eslintの3つの依存元で `minimatch` を11.0.8に固定しています。10系の既知の脆弱性と11.0.7以前の後続の問題を避けるためです。使用箇所は `Minimatch.match()` / `minimatch()` で、11系で削除された `makeRe()` などには依存していません。依存元が修正版へ移行したら固定を外し、`npm ci`・lint・監査で再確認してください。根拠：[GHSA-g3hv-75wg-m249](https://github.com/isaacs/minimatch/security/advisories/GHSA-g3hv-75wg-m249)、[GHSA-hqmv-qgp3-jx75](https://github.com/isaacs/minimatch/security/advisories/GHSA-hqmv-qgp3-jx75)。

## 変更時に守ること

- 歌詞本文、読み、Undo履歴、保存済みデータを意図せず失わないこと。
- 読みや音数が未確定の場合は、その状態を表示すること。辞書候補を作者の意図として自動確定しないこと。
- 利用者の歌詞を外部サービスへ送信しないこと。通信や保存先を変更する提案は、動作と影響を説明すること。
- ファイル形式を変更するときは、既存ファイルの読込・移行と失敗時のデータ保全を確認すること。
- 秘密情報、個人の歌詞、非公開資料、参考画像をコミットしないこと。テストには公開可能な最小例を使うこと。
- バグ修正には再現条件と確認結果を記載し、必要な場合は回帰テストを追加すること。

## Pull Request

変更の目的、利用者への影響、検証した内容、未確認事項を説明してください。大きな仕様変更や新しい依存関係の導入は、先にIssueで目的を共有すると調整しやすくなります。

コードや文書の貢献は、本プロジェクトのMITライセンスで提供できるものを提出してください。第三者のコード・データを追加する場合は、出典とライセンスを明記し、必要な通知を保持してください。採否や回答時期は保証しません。
