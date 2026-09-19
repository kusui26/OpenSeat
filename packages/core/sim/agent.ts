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
 * ## この版がモデル化しないこと
 *
 * 「向かっています」（延長）と「パス」（譲る）は、8.1 に率が無いので出さない。
 * 無断利用・飛び込み・時間上限も、対応する PR（9、10）で足す。
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
  /** 退席を申告するか。しなければ席は戻らない（PR 10 まで）。 */
  readonly reportsCheckout: boolean;
  /**
   * 画面を開いたままにせず、通知で受け取るか。
   *
   * この版では常に真にしてある。偽にすると放置の判定（7.9）が働き、
   * 心拍を出さないシミュレータでは全員が 10 分で消えてしまう。心拍を
   * モデル化するのは、放置を扱う PR（10）に合わせる。
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
    stay: Math.round(logNormal(rng, stayMedian(scenario, partySize), scenario.stay.sigma)),
    walk: Math.round(drawWalk(rng, scenario)),
    noShowRoll: rng.next(),
    reportsCheckout: bernoulli(rng, scenario.checkoutReportRate),
    hasNotificationChannel: true,
  };
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
