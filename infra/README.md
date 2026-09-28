# インフラ — 組み立てと置き場

成果物は **1 つのコンテナと SQLite** だけです（[ADR-0005](../docs/adr/0005-single-container-sqlite.md)）。施設や地域の IT 事業者が「Docker が動く環境が 1 つ」で引き取れることが、運用費の問題を解く唯一の道だからです（開発プラン 9.1・14.4）。

| ファイル | 中身 |
|---|---|
| [`Dockerfile`](Dockerfile) | 単一コンテナ。組み立てと実行を分け、アプリは非特権ユーザーで走らせる |
| [`entrypoint.sh`](entrypoint.sh) | 起こし方。置き場の持ち主を直して `node` に降り、複製の設定があれば Litestream の下で起こす |
| [`litestream.yml`](litestream.yml) | 記録を外へ写す設定（9.11） |
| [`restore-drill.sh`](restore-drill.sh) | **復元のリハーサル。** 実際に消して、実際に戻す |
| [`measure-downtime.sh`](measure-downtime.sh) | 再デプロイで何秒止まるかを測る |
| [`docker-compose.yml`](docker-compose.yml) | 手元で本番と同じ形で動かす |
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

### 誰として走るか

**コンテナは root で起き、記録の置き場（`/data`）の持ち主を `node` に直してから降ります**（[ADR-0020](../docs/adr/0020-who-the-container-runs-as.md)）。アプリも Litestream も root では走りません。

ホストのディレクトリをつなぐとき（`-v /srv/openseat:/data`）も、持ち主を気にする必要はありません。`--user` を付けて root 以外で起こす場合だけは、持ち主を直せないので、先にそのユーザーの持ち物にしておいてください（書けなければ、そう言って止まります）。

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
| Railway のアカウント（Hobby） | **月 $5**（同額の利用枠込み） | クレジットカード。**GitHub でサインアップ**すると、リポジトリをつなぐのが楽です |
| Cloudflare のアカウント | **0 円** | バックアップの宛先（R2）。カード登録は要ります |
| 独自ドメイン | 年 1,500〜2,000 円 | `openseat.jp` を取得済み（2026-09-26。DNS は Xserver） |

**Railway の設定は画面で行い、コードには置きません。** Railway の設定ファイル（`railway.json`）は非推奨になり、既存のサービスでも **2026-12-01 で読まれなくなります**（公式の告知）。以前ここにあった `infra/railway.json` は削除しました —— 置き場所が `infra/` なので最初から読まれておらず、もし読まれていたら、`startCommand` が `entrypoint.sh` を飛ばして**複製が止まる**ものでした。

### 1. バックアップの宛先を作る（Cloudflare R2）

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

### 1-1. `.env` に貼る

リポジトリの `.env`（コミットされません）に貼ります。

```
LITESTREAM_REPLICA_URL=s3://openseat-backup/openseat?endpoint=<ACCOUNT_ID>.r2.cloudflarestorage.com
LITESTREAM_ACCESS_KEY_ID=<Access Key ID>
LITESTREAM_SECRET_ACCESS_KEY=<Secret Access Key>
```

### 1-2. 置く前に、復元を試す

```bash
./infra/restore-drill.sh --dry-run   # まず、どこへ書くつもりかを確かめる
./infra/restore-drill.sh             # 実際に試す
```

**Litestream を入れる必要はありません。** 無ければ `Dockerfile` と同じ版を取ってきて、
配布元のチェックサムと照合してから使います（手元と本番で版をそろえるため）。

`.env` を自動で読みます。**鍵をコマンド行に打たないでください**（シェルの履歴に残ります）。

**`--dry-run` で `宛先: s3://openseat-backup/drill/...` と出ることを必ず確かめて
ください。** `file://` と出たら `.env` が読めていません —— そのまま走らせても
手元のディスクで試すだけで、R2 は確かめたことになりません。

**本番の記録には触りません。** 使い捨ての SQLite を作り、バケットの中の
`drill/<日時>` へ書きながら複製し、消して、戻して、中身を数えます。試したあとの
`drill/` は、R2 の画面からいつ消しても構いません。

### 2. サービスを作る

