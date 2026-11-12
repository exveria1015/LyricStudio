# ローカル読み観測サービス

SudachiPy **0.7.0** と SudachiDict **Full 20261015** を使用する。表記検索と形態素解析の結果を返すサービスであり、作者の意図した読みを確定する機能ではない。候補探索・観測順の選択・保留・作者による採用はフロントエンドが扱う。

## 導入と起動

Python 3.10 以上を使用する。WindowsとLinuxで同じnpmコマンドを使い、各OS用の専用仮想環境を作成する。

```sh
npm run setup:readings
npm run dev:readings
```

初回セットアップは公開パッケージと実辞書をダウンロードし、プロジェクト専用 `.venv-sudachi` に導入する。システム Python のパッケージは変更しない。辞書 zip は **137,444,817 bytes**、展開後 `system.dic` は **330,506,339 bytes**。小さな PyPI 配布用ラッパーのサイズとは異なる。セットアップ後の実行はインターネット接続を必要としない。

開発サーバーの `/api/readings` は `127.0.0.1:8787` に転送する。ビルド済み UI と同じ origin で提供する場合:

```sh
npm run dev:readings -- --static dist --port 4173
```

起動先は **127.0.0.1 に固定**。入力本文・リクエスト URL のアクセスログは出さず、外部サービスへの問い合わせは行わない。Host/Origin は localhost と loopback IP に制限し、CORS は提供しない。複数の解析要求は辞書アクセスのロックで直列化する。

```sh
npm run check:readings
npm run test:readings
```

## API

`GET /api/readings/health` は `{ service: 'lyrics-studio-readings', available, provider }` を返す。未導入・バージョン不一致・辞書読込失敗は HTTP 503 / `available: false`。API のエラーを UI の HTML に置き換えない。

`POST /api/readings/observe` は JSON `{ kind: 'exact' | 'context', text, mode?: 'A' | 'B' | 'C' }` を受け取る。`exact` では mode を付けず、`context` の既定 mode は C。最大 1024 UTF-16 単位、JSON body 最大 16 KiB。空文字・NUL・不正サロゲート・重複 JSON キーは拒否する。

応答:

```ts
type Provider = {
  id: 'sudachi-full'; edition: 'full'; version: string;
  engineVersion: string; dictionaryVersion: string;
};
type DictionaryEntry = {
  id: string; surface: string; reading: string;
  normalizedForm: string; dictionaryForm: string; partOfSpeech: string[];
  dictionaryId: number; wordId: number; isOov: boolean;
};
type ReadingToken = DictionaryEntry & { from: number; to: number };
type Observation = {
  provider: Provider; entries: DictionaryEntry[]; tokens: ReadingToken[];
  elapsedMs: number; truncated: boolean; notes: string[];
};
```

- **表記照会:** `Dictionary.lookup()` の全結果を最大 128 項目まで返す。辞書の返却順を保持し、異なる読み・品詞・ID を統合しない。128 を超えた場合は `truncated: true` と `exact_entry_limit_128` を返す。未ヒット時に読みを捏造しない。
- **照会の限界:** `lookup()` は入力を正規化し、索引に載る項目を調べる。たとえば `ＡＢＣ` への項目 surface は `abc` になる。`notes` の `lookup_input_normalized` を保持し、文字列の完全一致を主張する場合はクライアント側でも surface を照合する。索引外項目を含む全辞書走査や読みからの逆引きは行わない（`lookup_indexed_entries_only`）。
- **形態素解析:** 指定された A/B/C **1 モードだけ**を実行する。追加の文脈窓・モードを調べるかはクライアントが決める。読みは Sudachi の原表記（主にカタカナ）を保持する。
- **範囲:** Python の code point 範囲を JavaScript の UTF-16 `from/to` に変換する。元の入力 slice と `raw_surface()` の一致、および全体の連続したカバレッジを検証する。正規化表記を元の入力範囲として代用しない。
- **出典:** ID は Full 辞書とエンジンのバージョン、dictionaryId、wordId を含む。`wordId` は符号なし 32 bit 相当の値になり得る。OOV の ID は一般カテゴリ ID の衝突を避けるため内容のハッシュを加える。OOV が返す表記を確定した辞書読みとして扱わない。
- **費用:** `elapsedMs` はロック待ちを含むサーバー内の実測時間。辞書順やこの値を、読みの正解確率と解釈しない。解析結果の保存・キャッシュはサーバーでは行わない。

実辞書テストでは「明日」のアス・アシタ・ミョウニチ、「届かない」の届か（トドカ）＋ない、国家公務員の A/B/C 分割、非 BMP 文字・結合文字・空白の範囲を検証している。作者の意図の正解率や SIDUS 方策の優位性を証明するテストではない。

## 出典とライセンス

- [SudachiPy 0.7.0](https://pypi.org/project/SudachiPy/0.7.0/): Apache-2.0。公式は v0.7 系のパッチ間でも変更の可能性を明記しているため、エンジンと辞書を厳密に固定する。
- [SudachiDict](https://github.com/WorksApplications/SudachiDict): Full は V1 形式。SudachiPy 0.7 以上が必要。Apache-2.0 と同梱の UniDic・NEologd 通知を保持する。
- [SudachiPy API](https://worksapplications.github.io/sudachi.rs/python/api/sudachipy.html): 公開ドキュメントは開発版を含むため、ここで使用する API は導入済み 0.7.0 でも実行確認した。

配布元のライセンス全文を `licenses/` に、辞書のダウンロード先・サイズ・SHA-256 を `provenance.json` に保存した。辞書バイナリはアプリの静的配信物や Git に含めず、専用 Python 環境から読む。
