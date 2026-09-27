# インフラ — 組み立てと置き場

成果物は **1 つのコンテナと SQLite** だけです（[ADR-0005](../docs/adr/0005-single-container-sqlite.md)）。施設や地域の IT 事業者が「Docker が動く環境が 1 つ」で引き取れることが、運用費の問題を解く唯一の道だからです（開発プラン 9.1・14.4）。

| ファイル | 中身 |
|---|---|
| [`Dockerfile`](Dockerfile) | 単一コンテナ。組み立てと実行を分け、非特権ユーザーで走らせる |
| [`entrypoint.sh`](entrypoint.sh) | 起こし方。複製の設定があれば Litestream の下で、無ければそのまま |
| [`litestream.yml`](litestream.yml) | 記録を外へ写す設定（9.11） |
| [`restore-drill.sh`](restore-drill.sh) | **復元のリハーサル。** 実際に消して、実際に戻す |
| [`measure-downtime.sh`](measure-downtime.sh) | 再デプロイで何秒止まるかを測る |
| [`docker-compose.yml`](docker-compose.yml) | 手元で本番と同じ形で動かす |
| [`railway.json`](railway.json) | Railway の設定（試行段階の置き場。[ADR-0019](../docs/adr/0019-where-to-run-it.md)） |
| [`smoke.sh`](smoke.sh) | 組み上がったイメージの通し確認 |

載せるのは [`apps/server`](../apps/server)（API・配信・スケジューラ・静的配信）、[`apps/web`](../apps/web) の組み上がり、そして Litestream です。**全部で 1 つのイメージ**になります（[ADR-0005](../docs/adr/0005-single-container-sqlite.md)）。

**困ったときは [手順書](../docs/runbook.md) を見てください。**

---

## 手元で動かす

Docker を使わずに動かせます。**まずこれが通ることを確かめてください。**

```bash
pnpm install
SEED_TABLES=8 pnpm server
```

http://localhost:8080/healthz が答えれば動いています。落として起こし直しても施設と席は残ります（記録は `apps/server/data/openseat.db`）。

画面は http://localhost:8080/ で開きます（先に `pnpm build:apps` が要ります）。

### コンテナで動かす

```bash
docker compose -f infra/docker-compose.yml up --build
```

**第三者が `docker compose up -d` だけで起動できること**は 11.4 の完了条件です。

---

## Railway に置く（[ADR-0019](../docs/adr/0019-where-to-run-it.md)）

**ここから先は人の手が要ります。** アカウントの作成と支払い、ドメインの取得は、開発者本人が行ってください。

> **なぜ Railway なのか、いつまでなのか。**
>
> 試行段階だけの置き場です。**実証実験の前に国内 VPS へ移します**（[ADR-0019](../docs/adr/0019-where-to-run-it.md)）。
> 移すのは、そちらのほうが安く、速く（日本リージョン）、下記の 15 分の上限が無く、
> **引き渡しの予行になる**からです。ドメインを固定しておけば、移行は誰にも見えません。

### 0. 前提

| 要るもの | 費用 | 備考 |
|---|---|---|
| Railway のアカウント | **月 $5**（同額の利用枠込み） | クレジットカード |
| 独自ドメイン | 年 1,500〜2,000 円 | `openseat.jp` は 2026-09-25 時点で**空き**を確認済み |
| Cloudflare のアカウント | **0 円** | R2 の無料枠に収まります。カード登録は要ります |

```bash
npm i -g @railway/cli
railway login     # ブラウザが開きます
```

### 1. プロジェクトを作る

```bash
railway init          # プロジェクト名を聞かれます
railway link          # 既にあるプロジェクトに繋ぐ場合
```

### 2. ボリュームを付ける

**先に付けてください。** 後から付けると、それまでの記録が消えます。

- ダッシュボード → サービス → Settings → Volumes → Add Volume
- マウント先は **`/data`**（`Dockerfile` の `DB_PATH` がここを指しています）
- **Hobby プランの上限は 5GB。** この用途では桁違いに余ります

### 3. リージョンを選ぶ

**日本リージョンはありません。** 選べるのは 4 つで、最寄りは**シンガポール**（`asia-southeast1-eqsg3a`）です。

- ダッシュボード → サービス → Settings → Regions
- **Hobby で選べるかを、ここで確認してください。** 選べない表示なら、そのまま US West で構いません（実証実験までに VPS へ移すため）

### 4. 環境変数

| 変数 | 値 | 備考 |
|---|---|---|
| `VENUE_ID` | 例 `demo` | 施設の識別子 |
| `SEED_TABLES` | 例 `8` | **その施設がまだ無いときだけ**席を作る。一覧編集は PR 13 |
| `SEED_OPEN` | `true` | 作った施設を運用中にする。開始・終了の操作は PR 14 |
| `GIT_SHA` | `${{RAILWAY_GIT_COMMIT_SHA}}` | 画面に版を出すため |
| `LITESTREAM_REPLICA_URL` | 5 で作ったもの | **空なら複製しません** |
| `LITESTREAM_ACCESS_KEY_ID` | R2 の Access Key ID | |
| `LITESTREAM_SECRET_ACCESS_KEY` | R2 の Secret Access Key | **ログにも Issue にも貼らないこと** |

`PORT` は Railway が入れるので設定しません。`DB_PATH` は既定（`/data/openseat.db`）のままで構いません。

