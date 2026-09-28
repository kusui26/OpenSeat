#!/usr/bin/env bash
# 復元のリハーサル（開発プラン 9.11、12.6）。
#
# **バックアップは「取れていること」ではなく「戻せること」で測る。** 取れている
# つもりで戻せなかった、というのがいちばんよくある壊れ方なので、**実際に消して、
# 実際に戻す。**
#
#   ./infra/restore-drill.sh            # `.env` に宛先があればそこへ、無ければ手元のディレクトリへ
#   ./infra/restore-drill.sh <URL>      # 宛先を直に指定する
#   ./infra/restore-drill.sh --dry-run  # **どこへ書くつもりかを表示して終わる**（`.env` の確認に）
#
# **鍵はコマンド行に打たないこと。** シェルの履歴に残ります。リポジトリの `.env`
# に貼っておけば、このスクリプトが自動で読みます（`.env` はコミットされません）。
#
# **本番の記録には触りません。** 使い捨ての SQLite を作り、宛先のバケットの中の
# `drill/<日時>` という使い捨ての場所へ複製し、消して、戻して、中身を数えます。
# 本番の複製がどこにあっても、同じ場所には書きません。
#
# 通れば 0、戻せなければ 1 で終わります。

set -euo pipefail

DRY_RUN=0
if [ "${1:-}" = "--dry-run" ]; then
  DRY_RUN=1
  shift
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# 試すときだけ差し替えられるようにしてある（あなたの `.env` に触らずに確かめるため）。
ENV_FILE="${OPENSEAT_ENV_FILE:-${ROOT}/.env}"

fail() {
  echo "NG  $1" >&2
  exit 1
}

# ---- `.env` を読む ----
#
# **シェルとして実行しない。** `. .env` で読むと、URL の `&` がコマンドの区切りに
# なって宛先が読み込まれず、**手元のディスクで試して「成功」と言ってしまう**
# （R2 を確かめていないのに通ったように見える）。1 行ずつ `KEY=値` として受け取る。
load_env() {
  local line key value
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"                       # Windows の改行が混ざっていても読める
    case "$line" in ''|'#'*) continue ;; esac  # 空行とコメント
    key="${line%%=*}"
    value="${line#*=}"
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    value="$(unquote "$value")"
    export "${key}=${value}"
  done < "$1"
}

