# コントリビューションガイド

OpenSeat への貢献をありがとうございます。個人が始めた小さなプロジェクトですが、公開して進めています。

## いまの状況

**Phase 0（準備・探索）です。実装はまだありません。** 設計は [開発プラン](docs/260916_plan_OpenSeat.md) に、フェーズは [ロードマップ](docs/ROADMAP.md) にあります。

この段階で最も役に立つのは、コードよりも次の 3 つです。

1. **設計へのレビュー。** 特に [第 7 章 コアロジック仕様](docs/260916_plan_OpenSeat.md) の穴を探してください。状態機械の抜け、割当アルゴリズムが破綻するケース、既定値の妥当性についての指摘を歓迎します。
2. **先行事例の情報。** 似た課題を扱った製品、実証実験、研究。うまくいかなかった事例ほど価値があります。
3. **導入先の情報。** 導入できそうなフードコート、学食、社員食堂、運営事業者。

Issue を立ててください。日本語でも英語でも構いません。

## 進め方

### Issue

- **バグ**、**機能提案**、**質問・設計の議論** のテンプレートがあります。
- 大きな変更を実装する前に、必ず Issue で方針を合意してください。実装してから設計が合わないと分かるのは、双方にとって損です。
- 設計上の判断は [ADR](docs/adr/) に記録します。議論が決着したら ADR を書きます。

### プルリクエスト

1. Issue で合意してからブランチを切ってください。
2. ブランチ名は `feat/...` / `fix/...` / `docs/...` / `refactor/...` / `test/...`。
3. コミットメッセージの接頭辞は `feat:` / `fix:` / `refactor:` / `docs:` / `chore:` / `test:`。
4. `main` への直接 push はしません。PR を経由します。
5. PR テンプレートの項目を埋めてください。特に **ドメインロジック・スキーマ・運用パラメータの既定値に触れる場合は、影響範囲を必ず書いてください。**

### 署名（DCO）

