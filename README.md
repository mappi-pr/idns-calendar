# idns-calendar (キャスト出勤カレンダー) 

概要
- Cloudflare Workers 上で簡易フロント + API を提供するサンプル実装。
- X 投稿の URL を oEmbed APIで解析してシフト情報を抽出 -> 保存（D1 または KV）するフローを実現。
- 完全無料での運用を実現するため、Twitter APIは使用しない設計。

注意点（重要）
- 秘密情報は絶対にリポジトリに含めないでください。
- oEmbedの利用規約に従って実装してください。

実装の流れ
1. フロントエンドからシフト情報の投稿 URL を受け取る
2. /api/parse で URL を検証し、oEmbed API を使ってツイート内容を取得
3. 必要に応じて AI での解析を行い、シフト情報を抽出
4. /api/save でシフト情報を保存（D1 または KV）
5. 定期的に cron ジョブでシフト情報の更新や学習を実施

期待されるファイル（cal フォルダ）
- wrangler.toml
  - account_id, env, d1_databases（binding = "DB" など）、kv_namespaces（SHIFTS_KV, LEARNED_KV, OAUTH_KV）を設定する必要あり。
  - cron_triggers（例: ["0 0 1 * *","0 0 16 * *"]）を設定する場合は公開環境で動作確認を行ってください。
- package.json
  - devDependencies に wrangler と ajv 等があることを確認。Cloudflare へデプロイする際はバンドルされるようにしてください。
