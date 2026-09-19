import { describe, expect, it } from 'vitest';
import { minutes, type Timestamp } from './time.js';
import {
  MINUTES_PER_DAY,
  WEEKDAYS,
  closesAtOf,
  isManaged,
  remainingToday,
  validateSchedule,
  windowAt,
  type LocalTime,
  type ManagedSchedule,
  type Weekday,
} from './schedule.js';

/**
 * 運用時間帯（全体プラン 7.14）。
 *
 * 7.14 の例「土日祝 11:00〜14:30、17:30〜19:30」をそのまま写して確かめる。
 * 祝日は曜日では表せないので、境界側が「その日を土曜として渡す」か、日付ごとの
 * 例外を持つことになる。**core は曜日と分数しか知らない。**
 */

/** `h:mm` をその日の 0 時からの分数に直す。テストを時計の読みに寄せるため。 */
function at(hour: number, minute = 0): number {
  return hour * 60 + minute;
}

function local(weekday: Weekday, hour: number, minute = 0): LocalTime {
  return { weekday, minuteOfDay: at(hour, minute) };
}

/** 7.14 の例。 */
const WEEKEND: ManagedSchedule = [
  { days: ['sat', 'sun'], fromMin: at(11), toMin: at(14, 30) },
  { days: ['sat', 'sun'], fromMin: at(17, 30), toMin: at(19, 30) },
];

// ---------------------------------------------------------------------------

describe('7.14 の例（土日 11:00〜14:30、17:30〜19:30）', () => {
  it('昼の時間帯のまんなかは運用中', () => {
    expect(isManaged(WEEKEND, local('sat', 12, 30))).toBe(true);
  });

  it('開始ちょうどは運用中', () => {
    expect(isManaged(WEEKEND, local('sat', 11))).toBe(true);
  });

  /** 終了ちょうどは外。「14:30 まで」は 14:30 を含まない、と読む。 */
  it('終了ちょうどは運用外', () => {
    expect(isManaged(WEEKEND, local('sat', 14, 30))).toBe(false);
  });

  it('昼と夜のあいだは運用外', () => {
    expect(isManaged(WEEKEND, local('sat', 16))).toBe(false);
  });

  it('夜の時間帯も運用中', () => {
    expect(isManaged(WEEKEND, local('sun', 18))).toBe(true);
  });

  it('曜日が外れていれば、時刻が合っていても運用外', () => {
    expect(isManaged(WEEKEND, local('wed', 12, 30))).toBe(false);
  });

  it('どの時間帯に入ったかが分かる', () => {
    expect(windowAt(WEEKEND, local('sat', 18))?.fromMin).toBe(at(17, 30));
  });

  it('運用外なら時間帯は返らない', () => {
    expect(windowAt(WEEKEND, local('sat', 16))).toBeNull();
  });

  it('空の設定では、いつでも運用外', () => {
    for (const weekday of WEEKDAYS) {
      expect(isManaged([], { weekday, minuteOfDay: at(12) })).toBe(false);
    }
  });
});

describe('いつ終わるか', () => {
  it('終了までの残り時間が出る', () => {
    expect(remainingToday(WEEKEND, local('sat', 14))).toBe(minutes(30));
  });

  it('運用外なら残り時間は無い', () => {
    expect(remainingToday(WEEKEND, local('sat', 16))).toBeNull();
  });

  /**
   * **ここが境界側との受け渡し点である。** UTC の「いま」と、変換済みの
   * ローカル時刻を渡すと、終わる時刻が UTC で返る。以降 core は絶対時刻だけを
   * 見るので、タイムゾーンのことを知らずに済む。
   */
  it('終わる時刻が、いまからの残り時間として返る', () => {
    const now: Timestamp = 1_700_000_000_000;
    expect(closesAtOf(now, local('sat', 14), WEEKEND)).toBe(now + minutes(30));
  });

  it('運用外なら終わる時刻も無い', () => {
    expect(closesAtOf(1_700_000_000_000, local('sat', 16), WEEKEND)).toBeNull();
  });
});

describe('設定の検証', () => {
  it('7.14 の例に問題は無い', () => {
    expect(validateSchedule(WEEKEND)).toEqual([]);
  });

  it('曜日が空なら落とす', () => {
    const problems = validateSchedule([{ days: [], fromMin: at(11), toMin: at(14) }]);
    expect(problems).toEqual([{ index: 0, message: '曜日が 1 つも指定されていない' }]);
  });

  it('終了が開始より後でなければ落とす', () => {
    const problems = validateSchedule([{ days: ['sat'], fromMin: at(14), toMin: at(11) }]);
    expect(problems.map((problem) => problem.message)).toEqual(['終了が開始より後になっていない']);
  });

  it('同じ時刻で始まって終わる時間帯も落とす', () => {
    const problems = validateSchedule([{ days: ['sat'], fromMin: at(11), toMin: at(11) }]);
    expect(problems).toHaveLength(1);
  });

  it('1 日の分数を超える指定は落とす', () => {
    const problems = validateSchedule([
      { days: ['sat'], fromMin: at(11), toMin: MINUTES_PER_DAY + 1 },
    ]);
    expect(problems.map((problem) => problem.message)).toEqual(['終了が 0〜1440 の整数でない']);
  });

  it('整数でない指定は落とす', () => {
    const problems = validateSchedule([{ days: ['sat'], fromMin: 11.5, toMin: at(14) }]);
    expect(problems.map((problem) => problem.message)).toEqual(['開始が 0〜1440 の整数でない']);
  });

  it('何本目の時間帯に問題があるかが分かる', () => {
    const problems = validateSchedule([
      { days: ['sat'], fromMin: at(11), toMin: at(14) },
      { days: [], fromMin: at(17), toMin: at(19) },
    ]);
    expect(problems.map((problem) => problem.index)).toEqual([1]);
  });

  /** 日をまたぐ運用は 2 本に分けて書く。1 本で書こうとすると落ちる。 */
  it('日をまたぐ指定は落ちる（2 本に分けて書く）', () => {
    expect(validateSchedule([{ days: ['sat'], fromMin: at(22), toMin: at(2) }])).toHaveLength(1);
  });
});
