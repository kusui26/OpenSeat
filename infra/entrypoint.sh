#!/bin/sh
# コンテナの起こし方（開発プラン 9.11、[ADR-0019](../docs/adr/0019-where-to-run-it.md)）
#
# **複製の設定があれば Litestream の下で、無ければそのまま起こす。**
# S3 を持たない施設でも `docker compose up -d` が通ることを守る（11.4）。
#
# ## 誰として走るか（[ADR-0020](../docs/adr/0020-who-the-container-runs-as.md)）
#
# **root で起こされたら、記録の置き場の持ち主を `node` に直してから降りる。**
# Railway のボリュームは root の持ち物としてつながり（公式に明記）、VPS で
# ホストのディレクトリをつなぐときも多くはそうなる。そのまま `node` で起こすと、
# 記録を 1 行も書けずに落ち、再起動を繰り返す。
#
# **降りたあとは、アプリも Litestream も root では走らない。**
#
# ## シグナルについて
#
# `exec` で置き換えるので、**最後に起きるものが PID 1 になる。** `su-exec` も
# 自分を置き換えるので、降りても変わらない。Litestream は受け取った `SIGTERM`
# を子へ渡してから終わるので（手元で確認済み）、再デプロイのときに記録を
# 閉じられる（9.13 の「短い停止」）。
#
#     signal received, litestream shutting down
#     sending signal to exec process
#     → node が SIGTERM を受け取り、DB を閉じて終わる

set -eu

APP="node dist/src/main.js"
DATA_DIR="$(dirname "${DB_PATH}")"

# ---- 1. root なら、置き場を整えて node に降りる ----

if [ "$(id -u)" = "0" ]; then
  # `/` を丸ごと `node` の持ち物にしない。
  if [ "${DATA_DIR}" = "/" ]; then
    echo "DB_PATH はディレクトリの中に置いてください（例 /data/openseat.db）。" >&2
    exit 1
  fi
  mkdir -p "${DATA_DIR}"
  # **中身ごと直す。** `docker exec` で入ると root になるので、手で戻した記録は
  # root の持ち物になりやすい。それが残っていても、次に起こしたときに書けるように。
  chown -R node:node "${DATA_DIR}"
  exec su-exec node "$0" "$@"
fi

# ---- 2. 書けることを先に確かめる ----
#
# root 以外で起こされたとき（`docker run --user` など）は、持ち主を直せない。
# SQLite の読みにくいエラーで再起動を繰り返すより、分かる言葉で止まる。

if [ ! -w "${DATA_DIR}" ]; then
  echo "記録の置き場（${DATA_DIR}）に書き込めません（UID $(id -u) で起動しています）。" >&2
  echo "  持ち主を UID $(id -u) にするか、root で起動してください（起動時に直してから降ります）。" >&2
  exit 1
fi

# ---- 3. 複製の設定が無ければ、そのまま起こす ----

if [ -z "${LITESTREAM_REPLICA_URL:-}" ]; then
  echo "複製は設定されていません（LITESTREAM_REPLICA_URL が空）。記録はこのホストにしか残りません。"
  exec $APP
fi

# **形が違えば、分かる言葉で止まる。** R2 の画面で目立つのは `https://…` の
# エンドポイントで、宛先と取り違えやすい。そのまま Litestream に渡すと、読み
# にくいエラーで起動を繰り返すことになる。**複製できない状態では起動しない**
# （バックアップが無いことに気づかないまま運用するより、止まるほうがよい）。
case "${LITESTREAM_REPLICA_URL}" in
  s3://*|file://*|gs://*|abs://*|sftp://*) ;;
  *)
    echo "LITESTREAM_REPLICA_URL の形が正しくありません（s3:// か file:// で始めてください）。" >&2
    echo "  R2 なら: s3://<バケット名>/openseat?endpoint=<アカウントID>.r2.cloudflarestorage.com" >&2
    echo "  設定を直すか、空にして複製なしで起動してください。" >&2
    exit 1
    ;;
esac

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
