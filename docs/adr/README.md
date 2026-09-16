# ADR（Architecture Decision Records）

設計上の判断を 1 ファイル 1 決定で記録します。**なぜそう決めたか**を残すことが目的で、後から読んだ人（未来の自分を含む）が判断を蒸し返さずに済むようにします。

- 設計と方針の唯一の出典は [開発プラン](../260916_plan_OpenSeat.md) です。ADR はその中の**個別の判断の経緯**を保存します。
- 決定を覆す場合、既存の ADR を書き換えず、新しい ADR を追加して古いものを `Superseded` にします。
- 番号は連番。ファイル名は `NNNN-短い説明.md`。

## 一覧

| # | 決定 | 状態 | 日付 |
|---|---|---|---|
| [0001](0001-project-name-openseat.md) | プロジェクト名を OpenSeat とする | Accepted | 2026-09-16 |
| [0002](0002-license-apache-2.md) | ライセンスを Apache-2.0 とする | Accepted | 2026-09-16 |
| [0003](0003-queue-not-reservation.md) | 時刻指定の予約ではなく、順番待ちと席割当にする | Accepted | 2026-09-16 |
| [0004](0004-pure-domain-core.md) | ドメインロジックを依存ゼロの純粋関数として `packages/core` に置く | Accepted | 2026-09-16 |
| [0005](0005-single-container-sqlite.md) | 単一コンテナと SQLite を採用し、Vercel + Supabase を採らない | Accepted | 2026-09-16 |
| [0006](0006-who-pays-for-hosting.md) | 運用費は試行段階のみ開発者が持ち、継続段階は施設が持つ | Accepted | 2026-09-16 |

## テンプレート

[`template.md`](template.md) をコピーして使ってください。
