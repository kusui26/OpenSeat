/**
 * 運用パラメータ。
 *
 * 全体プラン 7.16 のパラメータ一覧（26 行・29 キー）と 1 対 1 で対応する。
 * 対応が保たれていることは `policy.test.ts` が検査する。**このファイルに
 * キーを足したら 7.16 の表にも足すこと**（CLAUDE.md 6.2）。
 *
 * 時間の単位は分。7.16 の表記に合わせてあり、CLAUDE.md の「変数名に単位を」
 * という規約にも従う。ミリ秒への変換は `minutes()` を使う。
 *
 * 既定値は「もっともらしい初期値」であって結論ではない。Phase 1 の
 * シミュレーション（全体プラン 8.2）で裏づけを取り、ADR-0007〜0010 で確定する。
 */

/** ホールドの期限が切れたときの扱い（全体プラン 7.7）。 */
export const NO_SHOW_POLICIES = ['cancel', 'requeue_once', 'requeue_back'] as const;

export type NoShowPolicy = (typeof NO_SHOW_POLICIES)[number];

/** 着席時間の上限の扱い（全体プラン 7.10）。 */
export const TIME_LIMIT_MODES = ['off', 'soft', 'hard'] as const;

export type TimeLimitMode = (typeof TIME_LIMIT_MODES)[number];

/** 空席を埋める順番を決める並び替えの鍵（全体プラン 7.6）。 */
export const TABLE_ORDER_KEYS = [
  'capacity_asc',
  'verified_free_desc',
  'admin_rank',
  'label',
] as const;

export type TableOrderKey = (typeof TABLE_ORDER_KEYS)[number];

export interface Policy {
  // ---- 受付（7.5） ----

  /**
   * 受け付ける最大人数。`null` なら対象席の最大定員から導く。
   * これを超える人数は分割登録を案内する。
   */
  readonly maxPartySize: number | null;

  /** 待ち行列の長さの安全弁。到達したら受付を一時停止する。 */
  readonly maxQueueLength: number;

  /** 1 端末あたり 1 時間に受け付ける登録の回数。悪用の抑止。 */
  readonly joinRateLimitPerHour: number;

  /** 運用終了の何分前に新規受付を止めるか。 */
  readonly joinCutoffBeforeCloseMin: number;

  /** 受付前に「それでも並びますか」を出す目安時間。 */
  readonly longWaitConfirmMin: number;

  // ---- 割当（7.6） ----

  /**
   * この分数以上長く待っている人は、ロス最小の人（best fit）より優先する。
   * `0` で厳密な先着順、`Infinity` で純粋な best fit になる。
   */
  readonly fairnessOverrideMin: number;

  /** 空席を埋める順番。先頭の鍵から順に比較する。 */
  readonly tableOrder: readonly TableOrderKey[];

  /** 呼び出し中に別の空席へ変更できるか。 */
  readonly allowTableSwap: boolean;

  /** 退席してから次の人を案内するまでの片付け猶予。 */
  readonly turnoverMin: number;

  // ---- 呼び出しとホールド（7.7） ----

  /** 呼び出してから着席確認までの猶予。 */
  readonly holdMin: number;

  /** 期限の何分前にリマインドを出すか。`holdMin` より小さいこと。 */
  readonly holdReminderBeforeMin: number;

  /** 「向かっています」を押したときに延長する時間。 */
  readonly holdExtensionMin: number;

  /** 延長できる回数。 */
  readonly maxExtensions: number;

  /** ホールドの期限が切れたときの扱い。 */
  readonly noShowPolicy: NoShowPolicy;

  // ---- 保留と放置（7.7、7.9） ----

  /** 保留を 1 回延長する時間。 */
  readonly pauseStepMin: number;

  /** 保留していられる合計時間の上限。`pauseStepMin` 以上であること。 */
  readonly pauseMaxTotalMin: number;

  /** 受付からの絶対上限。幽霊チケットを防ぐ。 */
  readonly ticketMaxAgeMin: number;

  /** 通知手段が無く、画面の接続も切れている人を放置とみなすまでの時間。 */
  readonly abandonTimeoutMin: number;

  // ---- 着席時間の上限（7.10） ----

  readonly timeLimitMode: TimeLimitMode;

  /** 上限の分数。`timeLimitMode` が `off` のときは使わない。 */
  readonly timeLimitMin: number;

  /** 待っている人がいないときは上限を評価しないか。既定は真（急かさない）。 */
  readonly limitOnlyWhenWaiting: boolean;

