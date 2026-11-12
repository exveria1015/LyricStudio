# オフライン動作

本番ビルドをブラウザーで一度開き、Service Worker のインストールが完了すると、通信がない状態での再読み込み・編集・かな解析・英語辞書照会・保存・書き出しに使えます。初回表示には配信サーバーへ接続する必要があります。`localhost` または HTTPS で配信してください。開発サーバーでは Service Worker を登録しません。

SudachiDict Full の読み探索には、初回に `npm run setup:readings` で辞書を取得し、ローカル解析プロセスを起動しておく必要があります。`npm start` は本番画面と解析を同時に起動します。外部のネットワーク接続は不要ですが、ローカルプロセス停止中、またはブラウザーの開発者機能で loopback 通信まで遮断した場合は解析を利用できません。その場合も既存の読み・本文を保持し、個人辞書の候補と手動入力を使えます。Full 辞書は Service Worker に含めません。

`scripts/build-offline.mjs` は Vite の出力後に実行し、`dist/sw.js` を生成します。HTML、JavaScript、CSS、アイコン、辞書のライセンス・出典情報をまとめてキャッシュし、全ファイルの内容からキャッシュ版を決めます。CMUdict の全音節索引は JavaScript 内に収録され、別の API を必要としません。

ナビゲーションはネットワークを優先し、通信失敗時は保存済みの画面を返します。静的リソースは同じ版のキャッシュを使います。同一 origin・Service Worker の scope 内の GET のみ扱い、歌詞本文を Service Worker のキャッシュへ保存しません。本文の自動保存は IndexedDB、単独の歌詞は `.lyrics.json`、A/Bと比較設定のバックアップは `.lyrics-workspace.json` です。

更新版は使用中のタブを強制再読み込みしません。旧版を使用中の全タブを閉じると、インストール済みの更新版が有効になります。古いキャッシュの削除対象は `lyrics-studio-offline-v1-` 接頭辞だけです。ブラウザーのサイトデータ削除はオフライン用データと IndexedDB の両方を消すため、必要な歌詞は編集用 JSON でも保存してください。

動作確認では、本番 preview を開いて Service Worker が制御を開始したことを確認し、ブラウザーを offline に切り替えて再読み込みします。画面だけでなく、編集・英語音節計数・IndexedDB 復元・単独歌詞とA/Bワークスペースの書き出し、分割方向・手動対応の再起動後の復元も確認対象です。OS の日本語 IME による実入力は別途確認が必要です。

自動確認は `npx playwright install chromium` と `npm run build` の後に `npm run preview -- --port 4174 --strictPort` を起動し、別の端末で `node scripts/check-offline.mjs` を実行します。毎回独立したブラウザープロファイルを使うため、実際の編集文書へ触れません。Linuxの `/usr/bin/google-chrome` があれば使用し、それ以外ではPlaywrightのChromiumを使います。必要なら `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` で実行ファイルを指定できます。Vite preview の `Vary: Origin` ヘッダーによるキャッシュ照会の差もこの再読み込みで検証します。
