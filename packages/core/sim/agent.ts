/**
 * 利用者の振る舞い。
 *
 * **確率的な判断はすべてここに置く。** `packages/core` は完全に決定的で、
 * 乱数を必要としない（ADR-0004）。「この人はノーショーする」「30 分で帰る」と
 * いう判断はここが下し、core にはコマンド、または **何も起きないこと** として
 * 現れる。Phase 2 のサーバでは、それが実際の利用者の操作になる。
 *
 * ## 1 組の性質は、到着の時点でまとめて決める
 *
 * 人数・滞在時間・歩く速さ・ノーショーの目・退席を申告するか。すべてを
 * **その組だけの乱数の流れ**（`streamFor(seed, 'party', index)`）から引く。
 * 方針を取り替えても「何組目の誰がどんな人か」が変わらないので、比較で見える
 * 差が方針の差だけになる（`rng.ts` の「共通乱数」）。
 *
 * ノーショーだけは、決めるのが呼び出しの時点になる。8.1 が「待ち時間が長いほど
 * 上昇」と言っているためで、待ち時間は呼ばれるまで分からない。そこで
 * **一様乱数（目）だけを先に引いておき、比べる相手を呼び出しのときに決める。**
 * こうすれば、待ち時間が変わっても「その人が引いた目」は変わらない。
 *
 * ## モデル化していないこと
 *
 * 譲る（`PASS`）と席の変更（`SWAP_TABLE`）、保留（`PAUSE`）、取り消し（`CANCEL`）、
 * 人数の変更、心拍。どれも 8.1 に率が無いためである。**このうち取り消しと心拍を
 * 出さないことは、測るときに効く。** 自発的な取り消しも放置（7.9）も起こらないので、
 * 8.3 が求める「放置・キャンセルの率」は構造的に 0 になる（PR 14 で扱う）。
 */

import type { DurationMs, Timestamp } from '../src/index.js';
import { minutes } from '../src/index.js';
import { bernoulli, discrete, logNormal, sigmaFromP90 } from './distributions.js';
import type { Rng } from './rng.js';
import { streamFor } from './rng.js';
import type { Scenario } from './scenario.js';

/**
 * 1 組の性質。到着の時点で決まり、あとは変わらない。
 *
 * 「どう振る舞うか」だけを持ち、「いまどうなっているか」は core の状態が持つ。
 */
export interface Party {
  /** 何組目か。チケットの ID とテストの読みやすさに使う。 */
  readonly index: number;
  readonly ticketId: string;
  readonly arriveAt: Timestamp;
  readonly partySize: number;
  /** 着席してから帰るまで。 */
  readonly stay: DurationMs;
  /** 呼び出されてから席に着くまで。長いと間に合わない。 */
  readonly walk: DurationMs;
  /**
   * ノーショーの目。0 以上 1 未満。
   * 呼び出しの時点で、そのときの率と比べて決める（`decidesNoShow`）。
   */
  readonly noShowRoll: number;
  /**
   * 退席を申告するか。
   *
   * 申告しない人の席は、整合性の回復（7.11）が拾うまで使用中のまま残る。
   * 「まだご利用中ですか」に答えるかどうかも、この 1 つで決めている
   * （8.1 が同じ「アプリに反応するか」で括っているため）。
   */
  readonly reportsCheckout: boolean;
  /**
   * 登録をやめる目（7.5 の 5）。0 以上 1 未満。
   *
   * 受付の前に出る目安（7.13）が `long_wait_confirm_min` を超えたとき、この目と
   * `balkShare` を比べて決める。**目だけを先に引いておく**のはノーショーと同じ
   * 理由で、目安は到着してみるまで分からないためである。
   */
  readonly balkRoll: number;

  /**
   * 画面を開いたままにせず、通知で受け取るか。
   *
   * **常に真にしてある。** 偽にすると放置の判定（7.9）が働き、心拍を出さない
   * この模型では全員が `abandon_timeout_min` で消えてしまう。心拍を出すか、
   * 画面を閉じる人を別に置くかを決めるまでは真のままにする。そのぶん
   * **放置は 1 件も起きない**ので、8.3 の放置率を測るときはここから手を入れる。
   */
  readonly hasNotificationChannel: boolean;
}

/** 滞在時間の中央値。人数が多いほど長い（8.1）。 */
function stayMedian(scenario: Scenario, partySize: number): DurationMs {
  const { medianMin, largePartyFrom, largePartyMedianMin } = scenario.stay;
  return minutes(partySize >= largePartyFrom ? largePartyMedianMin : medianMin);
}

/**
 * 到着した 1 組を作る。
 *
 * 乱数を引く順序が、この組の性質を決める。**順序を変えると同じシードでも別人に
 * なる**ので、足すときは末尾に足すこと。
 */