- src/index.js
  - フロント（/, /calendar）レンダリング、/api/parse, /api/save, /api/update, /api/delete, /api/list、/auth/* および /auth/x/me 等のルーティングを含みます。
- src/oauth_x.js
  - X (Twitter) OAuth2 PKCE の開始／コールバック／トークン取得、tweet 取得ヘルパーを提供。OAUTH_KV を使用。
- src/validator.js
  - ajv を使って schemas/ai_response_schema.json を検証するユーティリティ。Workers 環境で JSON import を使う場合はビルド（バンドル）設定を確認してください。
- src/cron.js
  - cron_triggers で実行するバッチロジックのサンプル（半月ごとの学習処理）。
- schemas/ai_response_schema.json, ai_response_example.json, ai_prompt.txt
  - AI に期待するスキーマとプロンプトテンプレート。
- migrations/create_table.sql
  - D1 用のテーブル作成 SQL（shifts テーブルなど）。

必須 Secrets / 環境変数（wrangler secret put で登録）
- AI_ENDPOINT (任意: 外部AIを利用する場合)
- AI_KEY (任意)
※ X API関連の設定は不要になりました

必須 KV / D1 バインディング名（wrangler.toml に反映）
- SHIFTS_KV (保存フォールバック)
- LEARNED_KV (学習結果保存)
※ OAUTH_KVは不要になりました

重要な実装上の注意点（チェックリスト）
- oEmbed APIの利用
  - X の公開oEmbed API (https://publish.twitter.com/oembed) を利用してツイート内容を取得します
  - レート制限に注意してください（キャッシュの活用を推奨）
  - 埋め込みコンテンツの利用規約を遵守してください
- スクレイピングの注意点
  - robots.txtを確認し、適切なインターバルを設けてリクエストを行ってください
  - User-Agentを適切に設定してください
  - HTMLパースには信頼性の高いライブラリを使用してください
- Cookie とセッション
  - コールバックで `Set-Cookie: cal_session=...; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=...` を返しています。デプロイ先が HTTPS であることを必須としてください（Cloudflare Pages / Workers は HTTPS）。
  - Cloudflare KV に TTL-per-key は直接は無いため、created_at を保存して有効期限チェックを行うか、定期バッチで掃除してください。
- KV の list 使用はコストとパフォーマンスに注意
  - KV.list は大規模データには適しません。大量データの場合は D1 を推奨します。
- D1 / マイグレーション
  - migrations/create_table.sql を D1 に適用してください。テーブル構造（payload JSON カラム等）は運用に合わせて変更してください。
- AI レスポンスの検証
  - save/update 前に ajv でスキーマ検証を行い、不正な JSON は拒否する仕様になっています。運用方針によっては「警告のみ」に変更可能です。
- OAuth の範囲（scope）と認可フロー
  - X API の仕様は頻繁に変わります。認可 URL、token endpoint、scopes は最新ドキュメントを確認してください。client_secret の扱いはアプリ設定に依存します。
- エラーハンドリングとリトライ
  - /auth/x/fetch_tweet で 401 が返る場合は refresh_token による再取得を試みる実装がありますが、失敗時のフォールバック処理（oEmbed など）を用意してください。
- CORS と credentials
  - フロントから cookie を使ってセッションを送る際は fetch に `credentials: 'same-origin'` を指定しています。外部オリジンから利用する場合は CORS ポリシーの調整が必要です。

デプロイ前チェックリスト
1. wrangler.toml の account_id / kv_namespaces.id / d1_databases を正しく設定。  
2. wrangler secret put で必要なシークレットを登録。  
3. migrations/create_table.sql を D1 に適用（必要なら wrangler d1）。  
4. npm install（ajv 等）→ ビルド / バンドルを確認（JSON import を使う場合は bundler 設定を確認）。  
5. wrangler publish または CI でデプロイ。  
6. 本番ドメインで OAuth の Redirect URI が登録済みであることを確認。

開発・デバッグ
- ローカル開発: `wrangler dev src/index.js` を利用。ログはターミナルで確認してください。  
- 実装の各エンドポイントは curl / Postman で早めに検証してください。特に /auth/x/callback はブラウザでの手順を必ず通して動作確認すること。  
- AI エンドポイントのレスポンスはまず ai_response_example.json に合わせて手動で保存して動作検証することを推奨します。

制限事項（現在のプロトタイプ）
- oEmbed APIの制限により、非公開アカウントの投稿は取得できません
- スクレイピングベースのため、X側の仕様変更に影響を受ける可能性があります
- 大量リクエストは避け、適切なキャッシュ戦略を実装してください

次の推奨追加実装（優先度）
- oEmbedレスポンスのキャッシュ機構の実装
- バックオフ／リトライロジックの実装
- HTMLパース結果の正規化処理の追加

追加技術詳細（コマンド例・検証手順）

1) ローカル開発・デプロイ（基本）
- 開発サーバ起動:
  - wrangler dev src/index.js
- デプロイ:
  - wrangler publish
  - 環境指定例: wrangler publish --env production

2) Secrets 登録例（ローカル端末）
- wrangler secret put X_CLIENT_ID
- wrangler secret put X_CLIENT_SECRET
- wrangler secret put AI_KEY
- wrangler secret put AI_ENDPOINT
（コマンド実行後にプロンプトで値を貼り付けます）

3) KV 名前空間作成例（wrangler がインストールされている環境で）
- wrangler kv:namespace create "SHIFTS_KV"
- wrangler kv:namespace create "OAUTH_KV"
- wrangler kv:namespace create "LEARNED_KV"
- コマンド実行後に出力される id を wrangler.toml の kv_namespaces に貼り付けてください。

4) D1 / マイグレーション（手元で SQL を用意）
- migrations/create_table.sql を Cloudflare D1 コンソールで適用するか、wrangler D1 コマンドから実行してください（環境によりコマンドが異なるため Cloudflare ドキュメント参照）。
- 例: SQL の中身（参照）
  ```sql
  CREATE TABLE IF NOT EXISTS shifts (
    id TEXT PRIMARY KEY,
    payload JSON,
    source TEXT,
    created_at TEXT
  );
  ```

5) API 呼び出しの curl 例
- /api/parse（非認証 fetch）
  ```
  curl -X POST "https://your-worker-domain/api/parse" \
    -H "Content-Type: application/json" \
    -d '{"url":"https://x.com/USER/status/1234567890"}'
  ```
- /auth/x/fetch_tweet（認証セッション cookie がある場合）
  ```
  curl -X POST "https://your-worker-domain/auth/x/fetch_tweet" \
    -H "Content-Type: application/json" \
    --cookie "cal_session=SESSION_ID" \
    -d '{"url":"https://x.com/USER/status/1234567890"}'
  ```
  ※ ブラウザ経由での OAuth を想定する場合、curl ではなくブラウザで /auth/x/start にアクセスしてください。

- /api/save（保存）
  ```
  curl -X POST "https://your-worker-domain/api/save" \
    -H "Content-Type: application/json" \
    -d '{"parsed": { /* ai schema 準拠の JSON */ }, "source":"https://x.com/..."}'
  ```

6) OAuth フロー（短縮）
- 認可開始（ブラウザ）:
  - GET https://your-worker-domain/auth/x/start
  - ブラウザが X の認可画面にリダイレクトします。
- コールバック:
  - X が登録済みの Redirect URI（例: https://your-worker-domain/auth/x/callback）へ code と state を付けて戻ります。
  - ワーカーは code を token に交換し、OAUTH_KV と session を保存、HttpOnly クッキーをセットします。

7) AI スキーマ検証（ajv の例）
- ローカルで簡単に検証するには ajv-cli を利用:
  ```
  npx ajv-cli validate -s schemas/ai_response_schema.json -d schemas/ai_response_example.json
  ```
  - 成功すれば exit 0、検証エラーがあれば詳細が表示されます。
- Node スクリプトで検証するサンプル（validate.js）:
  ```javascript
  // 実行例: node validate.js
  const Ajv = require("ajv");
  const schema = require("./schemas/ai_response_schema.json");
  const data = require("./schemas/ai_response_example.json");
  const ajv = new Ajv();
  const valid = ajv.validate(schema, data);
  console.log({ valid, errors: ajv.errors });
  ```

8) ビルド / bundling に関する注意
- src/validator.js などで `import ... assert { type: "json" }` を使う場合、wrangler + esbuild 等でバンドルが必要です。問題がある場合はスキーマを JS モジュールで export するか、文字列で読み込む設計に変更してください。
- package.json にビルドスクリプトを追加して CI で `npm run build && wrangler publish` を実行するのが安全です。

9) デバッグのヒント
- wrangler dev 実行中のログをターミナルで確認してください。
- エンドポイントを curl / httpie / Postman で順に試すと原因切り分けが早いです。
  - まず /api/parse を手動 JSON（ai_response_example.json）で投稿して /api/save の保存処理を確認。
  - OAuth はブラウザで /auth/x/start → 認可 → コールバック を必ず通して検証してください。

10) 運用上の追加注意
- KV.list は大規模データに非推奨。大量データは必ず D1 を検討してください。
- セッションの有効期限管理は KV に created_at を保存してワーカー側で検証するか、定期バッチで掃除してください。
- AI の入力／モデル呼び出しはレート制御とリトライ（指数バックオフ）を実装してください。


