#!/usr/bin/env bash
# コンテナの通し確認。
#
# **組み上がったイメージが、本当に動くかを見る。** マイグレーションが当たって
# 施設が立ち上がること、そして**コンテナを作り直しても記録が残ること**を確かめる。
# 後者はボリュームの確認で、Railway に置いたときに「再デプロイで記録が消えないか」
# を見るのと同じ形である（9.13）。
#
#   ./infra/smoke.sh [イメージ名]
#
# 通れば 0、詰まれば 1 で終わる。

set -euo pipefail

IMAGE="${1:-openseat:ci}"
NAME="openseat-smoke"
VOLUME="openseat-smoke-data"
PORT=8099
BASE="http://127.0.0.1:${PORT}"

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

fail() {
  echo "NG  $1" >&2
  docker logs "$NAME" 2>&1 | tail -20 >&2 || true
  exit 1
}

# 席の数を変えて起こせるようにしてある。**2 回目は席の数を変えて起こす**ので、
# 記録が残っていれば「作り直していない」ことが席の数に出る。
start() {
  docker run -d --name "$NAME" -p "${PORT}:8080" -v "${VOLUME}:/data" \
    -e VENUE_ID=smoke -e SEED_TABLES="$1" -e SEED_OPEN=true "$IMAGE" >/dev/null
}

# 起きるまで待つ。健康を答えられるようになったら次へ進む。
wait_healthy() {
  for _ in $(seq 1 60); do
    if curl -fsS "${BASE}/healthz" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  fail "60 秒待っても $BASE/healthz が応答しない"
}

# `/healthz` の 1 項目を読む。
field() {
  curl -fsS "${BASE}/healthz" | node -e \
    "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s)['$1']))"
}

# ---- 1 回目: 何も無いところに 4 席で起こす ----

docker volume rm "$VOLUME" >/dev/null 2>&1 || true
cleanup
start 4
wait_healthy
echo "OK  起動して健康を答える"

[ "$(field ok)" = "true" ] || fail "施設を読み出せていない"
[ "$(field migrations)" -gt 0 ] || fail "マイグレーションが当たっていない（$(field migrations) 件）"
echo "OK  マイグレーションが当たっている（$(field migrations) 件）"

TABLES="$(field tables)"
[ "$TABLES" = "4" ] || fail "席が 4 つ作られていない（$TABLES）"
echo "OK  施設と席ができた（$TABLES 席）"

# ---- 受付から、チケットを読むまで（9.7） ----

SECRET="smoke-secret-0123456789"
JOINED="$(curl -fsS -X POST "${BASE}/api/v/smoke/tickets" \
  -H 'content-type: application/json' \
  -H 'idempotency-key: smoke-join-0001' \
  -H 'x-openseat-client: smoke-device-0123456789' \
  -d "{\"partySize\":2,\"secret\":\"${SECRET}\"}")" || fail "受付できない"

# **秘密パラメータが返しに混ざっていないこと**（9.8）。
case "$JOINED" in
  *"$SECRET"*) fail "返しに秘密パラメータが混ざっている" ;;
esac
echo "OK  受付できた（返しに秘密は混ざっていない）"

TICKET="$(printf '%s' "$JOINED" | node -e \
  "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).ticket.id))")"
[ -n "$TICKET" ] || fail "チケットの識別子が返っていない"

CODE="$(curl -s -o /dev/null -w '%{http_code}' "${BASE}/api/t/${TICKET}?k=${SECRET}")"
[ "$CODE" = "200" ] || fail "本人がチケットを読めない（$CODE）"
echo "OK  本人はチケットを読める"

CODE="$(curl -s -o /dev/null -w '%{http_code}' "${BASE}/api/t/${TICKET}?k=wrong-secret-000000")"
[ "$CODE" = "403" ] || fail "他人がチケットを読めてしまう（$CODE）"
echo "OK  他人は読めない"

# ---- 2 回目: 席の数を変えて作り直す ----
#
# **記録が残っていれば、施設はもうあるので作り直さない。** 席は 4 つのままになる。
# ボリュームが効いていなければ、空から 8 席で作り直されて 8 になる。

cleanup
start 8
wait_healthy

AFTER="$(field tables)"
[ "$AFTER" = "4" ] || fail "コンテナを作り直したら記録が消えた（席 $TABLES → $AFTER）"
echo "OK  コンテナを作り直しても記録が残る（席 $AFTER のまま）"

CODE="$(curl -s -o /dev/null -w '%{http_code}' "${BASE}/api/t/${TICKET}?k=${SECRET}")"
[ "$CODE" = "200" ] || fail "作り直したらチケットが読めなくなった（$CODE）"
echo "OK  作り直してもチケットを読める"

[ "$(field venue)" = "smoke" ] || fail "施設が入れ替わっている（$(field venue)）"
echo "OK  同じ施設を読み戻している"

# ---- 後始末 ----

cleanup
docker volume rm "$VOLUME" >/dev/null 2>&1 || true
echo "通し確認は成功しました。"