  /** 上限を超えてから席を「確認要」にするまでの猶予。 */
  readonly overstayGraceMin: number;

  // ---- 整合性の回復（7.11） ----

  /**
   * 滞在がこの分数を超えたら「まだご利用中ですか」を出す。
   * 施設の滞在時間分布の 90 パーセンタイルに合わせるのが目安。
   *
   * **答えが返ったら、その時刻から測り直してもう一度問いかける**（7.11 の 2 層目）。
   * 長く座る人には、この分数ごとに届く。
   */
  readonly stillHerePromptMin: number;

  /** 問いかけへの無応答を「確認要」とみなすまでの時間。 */
  readonly stillHereTimeoutMin: number;

  /** 確実な空席が無いとき、「確認要」の席を待ちの先頭に案内するか。 */
  readonly assignNeedsCheck: boolean;

  /** 無断利用の想定滞在時間。これを過ぎたら「確認要」に落とす。 */
  readonly unknownOccupancyToCheckMin: number;

  /**
   * 「確認要」のまま放置された席を自動で空席に戻すまでの時間。
   * `null` なら自動では戻さない（スタッフの確認を待つ）。
   */
  readonly needsCheckAutoFreeMin: number | null;

  // ---- 待ち時間の推定（7.13） ----

  /**
   * 想定滞在時間（7.13 の `D`）。使用中の席があと何分で空くかの見積もりに使う。
   *
   * **測った平均ではなく、そう仮定する値である。** 実測が溜まったら施設ごとに
   * 置き直す（7.13 の v1.1 は滞在時間の分布そのものを使う）。
   */
  readonly assumedStayMin: number;

  /** 待ち時間の目安を何分刻みの幅で見せるか。過度な精度を避ける。 */
  readonly etaBucketMin: number;
}

/**
 * 既定値（全体プラン 7.16）。
 *
 * 施設は 10.3 のプリセット「標準」としてこれを選ぶ。「ゆったり」「混雑対応」は
 * このオブジェクトを部分的に上書きして作る。
 */
export const DEFAULT_POLICY: Policy = {
  // 受付
  maxPartySize: null,
  maxQueueLength: 100,
  joinRateLimitPerHour: 5,
  joinCutoffBeforeCloseMin: 15,
  longWaitConfirmMin: 40,

  // 割当
  fairnessOverrideMin: 10,
  tableOrder: ['capacity_asc', 'verified_free_desc', 'admin_rank', 'label'],
  allowTableSwap: true,
  turnoverMin: 0,

  // 呼び出しとホールド
  holdMin: 7,
  holdReminderBeforeMin: 2,
  holdExtensionMin: 3,
  maxExtensions: 1,
  noShowPolicy: 'requeue_once',

  // 保留と放置
  pauseStepMin: 10,
  pauseMaxTotalMin: 45,
  ticketMaxAgeMin: 90,
  abandonTimeoutMin: 10,

  // 着席時間の上限
  timeLimitMode: 'soft',
  timeLimitMin: 60,
  limitOnlyWhenWaiting: true,
  overstayGraceMin: 15,

  // 整合性の回復
  stillHerePromptMin: 50,
  stillHereTimeoutMin: 5,
  assignNeedsCheck: true,
  unknownOccupancyToCheckMin: 40,
  needsCheckAutoFreeMin: 30,

  // 待ち時間の推定
  assumedStayMin: 35,
  etaBucketMin: 5,
};

/** 設定の誤り。どのキーが、なぜ駄目かを持つ。 */
export interface PolicyProblem {
  readonly key: keyof Policy;
  readonly message: string;
}

function problem(key: keyof Policy, message: string): PolicyProblem {
  return { key, message };
}

/** 値が数値であるキーだけを取り出す。 */
type NumericPolicyKey = {
  readonly [K in keyof Policy]: Policy[K] extends number ? K : never;
}[keyof Policy];

/**
 * 負の値を許さないキー。
 *
 * `fairnessOverrideMin` だけは `Infinity` を許す。純粋な best fit を表すため
 * （全体プラン 7.6）。それ以外は有限でなければならない。
 */