# 前後の引用符を外す（`"..."` でも `'...'` でも、付けなくても同じに読める）。
unquote() {
  local value="$1"
  if [[ "$value" =~ ^\"(.*)\"$ ]] || [[ "$value" =~ ^\'(.*)\'$ ]]; then
    value="${BASH_REMATCH[1]}"
  fi
  printf '%s' "$value"
}

# ---- 宛先を決める ----
#
# **本番と同じ場所に書かない。** 利用者が宛先のパスをどう名付けていても、
# バケットの中の `drill/<日時>` に差し替える。同じ場所に別の DB を写すと、
# 本番の複製が読めなくなる。
drill_target() {
  local url="$1" stamp="$2" rest bucket query=""
  case "$url" in
    s3://*)
      rest="${url#s3://}"
      bucket="${rest%%/*}"
      bucket="${bucket%%\?*}"
      case "$url" in *\?*) query="?${url#*\?}" ;; esac
      printf 's3://%s/drill/%s%s' "$bucket" "$stamp" "$query"
      ;;
    file://*)
      printf 'file://%s/drill/%s' "$(dirname "${url#file://}")" "$stamp"
      ;;
    https://*.r2.cloudflarestorage.com*)
      # **R2 の結果画面でいちばん目立つのがこの URL なので、取り違えやすい。**
      # 正しい形を示して止まる（バケット名は分からないので、推測で直さない）。
      local host="${url#https://}"
      host="${host%%/*}"
      fail "これは R2 のエンドポイントで、宛先ではありません。.env にはこの形で書いてください:
      LITESTREAM_REPLICA_URL=s3://<バケット名>/openseat?endpoint=${host}"
      ;;
    *)
      fail "宛先の形が分かりません（s3:// か file:// で始めてください）: ${url}"
      ;;
  esac
}

# ---- Litestream を用意する ----
#
# **無ければ、`Dockerfile` と同じ版を取ってくる。** 手元と本番で版がずれると、
# 確かめたことにならない（0.5 系は 0.3 系の複製から戻せない）。取ってきたものは
# **配布元の `checksums.txt` と照合してから**使う。
ensure_litestream() {
  command -v litestream >/dev/null 2>&1 && return
  local version os arch name dir url
  version="$(grep -oE 'LITESTREAM_VERSION=[0-9.]+' "${ROOT}/infra/Dockerfile" | cut -d= -f2)"
  [ -n "$version" ] || fail "infra/Dockerfile から Litestream の版を読めません"
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch="$(uname -m)"
  [ "$arch" = "aarch64" ] && arch="arm64"
  name="litestream-${version}-${os}-${arch}.tar.gz"
  dir="${XDG_CACHE_HOME:-${HOME}/.cache}/openseat/litestream-${version}"
  if [ ! -x "${dir}/litestream" ]; then
    echo "Litestream ${version} が無いので、Dockerfile と同じ版を取ってきます（${dir}）"
    mkdir -p "$dir"
    url="https://github.com/benbjohnson/litestream/releases/download/v${version}"
    curl -fsSL -o "${dir}/${name}" "${url}/${name}" || fail "Litestream を取ってこられません（${name}）"
    curl -fsSL -o "${dir}/checksums.txt" "${url}/checksums.txt" || fail "checksums.txt を取ってこられません"
    verify_checksum "$dir" "$name"
    tar -xzf "${dir}/${name}" -C "$dir" litestream
  fi
  PATH="${dir}:${PATH}"
}

# **照合が合わなければ使わない。** 途中で差し替えられたものを、鍵を持たせて走らせない。
verify_checksum() {
  local dir="$1" name="$2" want got
  want="$(awk -v n="$name" '{ f = $2; sub(/^\*/, "", f); if (f == n) print $1 }' "${dir}/checksums.txt")"
  [ -n "$want" ] || fail "checksums.txt に ${name} がありません"
  if command -v sha256sum >/dev/null 2>&1; then
    got="$(sha256sum "${dir}/${name}" | cut -d' ' -f1)"
  else
    got="$(shasum -a 256 "${dir}/${name}" | cut -d' ' -f1)"
  fi
  if [ "$want" != "$got" ]; then
    rm -f "${dir}/${name}"
    fail "取ってきた Litestream のチェックサムが合いません（破損か、差し替えられた恐れ）"
  fi
  echo "OK  取ってきた Litestream のチェックサムが合った"
}

# **仮の値が残っていないか。** `<ACCOUNT_ID>` のまま走らせると、分かりにくい
# 名前解決の失敗になる。
refuse_placeholders() {
  local name
  for name in LITESTREAM_REPLICA_URL LITESTREAM_ACCESS_KEY_ID LITESTREAM_SECRET_ACCESS_KEY; do
    case "${!name:-}" in
      *'<'*|*'>'*) fail "${name} に、まだ仮の値（<...>）が残っています。.env を確かめてください" ;;
    esac
  done
}

if [ -f "$ENV_FILE" ]; then
  load_env "$ENV_FILE"
  echo "設定: ${ENV_FILE} を読みました（鍵の値は表示しません）"
fi
refuse_placeholders

# **Litestream は `AWS_*` を優先する。** このマシンに別の用途の `AWS_*` が
# 残っていると、`.env` の鍵ではなくそちらで繋ぎにいき、分かりにくい失敗になる。
if [ -n "${LITESTREAM_ACCESS_KEY_ID:-}" ] && [ -n "${AWS_ACCESS_KEY_ID:-}${AWS_SECRET_ACCESS_KEY:-}${AWS_SESSION_TOKEN:-}" ]; then
  echo "注意: AWS_* が設定されていたので、この確認のあいだは外します（Litestream は AWS_* を優先するため）"
  unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
fi

ROWS=500
WORK="$(mktemp -d)"
DB="${WORK}/drill.db"
RESTORED="${WORK}/restored.db"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

# 宛先の決め方: 引数 → `.env` → 手元の使い捨てディレクトリ。
if [ $# -gt 0 ]; then
  REPLICA="$(drill_target "$1" "$STAMP")"
elif [ -n "${LITESTREAM_REPLICA_URL:-}" ]; then
  REPLICA="$(drill_target "$LITESTREAM_REPLICA_URL" "$STAMP")"
else
  REPLICA="file://${WORK}/replica"
  echo "注意: 宛先が設定されていないので、手元の使い捨てディレクトリで試します。"
  echo "      **R2 などの外部の宛先は、まだ確かめていません。**"
fi
PID=""

if [ "$DRY_RUN" = 1 ]; then
  echo "宛先: ${REPLICA}"
  echo "（--dry-run なので、ここで終わります。書き込みはしていません）"
  exit 0
fi

cleanup() {
  [ -n "$PID" ] && kill "$PID" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

ensure_litestream
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
