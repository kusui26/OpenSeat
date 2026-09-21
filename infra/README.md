# インフラ — 組み立てと置き場

成果物は **1 つのコンテナと SQLite** だけです（[ADR-0005](../docs/adr/0005-single-container-sqlite.md)）。施設や地域の IT 事業者が「Docker が動く環境が 1 つ」で引き取れることが、運用費の問題を解く唯一の道だからです（開発プラン 9.1・14.4）。

| ファイル | 中身 |
|---|---|
| [`Dockerfile`](Dockerfile) | 単一コンテナ。組み立てと実行を 2 段に分け、非特権ユーザーで走らせる |
| [`docker-compose.yml`](docker-compose.yml) | 手元で本番と同じ形で動かす |
| [`railway.json`](railway.json) | Railway の設定（試行段階の既定の置き場。9.13） |

**いまは Phase 2 の 1 日スパイク（`apps/spike`）を載せています。** 本物のサーバができたら `Dockerfile` の `APP` を `apps/server` に差し替えます。組み立て方そのものは変わりません。結果は [スパイクの報告](../docs/260921_report_spike.md) にあります。

---

## 手元で動かす

Docker を使わずに動かせます。**まずこれが通ることを確かめてください。**

```bash
pnpm install
pnpm --filter @openseat/core build
pnpm --filter @openseat/spike build
cd apps/spike && DB_PATH=./data/spike.db node dist/main.js
```

http://localhost:8080 を開くと、受付・着席・退席ができます。落として起こし直しても、状態は戻ります（記録は `apps/spike/data/spike.db`）。

### コンテナで動かす

```bash
docker compose -f infra/docker-compose.yml up --build
```

**第三者が `docker compose up -d` だけで起動できること**は 11.4 の完了条件です。

---

## Railway に置く（9.13）

**ここから先は人の手が要ります。** アカウントの作成と支払い、ドメインの取得は、開発者本人が行ってください。

### 0. 前提

| 要るもの | 備考 |
|---|---|
| Railway のアカウント | Hobby プランは月 5 ドル（同額の利用枠込み）。14.2 の「月 1,000 円以内」に収まる見込み |
| 独自ドメイン | `openseat.jp` は未取得（Phase 0 の残件）。**取れていなければ、この手順の 5 を飛ばして Railway の既定ドメインで通せます** |

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

- Railway のダッシュボード → サービス → Settings → Volumes → Add Volume
- マウント先は **`/data`**（`Dockerfile` の `DB_PATH` がここを指しています）
- Hobby プランのボリュームは 5GB まで

### 3. 環境変数

| 変数 | 値 | 備考 |
|---|---|---|
| `VENUE_ID` | 任意（例 `spike`） | 施設の識別子 |
| `GIT_SHA` | `${{RAILWAY_GIT_COMMIT_SHA}}` | 画面に版を出すため |

`PORT` は Railway が入れるので設定しません。`DB_PATH` は `Dockerfile` の既定（`/data/openseat.db`）のままで構いません。

### 4. 置く

```bash
railway up
```

`infra/railway.json` の設定で、`infra/Dockerfile` から組み立て、`/healthz` を見て健康を判断します。

### 5. 独自ドメイン

- ダッシュボード → Settings → Networking → Custom Domain
- 表示された CNAME をドメインの DNS に設定
- **証明書は自動で発行・更新されます**（9.13）

**卓上 POP に印字するドメインはここで決まります**（7 章の「QR の偽装対策」）。後から変えると台紙を刷り直すことになるので、実証実験の前に確定させてください。

---

## 置いたあとに測ること

スパイクの目的は「通るか」を見ることですが、**通ったあとに測るべき数字が 4 つ**あります（[報告](../docs/260921_report_spike.md) の「残っている未知」）。

| 測るもの | どうやって | なぜ要るか |
|---|---|---|
| **再デプロイの停止時間** | `railway up` の最中に `/healthz` を 1 秒ごとに叩き、落ちていた秒数を数える | 9.13 の「ボリューム使用時は短い停止が入る」がどれだけかを知る。運用時間帯を避ける判断の根拠になる（CLAUDE.md 8） |
| **月額** | 1 週間置いて、ダッシュボードの Usage を見る | 14.2 の「月 1,000 円以内」に収まるか |
| **長い接続が保つか** | 画面を開いたまま 30 分放置し、`disconnected` にならないか見る | 9.2 の WebSocket が Railway のプロキシ越しに使えるか。切れるなら Phase 2 の配信方式を見直す |
| **記録が残るか** | 受付してから `railway up` し直し、記録した入力の数が減っていないか見る | ボリュームが効いているか。減っていたらマウント先が違う |

測った結果は [報告](../docs/260921_report_spike.md) に追記してください。**ここで詰まるようなら見積もりが甘いということなので、その時点で 9.3 の技術選定を見直します**（9.13）。

---

## まだ無いもの

| 無いもの | いつ |
|---|---|
| Litestream による継続バックアップ | Phase 2。S3 互換のバケットと鍵が要るので、スパイクでは試していません |
| `apps/web`（React の SPA）の同梱 | Phase 2 |
| 認証、レート制限、監査ログ | Phase 2 |
| さくらの VPS 向けの `systemd` の例 | Phase 5（引き渡しのとき。9.13 の引き渡し先の既定） |