コミットには [Developer Certificate of Origin](https://developercertificate.org/) の署名を付けてください。`git commit -s` で `Signed-off-by:` 行が入ります。CLA は求めません。

## 開発環境

Node 22 と pnpm 10 以上が必要です。

```bash
pnpm install
pnpm verify      # lint、typecheck、テスト、アーキテクチャ検査、リンク検査を通しで実行
```

個別に実行する場合は次のとおりです。

| コマンド | 内容 |
|---|---|
| `pnpm lint` | ESLint |
| `pnpm typecheck` | TypeScript の型検査 |
| `pnpm test` | Vitest（`pnpm test:watch` で監視） |
| `pnpm check:arch` | 層の境界の検査。`packages/core` の依存ゼロと純粋性、`packages/shared` が画面でも動くこと、ルート層から永続化層への直接依存 |
| `pnpm check:links` | ドキュメント内の相対リンクの検査 |
| `pnpm sim` | シミュレーションを走らせ、指標を出す（開発プラン 8 章） |
| `pnpm server` | サーバを手元で動かす（開発プラン 9.2） |
| `pnpm openapi` | API の文書（`docs/openapi.json`）を書き出す |

`pnpm check:arch` と `pnpm check:links` は依存を持たない素の Node スクリプトなので、`pnpm install` の前でも動きます。

### シミュレーション

実証実験の前に、コアロジックのルールと既定値を離散事象シミュレーションで評価します（[開発プラン 8 章](docs/260916_plan_OpenSeat.md)）。**シミュレータはサーバとまったく同じ `packages/core` を使う**ので、ロジックの二重実装になりません。

```
pnpm sim                                            # 既定（weekend-peak を 20 回）
pnpm sim --scenario weekend-overload --runs 200     # 過負荷を 200 回
pnpm sim --runs 200 --out result.csv --html out.html  # CSV と HTML レポートを書き出す
pnpm sim --help
```

同じシードからは必ず同じ結果が出ます。**実装の誤りを示す拒否が 1 件でもあれば、書き出さずに終了コード 1 で終わります。**

出てくる数字は 8.1 の初期値に基づくもので、**現地観察で置き換える前のものです。ルールの相対比較には使えますが、絶対値を施設に示さないでください**（開発プラン 8.5）。

### サーバ

[`apps/server`](apps/server) が API・配信・スケジューラ・静的配信をまとめて受け持ちます（[開発プラン 9.2](docs/260916_plan_OpenSeat.md)）。成果物は **1 つのコンテナと SQLite** だけです（[ADR-0005](docs/adr/0005-single-container-sqlite.md)）。

```
pnpm server                                       # 手元で動かす（http://localhost:8080/healthz）
docker compose -f infra/docker-compose.yml up --build   # コンテナで動かす
./infra/smoke.sh openseat:local                   # 組み上がったイメージを通しで試す
```

スキーマの出典は [`apps/server/db/schema.ts`](apps/server/db/schema.ts) です。**マイグレーションは生成物なので、手で書き足さないでください。**

```
pnpm --filter @openseat/server db:generate        # スキーマを変えたら生成し直す
```

### 施設アクター

施設ごとに 1 つの[アクター](apps/server/venue/actor.ts)が状態を持ち、**コマンドを 1 件ずつ順に**適用します（[開発プラン 9.4](docs/260916_plan_OpenSeat.md)）。

- **時刻はサーバだけを信じます。** 時計は外から渡すので、テストでは偽装できます
- **10 秒ごとに `tick` を呼びます。** 個別のタイマーは持ちません。止まっていて時間が飛んでも、来ている期限は次の 1 回で片づきます
- **送り直しで二度適用しません**（[ADR-0015](docs/adr/0015-idempotency-key.md)）。画面が操作ごとに鍵を作って送ります
- **記録してから配信します。** 順番を入れ替えません

`/healthz` が `tickLagMs` を返します。**10 秒ごとに進めるので、0〜10 秒を行き来するのが正常**です。

### 利用者の API

[`apps/server/routes`](apps/server/routes) にあります（[開発プラン 9.7](docs/260916_plan_OpenSeat.md)）。**ハンドラがしてよいのは 5 つだけ**です（[CLAUDE.md 3.1](.claude/CLAUDE.md)）。

1. 入力の検証（Zod） 2. 実行者の特定 3. コマンドの組み立て 4. アクターへ委譲 5. 結果の整形

ハンドラに `if (ticket.state === 'CALLED')` が現れたら設計の誤りです。**権限の判定も書きません**（`core` の表が決めます。[ADR-0014](docs/adr/0014-permissions-in-core.md)）。`pnpm check:arch` が落とします。

**秘密の扱い**（9.8、CLAUDE.md 7 章）。

- **画面が作り、サーバはハッシュだけを保存します。** 端末の匿名トークンも、チケット URL の秘密パラメータも
- **記録には識別子ごと出しません。** 残すのは道の形（`/api/t/:ticket`）だけです
- **`Referrer-Policy: no-referrer`。** チケットの URL に秘密が乗っているので、外部へ参照元を送りません
- **よそのサイトからの書き込みは `Origin` を照合して断ります**（CSRF。トークンは配りません）

### 画面

[`apps/web`](apps/web) にあります（[開発プラン 9.2、10 章](docs/260916_plan_OpenSeat.md)）。React + Vite の SPA 1 つに、利用者・ボード・スタッフ・管理を載せます。**いまは利用者の 3 画面だけ**です（受付・チケット・空き状況）。

```
pnpm --filter @openseat/web dev      # 手元で画面を開く（/api はサーバへ回ります）
pnpm --filter @openseat/server dev   # 別の窓でサーバを動かしておく
pnpm --filter @openseat/web build    # 組み上げる（型検査 → Vite）
```

**ビューは状態を描くだけです**（[CLAUDE.md 3.1](.claude/CLAUDE.md)）。

- **押せる操作はサーバが返します。** 画面は `actions` を並べるだけで、足しも引きもしません。何が押せるかは `core` に聞いて決まっています（`routes/views.ts` が `dispatch` を空打ちします）
- **期限の判定を書きません。** サーバは絶対時刻の期限とサーバ時刻を返し、画面は残りを数えて出すだけです。**端末の時計は信じません**（時差を打ち消します）
- **権限の判定を書きません**（[ADR-0014](docs/adr/0014-permissions-in-core.md)）
- `pnpm check:arch` が、これらと「ブラウザに Node の組み込みは無い」ことを落とします

**画面に文字列を直書きしません。** 文言は [`packages/shared`](packages/shared) の i18n にあり、鍵で引きます。テストも鍵で引いてください —— 直書きすると、文言を直したときに「壊れた」のか「変えた」のか分からなくなります。

**見え方の決まりごと**（10.4）。立ったまま、片手で、屋内の明るいところで読みます。

- 文字は大きく（既定 18px）、ボタンは指で押せる大きさ（最低 3rem）
- **色だけに意味を持たせません。** 状態は必ず文字でも出します
- 数字が変わるところは `aria-live="polite"` に入れます。**`assertive` にしないでください** —— 1 秒ごとに割り込むと、ほかが読めなくなります

**部品の一式（shadcn/ui など）は入れていません。** ボタンとステッパーしか無い段階で依存を増やすより、素の要素のほうが支援技術との相性がよいためです。画面が増える PR 13・14 で改めて判断します。

### 配信

[`apps/server/routes/stream.ts`](apps/server/routes/stream.ts) と [`apps/server/stream/hub.ts`](apps/server/stream/hub.ts)、画面側は [`apps/web/src/live.ts`](apps/web/src/live.ts) にあります（[開発プラン 9.5](docs/260916_plan_OpenSeat.md)、[ADR-0018](docs/adr/0018-server-sent-events.md)）。

**SSE 1 本で配り、つながらないあいだは 5 秒ごとに取りに行きます。**

- **流すのはイベントではなく「いまの姿」です。** `GET` で取るのとまったく同じ形が届くので、画面は描き替えるだけで済みます。イベントを流すと**画面が状態機械を持つ**ことになります（[CLAUDE.md 3.1](.claude/CLAUDE.md)）
- **つないだ直後に必ず現在の姿が 1 通届きます。** だから「どこから追いつくか」を決める必要がありません
- **前と同じ姿は送りません。** 比べる鍵から `serverNow` を外してあります —— 外さないと、時計が動いただけで「変わった」ことになり、呼び出しが 1 件あるたびに関係のない数百台が起きます
- 心拍（7.9 の放置判定）は **`send` ではなく `touch`** で送ります。控えも取らず、配信も起こしません（どちらも接続の数だけ無駄が積み上がるため）
- **スタッフ向けの配信は PR 12（認証）からです。** `hub` はトピックを知らない作りなので、口を 1 つ足せば入ります

姿の組み立ては [`routes/views.ts`](apps/server/routes/views.ts) に集めてあります。**`GET` と配信が同じ関数を通る**ので、片方だけが違う姿を返すことがありません。

### サーバが画面を配る

**成果物は 1 つのコンテナのままです**（[ADR-0005](docs/adr/0005-single-container-sqlite.md)）。`apps/web` の組み上がりを `apps/server` が配ります（`WEB_DIR`。既定は `../web/dist`、コンテナでは `/app/web`）。

- **`/api/` の下だけがサーバの道**で、残りはすべて画面の 1 枚目に落ちます（SPA）
- **CSP は 2 つに分けてあります。** API は `default-src 'none'`、画面は自分の資材だけを許します
- 指紋つきの資材（`/assets/`）は 1 年、名前が固定のもの（`index.html`、`sw.js`）は毎回確かめさせます。**古い画面を配り続けないことが、実証実験でいちばん効きます**
- 組み上がっていなければ配りません。手元では Vite が配ります

### API の契約

すべての入口は [`packages/shared`](packages/shared) に Zod で宣言してあります（[開発プラン 9.7](docs/260916_plan_OpenSeat.md)）。**型は `z.infer` で導き、同じ形を手で書きません。**

- 入口の一覧は [`src/api/catalog.ts`](packages/shared/src/api/catalog.ts)。**9.7 のどの行から開いたか**と、9.7 に無いものを足した理由が書いてあります
- OpenAPI（[`docs/openapi.json`](docs/openapi.json)）は一覧から生成します。**手で書き足さないでください**

```
pnpm openapi                                      # 契約を変えたら書き出し直す
```

**`packages/shared` は画面（`apps/web`）も読みます。** Node の組み込みに触らないでください（`pnpm check:arch` が落とします）。

Phase 2 はこの手前に「Hono + SQLite + Docker + Railway が通ること」を 1 日で確かめる工程を置きました（9.13）。結果は [スパイクの報告](docs/260921_report_spike.md) にあります。**その使い捨てのコードは役目を終えて消し、`infra/` の組み立て方だけが残っています。**

## 実装の規約

実装が始まったら、[`.claude/CLAUDE.md`](.claude/CLAUDE.md) が規約の出典になります。人間の貢献者にも同じ規約が適用されます。特に次の 2 点は例外を認めません。

### 1. ビジネスロジックと整合性はモデル層に置く

コントローラー（HTTP ハンドラ）に業務判断を書かないでください。ハンドラがしてよいのは、入力の検証、実行者の特定、コマンドの組み立て、モデルへの委譲、結果の整形だけです。

判定基準は 1 つです。**コントローラーとビューを何度書き換えても、データの整合性が壊れないこと。**

### 2. `packages/core` は依存ゼロ・純粋関数

ドメインロジックは `(state, command, now) → { state, events }` の形の純粋関数です。`Date.now()`、`Math.random()`、`process.env`、I/O を使わないでください。時刻は引数で受け取ります。

これはサーバとシミュレータとテストで同じコードを使うための制約です。ロジックを二重に実装しないでください。

### 品質ゲート

lint、typecheck、テストを通してから PR を出してください。特に **不変条件の性質テスト**（1 つの席に有効なチケットは最大 1 枚、など）は必ず緑にしてください。

## 翻訳と文言

利用者に見える文字列は [`packages/shared/src/i18n`](packages/shared/src/i18n) に置きます。日本語と英語が既定で、中国語と韓国語は歓迎します。**いまあるのは日本語だけ**なので、翻訳は [`ja.ts`](packages/shared/src/i18n/ja.ts) と同じ鍵を持つファイルを 1 つ足すだけです（鍵が欠けると型エラーになります）。

文言には方針があります。**「予約」という語を使いません。** 約束できないからです。命令形を避け、理由を添えます。時間の上限は「目安」と書きます。詳しくは開発プランの 6.5 を参照してください。**「予約」が混ざっていないことはテストが見ています。**

## セキュリティ

脆弱性を見つけた場合は Issue ではなく [SECURITY.md](SECURITY.md) の手順に従ってください。

## 行動規範

[Contributor Covenant 2.1](CODE_OF_CONDUCT.md) を採用しています。

## ライセンス

貢献したコードは [Apache License 2.0](LICENSE) で公開されます。名称の扱いは [TRADEMARK.md](TRADEMARK.md) を参照してください。
