# 0020. コンテナは root で起こし、記録の置き場の持ち主を直してから `node` に降りる

- **状態**: Accepted
- **日付**: 2026-09-28
- **関連**: 開発プラン 9.13、[ADR-0005](0005-single-container-sqlite.md)、[ADR-0019](0019-where-to-run-it.md)

## 背景

1 日スパイクから、イメージは `USER node` で、非特権ユーザーとして走らせてきた。手元の `docker compose` では問題が出ない —— 名前付きボリュームは、初めてつないだときにイメージの `/data` の持ち主（`node`）を写し取るからである。

Railway に置く準備で、これが通らないことが分かった。

> Docker images that run as a non-root UID by default will have permissions issues when performing operations within an attached volume.
>
> （Railway のボリュームの説明）

**Railway のボリュームは root の持ち物としてつながる。** `node` のままでは記録を 1 行も書けず、起動に失敗して再起動を繰り返す。VPS でホストのディレクトリをつなぐとき（`-v /srv/openseat:/data`）も、多くは同じことが起きる。**引き渡し先の既定は国内 VPS**（ADR-0005）なので、Railway だけの問題ではない。

## 選択肢

| 案 | 内容 | 利点 | 欠点 |
|---|---|---|---|
| A | Railway に `RAILWAY_RUN_UID=0` を設定する（公式の案内） | コードを変えない | **アプリも Litestream も root で走る。** VPS のつなぎ方の問題は残る |
| B | 置き場の起動コマンドで `chown` してから起こす | 手軽 | 置き場ごとに書き分けることになる。**Railway の起動コマンドは `entrypoint.sh` を飛ばす**（複製が止まる） |
| C | **root で起こし、`entrypoint.sh` が持ち主を直して `su-exec` で `node` に降りる** | どこでも同じに動く。アプリは root で走らない。公式イメージ（postgres・redis など）と同じ定石 | 起動の最初の一瞬だけ root になる。`su-exec`（Alpine のパッケージ）が 1 つ増える |
| D | 「先に持ち主を直しておく」と手順書に書く | コードを変えない | Railway ではできない。施設の IT 担当が踏む |

## 決定

**C を採る。** コンテナは root で起き、`entrypoint.sh` が記録の置き場の持ち主を中身ごと `node` に直してから、`su-exec` で `node` に降りる。

## 理由

- **どこに置いても同じに動く。** Railway のボリューム、VPS のホストのディレクトリ、Docker の名前付きボリュームのどれでも、設定なしで書ける。**引き渡し先で、施設の IT 担当が持ち主の問題を踏まずに済む**（ADR-0005 の「引き取れること」）
- **アプリは root で走らない。** A はこれを手放す。root で動くのは、持ち主を直す 1 行と、降りる 1 行だけである
- **合図の届き方が変わらない。** `su-exec` は `exec` と同じく自分を置き換えるので、PID 1 は最後に起きるもの（Litestream か `node`）のままである。再デプロイのときに記録を閉じられるのは、`SIGTERM` がここへ届くからである
- **root のファイルが残っても治る。** `docker exec` で入ると root になるので、手で戻した記録は root の持ち物になりやすい。起こすたびに中身ごと直すので、次に起こしたときに書ける

## 結果

- イメージの既定のユーザーは root になった。**`docker exec` で入ると root である**
- `su-exec` を入れた（Alpine の `su-exec` パッケージ）
- `DB_PATH` を `/` の直下に置くと、起動を断る（`/` を丸ごと `node` の持ち物にしないため）
- `--user` で root 以外として起こしたときは、持ち主を直せない。書けなければ、分かる言葉で止まる
- **`Dockerfile` の `VOLUME` も消した。** Railway は `VOLUME` のある Dockerfile の組み立てを拒む。置き場をつなぐのは起こす側（`docker-compose.yml`、`docker run -v`、Railway のボリューム）の仕事とする
- **CI で、Railway と同じつながり方を試す。** `infra/smoke.sh` は置き場を root の持ち物にしてから起こし、アプリと Litestream が `node` で走ること、中身の持ち主が直ることを確かめる
- **見直すきっかけ**: 置き場が root での起動を許さないとき（rootless の Kubernetes など）。そのときは `--user` と置き場の持ち主を、起こす側で揃える