1. Railway のダッシュボードで **New Project** → **Deploy from GitHub repo** → **`kusui26/OpenSeat`**
   - 初めてなら、Railway の GitHub アプリに、このリポジトリへのアクセスを許可します
2. **すぐに組み立てが始まりますが、失敗して構いません。** まだ Dockerfile の場所を
   教えていないためです。3 と 4 を済ませてから置き直します

**以後、`main` に入ったものがそのまま本番に出ます**（CLAUDE.md 6 章）。

### 3. サービスの設定（この順で）

**先にリージョンを決めてから、ボリュームを付けてください。** ボリュームはリージョンに
属していて、後からリージョンを変えると、ボリュームの引っ越しのあいだ止まります。

| # | どこで | 何を | なぜ |
|---|---|---|---|
| 1 | Settings → **Regions** | **Southeast Asia（Singapore）**、台数は **1** | 最寄り。日本リージョンはありません |
| 2 | ⌘K、またはキャンバスの右クリック → **Volume** | つなぐ先はこのサービス、マウント先は **`/data`** | 記録の置き場（`DB_PATH` がここを指す）。Hobby の上限は 5GB で、桁違いに余ります |
| 3 | Settings → **Healthcheck Path** | **`/healthz`** | 起きたことを確かめてから切り替える |
| 4 | Settings → **Custom Start Command** | **空のまま** | 入れると `entrypoint.sh` が飛ばされ、**複製が止まる** |
| 5 | Settings → **Wait for CI** | **オン** | CI が落ちた版を本番に出さない |
| 6 | Settings → **Serverless** | **オフ**（既定） | 眠ると、10 秒ごとに時刻を進める処理も止まる |

**台数は 1 のままにしてください。** 施設ごとに 1 つのアクターが状態を持つ作りで（9.4）、
そもそもボリュームを付けたサービスは複数台にできません。

### 4. 変数を入れる

Variables → **Raw Editor** に、次をまとめて貼ります。

```
RAILWAY_DOCKERFILE_PATH=/infra/Dockerfile
RAILWAY_DEPLOYMENT_DRAINING_SECONDS=10
VENUE_ID=demo
SEED_TABLES=8
SEED_OPEN=true
GIT_SHA=${{RAILWAY_GIT_COMMIT_SHA}}
```

続けて、**リハーサルが通った `.env` から `LITESTREAM_*` の 3 行**を貼ります。
次のようにすると、鍵を画面に出さずに写せます（macOS）。

```bash
grep '^LITESTREAM_' .env | pbcopy
```

| 変数 | 値 | なぜ |
|---|---|---|
| `RAILWAY_DOCKERFILE_PATH` | `/infra/Dockerfile` | Dockerfile がリポジトリの直下に無いため |
| `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` | `10` | **既定は 0 秒**で、終了の合図の直後に強制終了される。記録を閉じる猶予を与える（アプリは約 1 秒で止まる） |
| `VENUE_ID` | 例 `demo` | 施設の識別子 |
| `SEED_TABLES` | 例 `8` | **その施設がまだ無いときだけ**席を作る。一覧編集は PR 13 |
| `SEED_OPEN` | `true` | 作った施設を運用中にする。開始・終了の操作は PR 14 |
| `GIT_SHA` | `${{RAILWAY_GIT_COMMIT_SHA}}` | 画面と `/healthz` に版を出す |
| `LITESTREAM_REPLICA_URL` | `.env` から | **空なら複製しません** |
| `LITESTREAM_ACCESS_KEY_ID` | `.env` から | |
| `LITESTREAM_SECRET_ACCESS_KEY` | `.env` から | **ログにも Issue にも貼らないこと** |

`PORT` は Railway が入れるので設定しません。`DB_PATH` も既定（`/data/openseat.db`）の
ままにします。**手元向けの値（`DB_PATH=./data/...` など）を写すと、記録がボリュームの
外に置かれ、再デプロイで消えます。**

**`LITESTREAM_*` を手で打ち直さないでください。** R2 の画面で目立つ `https://…` の
エンドポイントを宛先に入れてしまいがちです（その場合、コンテナは形が違うと言って
起動しません）。

### 5. 置いて、確かめる

