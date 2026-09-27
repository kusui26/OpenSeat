#!/usr/bin/env bash
# 復元のリハーサル（開発プラン 9.11、12.6）。
#
# **バックアップは「取れていること」ではなく「戻せること」で測る。** 取れている
# つもりで戻せなかった、というのがいちばんよくある壊れ方なので、**実際に消して、
# 実際に戻す。**
#
#   ./infra/restore-drill.sh        # `.env` に宛先があればそこへ、無ければ手元のディレクトリへ
#   ./infra/restore-drill.sh <URL>  # 宛先を直に指定する
#
# **鍵はコマンド行に打たないこと。** シェルの履歴に残ります。リポジトリの `.env`
# に貼っておけば、このスクリプトが自動で読みます（`.env` はコミットされません）。
#
# **本番の記録には触りません。** 使い捨ての SQLite を作り、使い捨ての置き場へ
# 複製し、消して、戻して、中身を数えます。宛先の下に `drill` を掘るので、
# 本番の複製（`openseat`）とは別の場所になります。
#
# 通れば 0、戻せなければ 1 で終わります。

set -euo pipefail

# **鍵は `.env` から読む。** コマンド行に打つと、シェルの履歴に残ってしまう。
ENV_FILE="$(cd "$(dirname "$0")/.." && pwd)/.env"
if [ -f "$ENV_FILE" ]; then
  # `KEY=値` の行だけを拾う（コメントと空行は飛ばす）。
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
  echo "設定: ${ENV_FILE} を読みました"
fi

ROWS=500
WORK="$(mktemp -d)"
DB="${WORK}/drill.db"
RESTORED="${WORK}/restored.db"
# 宛先の決め方: 引数 → `.env` → 手元の使い捨てディレクトリ。
#
# **`.env` の宛先をそのまま使わない。** 本番の複製と同じ場所を触らないよう、
# 末尾を `drill` に差し替える。
if [ $# -gt 0 ]; then
  REPLICA="$1"
elif [ -n "${LITESTREAM_REPLICA_URL:-}" ]; then
  REPLICA="$(printf '%s' "$LITESTREAM_REPLICA_URL" | sed 's#/openseat?#/drill?#; s#/openseat$#/drill#')"
else
  REPLICA="file://${WORK}/replica"
fi
PID=""

cleanup() {
  [ -n "$PID" ] && kill "$PID" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

fail() {
  echo "NG  $1" >&2
  exit 1
}

command -v litestream >/dev/null 2>&1 || fail "litestream が見つかりません（https://litestream.io/install/）"
command -v sqlite3 >/dev/null 2>&1 || fail "sqlite3 が見つかりません"

echo "宛先: ${REPLICA}"
echo "版:   $(litestream version)"

# ---- 1. 使い捨ての記録を作る ----

sqlite3 "$DB" "PRAGMA journal_mode=WAL; CREATE TABLE drill(id INTEGER PRIMARY KEY, code TEXT);" >/dev/null
echo "OK  使い捨ての SQLite を作った"

# ---- 2. 書きながら複製する ----
#
# **止まっている DB を写すのでは、リハーサルにならない。** 本番は書かれている
# 最中に写すので、ここでも書きながら回す。

litestream replicate "$DB" "$REPLICA" > "${WORK}/litestream.log" 2>&1 &
PID=$!
sleep 2
kill -0 "$PID" 2>/dev/null || { cat "${WORK}/litestream.log" >&2; fail "複製を始められない"; }

for _ in $(seq 1 "$ROWS"); do
  sqlite3 "$DB" "INSERT INTO drill(code) VALUES (hex(randomblob(8)));"
done
WROTE="$(sqlite3 "$DB" 'SELECT count(*) FROM drill;')"
[ "$WROTE" = "$ROWS" ] || fail "書き込めていない（${WROTE} 行）"
echo "OK  書きながら複製した（${ROWS} 行）"

# 写し終わるのを待つ。**急いで消すと、写る前に消したことになる。**
sleep 3
kill "$PID"; PID=""
sleep 1

# ---- 3. 消す ----
#
# ディスクが飛んだことにする。WAL も一緒に消す（残っていると戻ったように見える）。

rm -f "$DB" "${DB}-wal" "${DB}-shm"
[ ! -f "$DB" ] || fail "消せていない"
echo "OK  記録を消した（ディスクが飛んだことにする）"

# ---- 4. 戻す ----

litestream restore -o "$RESTORED" "$REPLICA" >> "${WORK}/litestream.log" 2>&1 \
  || { tail -20 "${WORK}/litestream.log" >&2; fail "戻せない"; }
[ -f "$RESTORED" ] || fail "戻したはずのファイルが無い"
echo "OK  複製から戻した"

# ---- 5. 中身を数える ----

BACK="$(sqlite3 "$RESTORED" 'SELECT count(*) FROM drill;')"
[ "$BACK" = "$ROWS" ] || fail "行が欠けている（${ROWS} → ${BACK}）"
echo "OK  中身が揃っている（${BACK} 行）"

sqlite3 "$RESTORED" 'PRAGMA integrity_check;' | grep -q '^ok$' || fail "戻した記録が壊れている"
echo "OK  戻した記録が壊れていない"

echo
echo "復元のリハーサルは成功しました。"
