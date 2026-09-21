# OpenSeat

**フードコートの「席を探す」を「順番を待つ」に置き換える、オープンソースの座席順番待ちシステム。**

センサーもカメラも専用端末も使いません。必要なのは印刷した QR コードと、利用者のスマートフォンだけです。

> **状態: Phase 0（準備・探索）。まだ実装はありません。**
> 設計は [`docs/260916_plan_OpenSeat.md`](docs/260916_plan_OpenSeat.md) にあります。実装は Phase 1（コアロジックとシミュレーション）から始まります。ロードマップは [`docs/ROADMAP.md`](docs/ROADMAP.md) を参照してください。

---

## 解決したい課題

休日のフードコートは、席が空くのを探して歩き回ることになります。いつ空くのかも分かりません。誰かが席を確保してから他の人が買いに行く分業が必要で、一人だとそれもできません。荷物を置いての席取りは慣習になっていますが、盗難やトラブルの原因にもなっています。

商業施設の側にも、席の稼働と回転が見えないという課題があります。席案内はスタッフの目視に頼っており、混雑時ほど手が回りません。

## 仕組み

```
入口                         対象席ゾーン                        スタッフ・管理
┌──────────────┐            ┌──────────────────────────┐      ┌─────────────────┐
│ 受付 QR       │ 人数を登録  │ 各席に 座席 QR ＋ 席番号      │      │ スタッフコンソール │
│              │──────────▶ │                          │      │ 管理画面          │
│ 呼び出しボード │◀────────── │ 呼び出し→席のQR→着席        │◀────▶│ ・席の状態        │
│              │ 「A-23→T-12」│ 食べ終わったら「退席」        │      │ ・設定・印刷      │
└──────────────┘            └──────────────────────────┘      └─────────────────┘
```

**利用者の体験は 4 ステップです。**

1. 入口の QR を読み、人数を入れる。10 秒で終わります。
2. 目安時間と番号を見ながら、料理を買いに行くなど自由に過ごす。
3. 席が決まると画面が変わり、音が鳴る。入口のボードにも番号が出ます。席へ行き、席の QR を読む。
4. 食べ終わったら「退席」を押す。次の人に席が届く。

**施設の体験。** 管理画面でフロア図に席を置き、対象にする席を選びます。QR 台紙とポスターを PDF で印刷して貼るだけで始められます。運用する曜日と時間帯を設定でき、時間外は自由席に戻ります。いつでも OFF にできます。

## 設計の特徴

- **予約ではなく順番待ち。** 時刻指定の予約は空席を保証できません。仮想の待ち行列に並び、空いた席が人数に合わせて割り当てられます。
- **人数に合う席へ。** 席は定員の小さい順に処理し、ロス（定員 − 人数）が最小の組を優先します。ただし一定以上長く待っている組は保護します。「なぜ後から来た 4 人組が先に案内されたのか」を一文で説明できるルールだけを採用しています。
- **現実との食い違いを前提にする。** システムに物理的な強制力はありません。退席の押し忘れも、登録せずに座る人も必ず発生します。本人の申告・次に案内された人の確認・スタッフ操作・時間経過の 4 つで回復します。
- **個人情報を取らない。** 氏名・電話番号・位置情報・カメラ画像を収集しません。人数と状態遷移の時刻だけで動きます。
- **一部の席・一部の時間帯から。** 全席を管理しようとはしません。まとまった区画をピーク時間帯だけ運用し、いつでも元に戻せます。
- **引き取れる。** 成果物は 1 つの Docker コンテナです。施設や地域の IT 事業者が `docker compose up -d` で運用を引き取れます。

## 技術構成（予定）

| 層 | 選定 |
|---|---|
| ドメインロジック | `packages/core`。純粋関数、依存ゼロ。サーバとシミュレータとテストで共有 |
| API の契約 | `packages/shared`。Zod の宣言から型と [OpenAPI](docs/openapi.json) を導く。文言もここ |
| サーバ | Hono on Node、SQLite（Drizzle ORM）、WebSocket |
| フロントエンド | React + Vite の PWA。利用者・ボード・スタッフ・管理を 1 つに |
| 配布 | 単一 Docker イメージ。Litestream で継続バックアップ |

データの整合性とアクセス権はモデル層で宣言的に定義し、機械的に検証します。コントローラーは入力の検証とコマンドの組み立てだけを行います。方針は [`.claude/CLAUDE.md`](.claude/CLAUDE.md) の第 3 章を参照してください。

## ドキュメント

| 文書 | 内容 |
|---|---|
| [開発プラン](docs/260916_plan_OpenSeat.md) | 設計と方針の唯一の出典。課題、競合分析、コアロジック仕様、アーキテクチャ、実証実験計画、コストと座組み |
| [ロードマップ](docs/ROADMAP.md) | フェーズと現在地 |
| [ADR](docs/adr/) | 設計判断の記録 |
| [開発指針](.claude/CLAUDE.md) | 実装時の規約とガードレール |

## 貢献

歓迎します。[CONTRIBUTING.md](CONTRIBUTING.md) を読んでください。現在は Phase 0 なので、コードよりも次のような貢献が役に立ちます。

- 設計へのレビューと指摘。特に [コアロジック仕様](docs/260916_plan_OpenSeat.md)（第 7 章）の穴を探してください
- 似た課題を扱った事例や先行研究の情報
- 導入できそうな施設・運営事業者の情報

## ライセンス

[Apache License 2.0](LICENSE)。名称とロゴの扱いは [TRADEMARK.md](TRADEMARK.md) を参照してください。

---

## English

**OpenSeat** replaces "hunting for a seat" with "waiting in line" at food courts. No sensors, no cameras, no dedicated hardware — just printed QR codes and the visitors' own phones.

Diners scan a QR at the entrance and enter their party size. When a table that fits them frees up, the system assigns it and calls them. They scan the QR on the table to check in, and tap once to check out when they leave.

The system collects no personal data: no names, no phone numbers, no location, no camera images. Only party sizes and state-transition timestamps.

**Status: Phase 0 (planning). No implementation yet.** The full design document is in Japanese at [`docs/260916_plan_OpenSeat.md`](docs/260916_plan_OpenSeat.md).

Licensed under [Apache License 2.0](LICENSE). See [TRADEMARK.md](TRADEMARK.md) for use of the project name.
