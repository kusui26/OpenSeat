#!/usr/bin/env bash
# 再デプロイで、何秒止まるかを測る（開発プラン 9.13、[ADR-0019](../docs/adr/0019-where-to-run-it.md)）。
#
# **ボリュームを使っていると、置き場は再デプロイのたびに短く止まります。** 何秒かを
# 知らないと、「運用時間中にデプロイしない」（CLAUDE.md 8 章）がどれだけ厳しい
# 決まりなのか判断できません。
#
#   ./infra/measure-downtime.sh https://<ドメイン>
#
# **これを動かしたまま、Railway のダッシュボードで Redeploy してください。**
# 止まった時間を数え、戻ったところで終わります。Ctrl+C でいつでも止められます。

set -euo pipefail

BASE="${1:?使い方: ./infra/measure-downtime.sh https://<ドメイン>}"
EVERY=0.2

echo "${BASE}/healthz を ${EVERY} 秒ごとに見ます。"
echo "別の窓で再デプロイしてください。戻ったら止まります。（Ctrl+C で中断）"
echo

down_from=""
seen_down=0

while true; do
  if curl -fsS --max-time 2 "${BASE}/healthz" >/dev/null 2>&1; then
    if [ -n "$down_from" ]; then
      # `bc` はどこにでもあるとは限らないので、awk で引き算する。
      took="$(awk -v a="$(date +%s.%N)" -v b="$down_from" 'BEGIN { printf "%.1f", a - b }')"
      echo
      echo "戻りました。**止まっていたのは ${took} 秒**です。"
      echo
      echo "この数字を docs/260921_report_spike.md に追記してください。"
      exit 0
    fi
    printf "."
  else
    if [ -z "$down_from" ]; then
      down_from="$(date +%s.%N)"
      seen_down=1
      printf "\n落ちました（%s）" "$(date +%H:%M:%S)"
    fi
    printf "x"
  fi
  sleep "$EVERY"
done
