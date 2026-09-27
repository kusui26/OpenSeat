#!/bin/sh
# コンテナの起こし方（開発プラン 9.11、[ADR-0019](../docs/adr/0019-where-to-run-it.md)）
#
# **複製の設定があれば Litestream の下で、無ければそのまま起こす。**
# S3 を持たない施設でも `docker compose up -d` が通ることを守る（11.4）。
#
# ## シグナルについて
#
# `exec` で置き換えるので、**最後に起きるものが PID 1 になる。** Litestream は
# 受け取った `SIGTERM` を子へ渡してから終わるので（手元で確認済み）、再デプロイの
# ときに記録を閉じられる（9.13 の「短い停止」）。
#
#     signal received, litestream shutting down
#     sending signal to exec process
#     → node が SIGTERM を受け取り、DB を閉じて終わる

set -eu

APP="node dist/src/main.js"

if [ -z "${LITESTREAM_REPLICA_URL:-}" ]; then
  echo "複製は設定されていません（LITESTREAM_REPLICA_URL が空）。記録はこのホストにしか残りません。"
  exec $APP
fi

echo "複製あり。起動前に、記録が無ければ戻します。"

# **記録が無ければ複製から戻す。**
#
# 新しいホストで起こしたとき、ここだけが記録を連れてくる。すでに記録があれば
# 何もしない（`-if-db-not-exists`）。複製がまだ 1 つも無い初回も、黙って進む
# （`-if-replica-exists`）。
litestream restore \
  -config /etc/litestream.yml \
  -if-db-not-exists \
  -if-replica-exists \
  "${DB_PATH}"

exec litestream replicate -config /etc/litestream.yml -exec "$APP"
