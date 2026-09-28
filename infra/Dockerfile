# OpenSeat — 単一コンテナ（開発プラン 9.13、ADR-0005）
#
# **成果物は 1 つのコンテナと SQLite だけ。** 施設や地域の IT 事業者が
# 「Docker が動く環境が 1 つ」で引き取れることが、運用費の問題を解く唯一の道
# だからである（9.1 の導入形態、14.4）。
#
# 載せるのは `apps/server`（API・配信・スケジューラ・静的配信。9.2）と、
# **そこから配る画面**（`apps/web` の組み上がり）、そして**記録を外へ写す
# Litestream**（9.11、ADR-0019）。画面やバックアップを別のサービスに分けると、
# 施設が引き取るときに「Docker が動く環境が 1 つ」では済まなくなる。
# 1 日スパイクで確かめた組み立て方をそのまま引き継いでいる。
#
#   docker build -f infra/Dockerfile -t openseat .
#   docker run --rm -p 8080:8080 -v openseat-data:/data openseat

# ---- 1. 依存を入れて組み立てる ----
FROM node:22-alpine AS build

# 組み立てるアプリ。
ARG APP=apps/server

RUN corepack enable
WORKDIR /repo

# 先にマニフェストだけを写して依存を入れる。ソースを直しただけのときに
# この層が使い回されるので、組み立てが速い。
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile

COPY tsconfig.base.json tsconfig.json ./
COPY packages/core packages/core
COPY packages/shared packages/shared
COPY apps/server apps/server
COPY apps/web apps/web

# **順序に意味がある。** 画面もサーバも、`core` と `shared` の組み上がり
# （型を含む）を読む。
RUN pnpm --filter @openseat/core build \
 && pnpm --filter @openseat/shared build \
 && pnpm --filter "./${APP}" build \
 && pnpm --filter @openseat/web build

# **本番に要るものだけを取り出す。** `--prod` で開発用の依存を落とし、
# ワークスペースの依存は実体として置かれる（`--legacy` を使わない理由）。
RUN pnpm --filter "./${APP}" --prod deploy --legacy /out

# ---- 2. 記録を写す道具を取ってくる ----
#
# **版を固定する。** 0.5 系は 0.3 系の複製から戻せないので（形式が変わった）、
# ここを勝手に上げ下げすると、手元にある複製が使えなくなる。
# Supabase Storage の自動判別は **0.5.9 以降**にしか無い。
FROM node:22-alpine AS litestream

ARG LITESTREAM_VERSION=0.5.17
# BuildKit なら `amd64` / `arm64` が入る。**入れてくれない組み立て環境もある**
# （Railway は入るとも入らないとも書いていない）ので、空なら組み立てている
# マシンの `uname -m` を使う。
ARG TARGETARCH

WORKDIR /tmp/litestream

# **配布物の名前は `x86_64` で、`amd64` ではない。** そのまま繋ぐと 404 になる。
#
# **配布元の `checksums.txt` と照合してから使う。** 鍵を持たせて走らせるものなので、
# 途中で差し替えられたものを入れない（`restore-drill.sh` が手元でする照合と同じ）。
RUN apk add --no-cache curl \
 && case "${TARGETARCH:-$(uname -m)}" in \
      amd64|x86_64) ARCH=x86_64 ;; \
      arm64|aarch64) ARCH=arm64 ;; \
      *) echo "Litestream の配布物が無いアーキテクチャです: ${TARGETARCH:-$(uname -m)}" >&2; exit 1 ;; \
    esac \
 && FILE="litestream-${LITESTREAM_VERSION}-linux-${ARCH}.tar.gz" \
 && RELEASE="https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM_VERSION}" \
 && curl -fsSLO "${RELEASE}/${FILE}" \
 && curl -fsSLO "${RELEASE}/checksums.txt" \
 && SUM="$(awk -v f="${FILE}" '$2 == f' checksums.txt)" \
 && test -n "${SUM}" \
 && echo "${SUM}" | sha256sum -c - \
 && tar -xzf "${FILE}" -C /usr/local/bin litestream \
 && /usr/local/bin/litestream version

# ---- 3. 走らせる ----
FROM node:22-alpine AS run

LABEL org.opencontainers.image.source="https://github.com/kusui26/OpenSeat"
LABEL org.opencontainers.image.licenses="Apache-2.0"

# **root から降りる道具**（下の「誰として走るか」）。`exec` と同じく自分を
# 置き換えて降りるので、合図の届き方が変わらない。
RUN apk add --no-cache su-exec

# **記録はボリュームに置く。** ここを外に出しておかないと、再デプロイのたびに
# 消える（9.13 の Railway のボリューム）。
ENV NODE_ENV=production \
    PORT=8080 \
    DB_PATH=/data/openseat.db \
    MIGRATIONS_DIR=/app/db/migrations \
    WEB_DIR=/app/web

WORKDIR /app
COPY --from=build /out ./

# **画面を同じイメージに入れる**（ADR-0005）。`WEB_DIR` がここを指している。
COPY --from=build /repo/apps/web/dist ./web

# **記録を外へ写す**（9.11）。設定が無ければ何もしない（`entrypoint.sh`）。
COPY --from=litestream /usr/local/bin/litestream /usr/local/bin/litestream
COPY infra/litestream.yml /etc/litestream.yml
COPY infra/entrypoint.sh /app/entrypoint.sh

# ## 誰として走るか（[ADR-0020](../docs/adr/0020-who-the-container-runs-as.md)）
#
# **アプリは root で走らせない。** `node` は公式イメージに元からいる非特権ユーザー。
#
# ただし `USER node` にはしない。つながれた置き場が root の持ち物だと、`node` は
# 記録を 1 行も書けずに落ち、再起動を繰り返す —— **Railway のボリュームはそう
# つながる**（公式に明記）。起動の最初の一瞬だけ root で持ち主を直し、
# `entrypoint.sh` が `node` に降りる。
RUN mkdir -p /data && chmod +x /app/entrypoint.sh && chown -R node:node /data /app

# **`VOLUME` は書かない。** Railway はこの行があると組み立てを拒む。置き場を
# つなぐのは起こす側の仕事にする（`docker-compose.yml` の `volumes`、
# `docker run -v`、Railway のボリューム）。
EXPOSE 8080

# 外形監視と、置き場のヘルスチェックの両方がこれを見る。
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# **`SIGTERM` が `node` まで届くこと。** 届かないと、再デプロイのときに記録を
# 閉じられない（9.13 の「短い停止」）。`entrypoint.sh` と `su-exec` は `exec` で
# 自分を置き換え、Litestream は受け取った合図を子へ渡す。`node` は画面が開いて
# いても 1 秒ほどで止まる（`apps/server/src/shutdown.ts`）。**画面を開いたまま
# 止めて確かめるのは `smoke.sh`** である（CI の `image` ジョブ）。
ENTRYPOINT ["/app/entrypoint.sh"]
