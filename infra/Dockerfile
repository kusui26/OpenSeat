# OpenSeat — 単一コンテナ（開発プラン 9.13、ADR-0005）
#
# **成果物は 1 つのコンテナと SQLite だけ。** 施設や地域の IT 事業者が
# 「Docker が動く環境が 1 つ」で引き取れることが、運用費の問題を解く唯一の道
# だからである（9.1 の導入形態、14.4）。
#
# 載せるのは `apps/server`（API・配信・スケジューラ・静的配信。9.2）と、
# **そこから配る画面**（`apps/web` の組み上がり）。画面を別のホスティングに
# 置くと、施設が引き取るときに「Docker が動く環境が 1 つ」では済まなくなる。
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

# ---- 2. 走らせる ----
FROM node:22-alpine AS run

LABEL org.opencontainers.image.source="https://github.com/kusui26/OpenSeat"
LABEL org.opencontainers.image.licenses="Apache-2.0"

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

# **root で走らせない。** `node` は公式イメージに元からいる非特権ユーザー。
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME ["/data"]
EXPOSE 8080

# 外形監視と、置き場のヘルスチェックの両方がこれを見る。
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# **`node` を PID 1 にする。** シェル越しに起動すると `SIGTERM` が届かず、
# 再デプロイのときに記録を閉じられない（9.13 の「短い停止」）。
CMD ["node", "dist/src/main.js"]