const NON_NEGATIVE_KEYS = [
  'maxQueueLength',
  'joinRateLimitPerHour',
  'joinCutoffBeforeCloseMin',
  'longWaitConfirmMin',
  'fairnessOverrideMin',
  'turnoverMin',
  'holdMin',
  'holdReminderBeforeMin',
  'holdExtensionMin',
  'maxExtensions',
  'pauseStepMin',
  'pauseMaxTotalMin',
  'ticketMaxAgeMin',
  'abandonTimeoutMin',
  'timeLimitMin',
  'overstayGraceMin',
  'stillHerePromptMin',
  'stillHereTimeoutMin',
  'unknownOccupancyToCheckMin',
  'assumedStayMin',
  'etaBucketMin',
] as const satisfies readonly NumericPolicyKey[];

/** 無限大を許すキー。 */
const INFINITY_ALLOWED: NumericPolicyKey = 'fairnessOverrideMin';

function isValidNonNegative(key: NumericPolicyKey, value: number): boolean {
  if (Number.isNaN(value)) return false;
  if (value < 0) return false;
  return Number.isFinite(value) || key === INFINITY_ALLOWED;
}

function checkNonNegative(policy: Policy): readonly PolicyProblem[] {
  return NON_NEGATIVE_KEYS.filter((key) => !isValidNonNegative(key, policy[key])).map((key) =>
    problem(
      key,
      key === INFINITY_ALLOWED ? '0 以上の数であること（Infinity は可）' : '0 以上の有限な数であること',
    ),
  );
}

function checkRelations(policy: Policy): readonly PolicyProblem[] {
  const problems: PolicyProblem[] = [];
  if (policy.holdReminderBeforeMin >= policy.holdMin) {
    problems.push(problem('holdReminderBeforeMin', 'holdMin より小さいこと（期限前に出すため）'));
  }
  if (policy.pauseMaxTotalMin < policy.pauseStepMin) {
    problems.push(problem('pauseMaxTotalMin', 'pauseStepMin 以上であること'));
  }
  if (policy.timeLimitMode !== 'off' && policy.timeLimitMin <= 0) {
    problems.push(problem('timeLimitMin', 'off 以外のモードでは 1 以上であること'));
  }
  return problems;
}

function checkBounds(policy: Policy): readonly PolicyProblem[] {
  return [...checkRequiredBounds(policy), ...checkOptionalBounds(policy)];
}

/** 0 では意味をなさない値。 */
function checkRequiredBounds(policy: Policy): readonly PolicyProblem[] {
  const problems: PolicyProblem[] = [];
  if (policy.maxQueueLength < 1) {
    problems.push(problem('maxQueueLength', '1 以上であること'));
  }
  if (policy.joinRateLimitPerHour < 1) {
    problems.push(problem('joinRateLimitPerHour', '1 以上であること'));
  }
  if (policy.etaBucketMin < 1) {
    problems.push(problem('etaBucketMin', '1 以上であること'));
  }
  // 0 にすると、使用中の席がすべて「いま空く」と見積もられる（7.13）。
  if (policy.assumedStayMin < 1) {
    problems.push(problem('assumedStayMin', '1 以上であること'));
  }
  return problems;
}

/** `null`（設定しない）を許す値。0 と取り違えないよう、別に見る。 */
function checkOptionalBounds(policy: Policy): readonly PolicyProblem[] {
  const problems: PolicyProblem[] = [];
  if (policy.maxPartySize !== null && policy.maxPartySize < 1) {
    problems.push(problem('maxPartySize', 'null か 1 以上であること'));
  }
  if (policy.needsCheckAutoFreeMin !== null && policy.needsCheckAutoFreeMin <= 0) {
    problems.push(problem('needsCheckAutoFreeMin', 'null か 1 以上であること'));
  }
  return problems;
}

function checkTableOrder(policy: Policy): readonly PolicyProblem[] {
  const { tableOrder } = policy;
  if (tableOrder.length === 0) {
    return [problem('tableOrder', '少なくとも 1 つの鍵を含むこと')];
  }
  if (new Set(tableOrder).size !== tableOrder.length) {
    return [problem('tableOrder', '同じ鍵を重複して含まないこと')];
  }
  return [];
}

/**
 * 設定の整合性を検査する。空配列なら問題なし。
 *
 * 型では表せない関係（`holdReminderBeforeMin < holdMin` など）を見る。
 * 設定を読み込む境界側で必ず呼ぶこと。
 */
export function validatePolicy(policy: Policy): readonly PolicyProblem[] {
  return [
    ...checkNonNegative(policy),
    ...checkRelations(policy),
    ...checkBounds(policy),
    ...checkTableOrder(policy),
  ];
}
