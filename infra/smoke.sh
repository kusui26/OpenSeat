#!/usr/bin/env bash
# コンテナの通し確認（開発プラン 9.13 の 1 日スパイク）。
#
# **組み上がったイメージが、本当に動くかを見る。** 受付から席の割当までが通り、
# コンテナを作り直しても記録が残ることを確かめる。後者はボリュームの確認で、
# Railway に置いたときに「再デプロイで記録が消えないか」を見るのと同じ形である。
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

start() {
  docker run -d --name "$NAME" -p "${PORT}:8080" -v "${VOLUME}:/data" \
    -e VENUE_ID=smoke "$IMAGE" >/dev/null
}

# 起きるまで待つ。健康を答えられるようになったら次へ進む。
wait_healthy() {
  for _ in $(seq 1 60); do
    if curl -fsS "${BASE}/healthz" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  fail "60 秒待っても $BASE/healthz が応答しない"
}

# 記録した入力の数。ボリュームが効いていれば、作り直しても減らない。
inputs() {
  curl -fsS "${BASE}/healthz" | node -e \
    "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).inputs))"
}

# 席の状態を並べる。
statuses() {
  curl -fsS "${BASE}/api/state" | node -e \
    "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).tables.map(t=>t.label+'='+t.status).join(' ')))"
}

# ---- 1 回目 ----

docker volume rm "$VOLUME" >/dev/null 2>&1 || true
cleanup
start
wait_healthy
echo "OK  起動して健康を答える"

curl -fsS -o /dev/null -X POST "${BASE}/join" -d "partySize=2" || fail "受付できない"
SEATS="$(statuses)"
case "$SEATS" in
  *HELD*) echo "OK  受付した組に席が割り当てられた（$SEATS）" ;;
  *)      fail "席が割り当てられていない（$SEATS）" ;;
esac

# **通らない入力を受け流さない。** 既定値で動いた結果を「指定どおり」と誤解させない。
CODE="$(curl -s -o /dev/null -w '%{http_code}' -X POST "${BASE}/join" -d 'partySize=99')"
[ "$CODE" = "400" ] || fail "範囲の外の人数を断っていない（$CODE）"
echo "OK  範囲の外の人数を断る"

BEFORE="$(inputs)"
[ "$BEFORE" -gt 0 ] || fail "記録が 1 件も無い"

# ---- 作り直して、記録が残っているか ----

cleanup
start
wait_healthy
AFTER="$(inputs)"
[ "$AFTER" -ge "$BEFORE" ] || fail "コンテナを作り直したら記録が減った（$BEFORE → $AFTER）"
echo "OK  コンテナを作り直しても記録が残る（$BEFORE → $AFTER 件）"

SEATS="$(statuses)"
case "$SEATS" in
  *HELD*) echo "OK  状態も取り戻せた（$SEATS）" ;;
  *)      fail "取り戻せていない（$SEATS）" ;;
esac

# ---- 後始末 ----

cleanup
docker volume rm "$VOLUME" >/dev/null 2>&1 || true
echo "通し確認は成功しました。"
