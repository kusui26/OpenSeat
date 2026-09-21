# 0012. SQLite のドライバを `better-sqlite3` とする

- **状態**: Accepted
- **日付**: 2026-09-22
- **関連**: 開発プラン 9.3・9.13、[ADR-0005](0005-single-container-sqlite.md)、[スパイクの報告](../260921_report_spike.md) 2.2、[Phase 2 のプラン](../260921_plan_Phase2.md) PR 1

## 背景

成果物は **1 つのコンテナと SQLite** である（[ADR-0005](0005-single-container-sqlite.md)）。その SQLite をどう開くかを決めなければならない。

[1 日スパイク](../260921_report_spike.md)では Node 22 の標準 `node:sqlite` を使った。依存ゼロで動き、**組み立ては通った**。ただし読み込むたびに `ExperimentalWarning` が出る。

**いま決めるのは、ここに実証実験の記録を置くからである。** 横浜の商業施設で土日 4 日間（12 章）、20〜40 席ぶんの順番待ちが、この上に乗る。

## 選択肢

| 案 | 利点 | 欠点 |
|---|---|---|
| `node:sqlite` | **依存ゼロ。** スパイクで動作確認済み | **実験的。** 毎回 `ExperimentalWarning` が出る。**Drizzle にドライバが無い** |
| **`better-sqlite3`** | 成熟。Drizzle のいちばん枯れた経路 | ネイティブ拡張。Alpine（musl）で prebuilt が効かないと、組み立てに道具が要る |
| `@libsql/client` | prebuilt あり、Drizzle 対応 | ベンダーが 1 つ増える。SQLite そのものではなく fork |

## 決定

**`better-sqlite3` を採る。**

## 理由

**1. Drizzle に `node:sqlite` のドライバが無い。**

スキーマを唯一の出典にする（CLAUDE.md 3.2(1)）以上、Drizzle は前提である。その Drizzle 0.45 が SQLite 向けに持つ経路は `better-sqlite3` / `@libsql` / `bun:sqlite` / `d1` / `durable-sqlite` / `expo-sqlite` / `op-sqlite` / `sqlite-proxy` の 8 つで、**`node:sqlite` は無い**。スパイクで `node:sqlite` を選んだ理由（依存ゼロ）は、Drizzle を入れた時点で成り立たなくなる。

**2. Alpine で組み立ての道具が要らない。** 懸念していた欠点が、実際には無かった。

| 確かめたこと | 結果 |
|---|---|
| musl 向けの prebuilt があるか | **ある。** `linuxmusl-arm64.node` と `linuxmusl-x64.node` を同梱（全 8 種） |
| install スクリプトがあるか | **無い。** `package.json` の `scripts` に `install` も `postinstall` も無い |
| ビルドスクリプトの許可が要るか | **要らない。** `pnpm-workspace.yaml` で `better-sqlite3: false` のまま動く |

実際に `node_modules` を用意して確かめた。`pnpm approve-builds` を通さず、Alpine 相当の環境向けの prebuilt を含んだまま、その場で読み込んで `SELECT` が返る。**`node:22-alpine` のままでよく、`node:22-slim` へ逃げる必要も無い。**

**3. 実験的な API の上に実証実験の記録を置かない。** 警告が本番のログに出続けると、本物の問題が埋もれる。`node:sqlite` は「いつ変わってもおかしくない」と公式が言う層である。

**4. `@libsql` を採らなかったのは、ベンダーを増やす理由が無かったからである。** 大きさはむしろ小さい（8.4MB 対 26MB）が、SQLite そのものではなく fork であり、[ADR-0005](0005-single-container-sqlite.md) の「施設や地域の IT 事業者が引き取れる」を考えると、**ファイルがただの SQLite であるほうが引き渡しやすい**。

## 結果

- `apps/server` は `better-sqlite3@13` と `drizzle-orm@0.45` で SQLite を開く。接続と `PRAGMA` は `apps/server/db/client.ts` に閉じる
- `PRAGMA journal_mode = WAL` を投げる。**Litestream が WAL を前提にする**（9.13 のバックアップ）
- `PRAGMA foreign_keys = ON` を投げる。**SQLite は既定で外部キーを見ない。** 明示しなければ、宣言した参照がただの飾りになる
- パッケージは 26MB で、うち 16MB が 8 種類の prebuilt である。**コンテナに要るのは 1 つだけ**なので、イメージを詰めたくなったら使わない prebuilt を落とせば 14MB 減る。いまはやらない（大きさが問題になってから）
- **見直すきっかけ**: `node:sqlite` が安定版になり、Drizzle にドライバが入ったとき。そのときは依存を 1 つ減らせる。あるいは Alpine の prebuilt が壊れたとき（`node:22-slim` へ移るか、ビルドの道具を入れる）