### 5. バックアップの宛先を作る（Cloudflare R2）

**0 円です。** R2 は書き込み月 100 万回まで無料で、転送も無料です。この用途は月
30 万回ほどなので、十分に収まります。

1. Cloudflare にサインアップ → R2 を有効にする（カード登録が要りますが、課金は 0 円）
2. **バケットを 1 つ作る**（例 `openseat-backup`）
3. R2 → API トークンを作る
   - 権限は **Object Read & Write**
   - **「Specify bucket」で、いま作ったバケットだけを選ぶ** ← ここが大事
   - 出てくる **Access Key ID** と **Secret Access Key** を控える（秘密のほうは一度しか出ません）
4. アカウント ID を控える（R2 のページに出ています）

**バケット 1 つに絞ること。** 漏れたときに届く範囲を、この用途だけに閉じるためです。

> **Supabase Storage を使わなかった理由。**
>
> Supabase の S3 アクセスキーは「**プロジェクト内の全バケットにフルアクセスし、
> RLS を迂回する**」と公式に明記されています。バケット単位に絞る手段がありません。
> ほかの用途と同じプロジェクトに置くと、この鍵が漏れたときに届く範囲が広すぎます。

### 5-1. `.env` に貼る

リポジトリの `.env`（コミットされません）に貼ります。

```
LITESTREAM_REPLICA_URL=s3://openseat-backup/openseat?endpoint=<ACCOUNT_ID>.r2.cloudflarestorage.com&region=auto
LITESTREAM_ACCESS_KEY_ID=<Access Key ID>
LITESTREAM_SECRET_ACCESS_KEY=<Secret Access Key>
```

### 5-2. 置く前に、復元を試す

```bash
./infra/restore-drill.sh
```

`.env` を自動で読みます。**鍵をコマンド行に打たないでください**（シェルの履歴に残ります）。

**本番の記録には触りません。** 使い捨ての SQLite を作り、書きながら複製し、消して、
戻して、中身を数えます（宛先の末尾は `drill` に差し替わります）。

### 6. 置く

```bash
railway up
```

### 7. 独自ドメイン

- ダッシュボード → Settings → Networking → Custom Domain
- 表示された CNAME をドメインの DNS に設定
- 証明書は自動で発行・更新されます

**卓上 POP に印字するドメインはここで決まります**（7 章の「QR の偽装対策」）。**後から変えると台紙を刷り直すことになります。** 置き場は半日で移せますが、刷った紙は移せません。

### 8. 監視

**外形監視**（UptimeRobot など。無料枠で足ります）。

| 見るもの | 設定 |
|---|---|
| 生きているか | `https://<ドメイン>/healthz` を 5 分ごと |
| 壊れていないか | **同じ URL で、`"tickFailures":0` を含むことを条件にする**（キーワード監視） |

2 つめが効きます。`tickFailures` が 0 でなければ**実装の誤りが出ている**ので、生きていても知りたい。エラー通知の仕組み（Sentry 互換）を別に立てなくても、これで当面は足ります。

通知先は、当日その場で見られるもの（携帯のメールや通知アプリ）にしてください。

---

## 15 分で接続が切れること

**Railway は HTTP リクエストを 15 分で切ります。** 公式ドキュメントに明記されています。

> HTTP requests can run for up to 15 minutes if data keeps transferring … Websocket connections are exempt from these duration and inactivity limits.

**配信（SSE）はこの上限を受けます。** ただし[設計がこれを吸収しています](../docs/adr/0018-server-sent-events.md) —— つなぎ直すたびにサーバが現在の姿を送るので、利用者に見えるのは**約 1 秒の遅れ**だけです。

**国内 VPS へ移せば、この上限は消えます。**

---

## 置いたあとに測ること

**4 つあります**（[ADR-0019](../docs/adr/0019-where-to-run-it.md)）。測った結果は[スパイクの報告](../docs/260921_report_spike.md)に追記してください。

| 測るもの | どうやって |
|---|---|
| **再デプロイの停止時間** | `./infra/measure-downtime.sh https://<ドメイン>` を動かしたまま、別の窓で `railway up` |
| **月額** | 1 週間置いて、ダッシュボードの Usage を見る |
| **長い接続の実挙動** | 画面を開いたまま 30 分放置し、15 分で切れて 1 秒で戻ることを確かめる |
| **記録が残るか** | 受付してから `railway up` し直し、チケットが残っているか見る |

**2 つめが大事です。** 計画書 9.1（月 1,500 円）と 14.2（月 1,000 円）が食い違ったままなので、実測で直します。

---

## まだ無いもの

| 無いもの | いつ |
|---|---|
| **全席解放の入口** | PR 12（認証）。ドメインには実装済みだが、叩く道がまだ無い。それまでは[掲示 → 自由席](../docs/runbook.md)で代替する |
| スタッフ・管理の画面 | PR 12〜14 |
| 座席 QR の台紙（印刷） | PR 13 |
| 通知（Web Push・LINE） | PR 16 |
| 国内 VPS 向けの `systemd` の例 | **実証実験の前**（[ADR-0019](../docs/adr/0019-where-to-run-it.md)）。Phase 5 の引き渡し手順を前倒しで兼ねる |
| エラー通知（Sentry 互換） | 当面は `/healthz` のキーワード監視で代替する（上記 8） |