export function createParty(
  seed: number,
  index: number,
  arriveAt: Timestamp,
  scenario: Scenario,
): Party {
  const rng: Rng = streamFor(seed, 'party', index);
  const partySize: number = discrete(rng, scenario.partySizes) ?? 1;
  return {
    index,
    ticketId: `p${String(index).padStart(4, '0')}`,
    arriveAt,
    partySize,
    ...drawTraits(rng, scenario, partySize),
  };
}

/** その組の振る舞いを決める性質。**足すときは末尾に足すこと**（順序が中身を決める）。 */
type PartyTraits = Pick<
  Party,
  'stay' | 'walk' | 'noShowRoll' | 'reportsCheckout' | 'balkRoll' | 'hasNotificationChannel'
>;

function drawTraits(rng: Rng, scenario: Scenario, partySize: number): PartyTraits {
  return {
    stay: Math.round(logNormal(rng, stayMedian(scenario, partySize), scenario.stay.sigma)),
    walk: Math.round(drawWalk(rng, scenario)),
    noShowRoll: rng.next(),
    reportsCheckout: bernoulli(rng, scenario.checkoutReportRate),
    balkRoll: rng.next(),
    hasNotificationChannel: true,
  };
}

/**
 * 目安を見て、登録をやめるか（7.5 の 5）。
 *
 * 7.5 は「現在 40 分以上お待ちいただく見込みです。登録しますか？」を出すと
 * している。**やめる割合は 8.1 に無い**ので、シナリオの値（初期値 0.5）を使う。
 * 現地観察でも測れないため、実証実験の登録率から逆算することになる。
 *
 * **先に引いておいた目と比べるだけ**なので、ここで乱数は引かない。
 */
export function decidesToBalk(party: Party, estimateMin: number, scenario: Scenario): boolean {
  return estimateMin > scenario.policy.longWaitConfirmMin && party.balkRoll < scenario.balkShare;
}

/** 呼び出しから着席までの時間。中央値と p90 から σ を導く（8.1）。 */
function drawWalk(rng: Rng, scenario: Scenario): DurationMs {
  const median: DurationMs = minutes(scenario.walk.medianMin);
  return logNormal(rng, median, sigmaFromP90(median, minutes(scenario.walk.p90Min)));
}

/**
 * 呼ばれたときに、その人がノーショーするか。
 *
 * 待ち時間が `longWaitFromMin` を超えていれば高いほうの率を使う（8.1）。
 * **先に引いておいた目と比べるだけ**なので、ここで乱数は引かない。
 */
export function decidesNoShow(party: Party, waited: DurationMs, scenario: Scenario): boolean {
  const { baseRate, longWaitFromMin, longWaitRate } = scenario.noShow;
  const rate: number = waited > minutes(longWaitFromMin) ? longWaitRate : baseRate;
  return party.noShowRoll < rate;
}

/**
 * 登録せずに席へ向かう人（8.1「無断利用」、7.12「飛び込み」）。
 *
 * 座席 QR を読むかどうかで、その後がまったく変わる。
 *
 * - **読む**: 飛び込み着席として登録される。占有が正確になり、呼び出しの
 *   事故も起きない（7.12 の狙い）
 * - **読まない**: システムからは空席に見えたまま席が使われる。そこへ案内
 *   された人は「誰かが座っています」と報告することになる（7.8 の 10 行目）
 */
export interface Sitter {
  readonly index: number;
  readonly ticketId: string;
  readonly arriveAt: Timestamp;
  readonly partySize: number;
  readonly stay: DurationMs;
  /** 座席 QR を読むか。読まなければゴーストになる。 */
  readonly scans: boolean;
  /** 退席を申告するか。登録した人と同じ率で引く。 */
  readonly reportsCheckout: boolean;
}

/**
 * 登録せずに席へ向かう 1 組を作る。
 *
 * 到着した組（`createParty`）とは別の流れから引く。無断利用の率を変えても、
 * 受付から並ぶ人の性質が 1 つも動かないようにするためである（共通乱数）。
 */
export function createSitter(
  seed: number,
  index: number,
  arriveAt: Timestamp,
  scenario: Scenario,
): Sitter {
  const rng: Rng = streamFor(seed, 'sitter', index);
  const partySize: number = discrete(rng, scenario.partySizes) ?? 1;
  return {
    index,
    ticketId: `w${String(index).padStart(4, '0')}`,
    arriveAt,
    partySize,
    stay: Math.round(logNormal(rng, stayMedian(scenario, partySize), scenario.stay.sigma)),
    scans: bernoulli(rng, scenario.walkInShare),
    reportsCheckout: bernoulli(rng, scenario.checkoutReportRate),
  };
}
