/**
 * 拒否。コマンドを適用しなかった理由。
 *
 * **利用者向けの文言はここに置かない。** `describe` は開発者が読む一文で、
 * 画面に出す言葉は Phase 2 の i18n が `code` を鍵にして作る（Phase 1 プラン 7.3）。
 * こうしておくと、文言の調整でドメインロジックに触らずに済む。
 *
 * 形は不変条件の `Violation`（`{ name, describe }`）に合わせてある。
 * 「機械が分岐する識別子」と「人が読む一文」の組、という同じ考え方である。
 */

/**
 * 拒否の理由。
 *
 * | コード | いつ返るか |
 * |---|---|
 * | `TICKET_NOT_FOUND` | 指定されたチケットが存在しない |
 * | `TABLE_NOT_FOUND` | 指定された席が存在しない |
 * | `TICKET_ALREADY_EXISTS` | 同じ ID のチケットがすでにある（受付の再送） |
 * | `PARTY_SIZE_INVALID` | 人数が整数でない |
 * | `PARTY_TOO_SMALL` | 人数が 1 未満 |
 * | `PARTY_TOO_LARGE` | 受け入れられる最大人数を超えた（7.5） |
 * | `QUEUE_FULL` | 待ち行列が `maxQueueLength` に達している（7.5） |
 * | `JOIN_CLOSED` | 新規の受付を止めている（7.5、7.14） |
 * | `NOT_ALLOWED_IN_STATE` | その状態ではその操作が起こりえない（遷移表に無い） |
 * | `BLOCKED_BY_GUARD` | 遷移はあるが、条件を満たさない |
 * | `GUARD_NOT_IMPLEMENTED` | 遷移はあるが、条件の判定がまだ書かれていない |
 * | `REASON_REQUIRED` | スタッフの取り消しに理由が無い（7.9） |
 * | `STAFF_ONLY` | 着席の記録が残っている席を、スタッフ以外が空席に戻そうとした（7.11） |
 * | `FORBIDDEN` | その役割にその操作が許されていない、または他人のチケットを相手にした（9.8） |
 * | `ACTOR_MISMATCH` | コマンドが名乗る側と、実行者の役割が食い違う（起きてはならない） |
 * | `NO_CODE_AVAILABLE` | 生きているチケットが表示コードを使い切った |
 * | `CLOCK_WENT_BACKWARD` | 渡された時刻が状態の時刻より前（起きてはならない。9.4） |
 * | `INVARIANT_VIOLATED` | 出口の検査で不変条件が破れた（起きてはならない） |
 */
export const REJECTION_CODES = [
  'TICKET_NOT_FOUND',
  'TABLE_NOT_FOUND',
  'TICKET_ALREADY_EXISTS',
  'PARTY_SIZE_INVALID',
  'PARTY_TOO_SMALL',
  'PARTY_TOO_LARGE',
  'QUEUE_FULL',
  'JOIN_CLOSED',
  'NOT_ALLOWED_IN_STATE',
  'BLOCKED_BY_GUARD',
  'GUARD_NOT_IMPLEMENTED',
  'REASON_REQUIRED',
  'STAFF_ONLY',
  'FORBIDDEN',
  'ACTOR_MISMATCH',
  'NO_CODE_AVAILABLE',
  'CLOCK_WENT_BACKWARD',
  'INVARIANT_VIOLATED',
] as const;

export type RejectionCode = (typeof REJECTION_CODES)[number];

export interface Rejection {
  readonly code: RejectionCode;
  /** 開発者が読む一文。**個人を特定しうる情報を入れないこと**（CLAUDE.md 7 章）。 */
  readonly describe: string;
}

/** 拒否を作る。 */
export function rejection(code: RejectionCode, describe: string): Rejection {
  return { code, describe };
}

/**
 * 拒否のうち、**起きてはならない**もの。
 *
 * どれも入力の誤りではなく実装の誤りである。`INVARIANT_VIOLATED` は出口の
 * 検査が破れたこと、`CLOCK_WENT_BACKWARD` は渡された時刻が戻ったこと（9.4）、
 * `ACTOR_MISMATCH` はコマンドの名乗りと実行者が食い違うこと（境界が組み立てを
 * 間違えている）。境界側はこれを利用者向けの文言に変えるのではなく、記録して
 * 調査する対象として扱うこと。
 */
export function isDefect(value: Rejection): boolean {
  return DEFECT_CODES.includes(value.code);
}

const DEFECT_CODES: readonly RejectionCode[] = [
  'INVARIANT_VIOLATED',
  'CLOCK_WENT_BACKWARD',
  'ACTOR_MISMATCH',
];