変数を保存すると、画面の上に変更を反映するボタン（**Deploy**）が出ます。押すと組み立て直します。

**Deploy Logs に、次の順で出れば動いています。**

```
複製あり。起動前に、記録が無ければ戻します。
施設 demo を作りました（席 8）
画面を /app/web から配ります
OpenSeat を 8080 で待ち受けます（記録: /data/openseat.db）
```

ポートの数字は Railway が決めるので、8080 でなくても構いません。**`記録: /data/openseat.db` であること**を確かめてください（ボリュームの中に書いている）。

| 出たもの | 意味 |
|---|---|
| `複製は設定されていません` | `LITESTREAM_*` が入っていない。**このまま運用しないこと** |
| `LITESTREAM_REPLICA_URL の形が正しくありません` | 4 の貼り方を確かめる |
| 組み立てのログに Dockerfile の手順（`FROM node:22-alpine`）が出ない | `RAILWAY_DOCKERFILE_PATH` が効いていない |

### 6. 公開する URL を作る

Settings → **Networking** → **Generate Domain**。`https://<名前>.up.railway.app` ができます。
ポートは自動で見つけます（聞かれたら、ログの「待ち受けます」の数字を入れる）。

**ブラウザで `/healthz` を開き、`"ok":true` と `"tickFailures":0` を確かめてください。**
受付の画面は `/v/demo` です。

### 7. 独自ドメイン

**卓上 POP に印字するドメインはここで決まります**（7 章の「QR の偽装対策」）。**後から
変えると台紙を刷り直すことになります。** 置き場は半日で移せますが、刷った紙は移せません。

Settings → **Networking** → **Custom Domain**。Railway が示す **CNAME と TXT の 2 つ**を
DNS に足します（**TXT が無いと 404 になります**）。証明書は、DNS を足してから 1 時間
以内に自動で発行されます。Hobby はサービスあたり 2 つまでです。

| 使う名前 | DNS | 手間 | VPS へ移すとき |
|---|---|---|---|
| サブドメイン（例 `app.openseat.jp`） | Xserver のまま | CNAME と TXT を足すだけ | CNAME を A に替える |
| `openseat.jp` そのもの | **Cloudflare に移す**（無料） | ネームサーバーの変更が要る | A に替える |

**`openseat.jp` そのものを Railway に向けるには、DNS を Cloudflare に移す必要が
あります。** 根のドメインに CNAME を置くには「CNAME の平坦化」が要り、Xserver の DNS は
Railway の対応表にありません（対応しているのは Cloudflare・DNSimple・Namecheap・bunny.net）。
移したら、**Cloudflare のプロキシは切っておく**（DNS only）のが単純です。通すなら
SSL/TLS を **Full** にします（Full (strict) では動きません）。

### 8. 監視

**外形監視**（UptimeRobot など。無料枠で足ります）。

| 見るもの | 設定 |
|---|---|
| 生きているか | `https://<ドメイン>/healthz` を 5 分ごと |
| 壊れていないか | **同じ URL で、`"tickFailures":0` を含むことを条件にする**（キーワード監視） |

2 つめが効きます。`tickFailures` が 0 でなければ**実装の誤りが出ている**ので、生きていても知りたい。エラー通知の仕組み（Sentry 互換）を別に立てなくても、これで当面は足ります。

通知先は、当日その場で見られるもの（携帯のメールや通知アプリ）にしてください。

**Railway のヘルスチェックは、置いた直後に 1 回見るだけです**（公式に明記）。動いている
あいだの見張りにはならないので、外形監視は省けません。

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
| **再デプロイの停止時間** | `./infra/measure-downtime.sh https://<ドメイン>` を動かしたまま、ダッシュボードで **Redeploy** |
| **月額** | 1 週間置いて、ダッシュボードの Usage を見る |
| **長い接続の実挙動** | `time curl -sN https://<ドメイン>/api/v/demo/stream -o /dev/null` が **15 分前後で終わる**こと。画面を開いたまま放置し、切れても 1 秒ほどで戻ること |
| **記録が残るか** | 受付してから **Redeploy** し、`/healthz` の `tickets` とチケットの画面が残っているか見る |

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
