import { describe, expect, it } from 'vitest';
import {
  MINUTE_MS,
  SECOND_MS,
  after,
  elapsedSince,
  hasPassed,
  minutes,
  reached,
  remaining,
  seconds,
  type Timestamp,
} from './time.js';

const BASE: Timestamp = 1_700_000_000_000;

describe('minutes / seconds', () => {
  it('分と秒をミリ秒に変換する', () => {
    expect(minutes(7)).toBe(7 * MINUTE_MS);
    expect(seconds(10)).toBe(10 * SECOND_MS);
  });

  it('0 と負の値をそのまま扱う', () => {
    expect(minutes(0)).toBe(0);
    expect(minutes(-1)).toBe(-MINUTE_MS);
  });
});

describe('hasPassed', () => {
  it('期限ちょうどは「過ぎていない」とする', () => {
    expect(hasPassed(BASE, BASE)).toBe(false);
  });

  it('1 ミリ秒でも超えたら過ぎている', () => {
    expect(hasPassed(BASE, BASE + 1)).toBe(true);
  });

  it('期限前は過ぎていない', () => {
    expect(hasPassed(BASE, BASE - 1)).toBe(false);
  });
});

describe('remaining', () => {
  it('残り時間を返す', () => {
    expect(remaining(after(BASE, minutes(7)), BASE)).toBe(minutes(7));
  });

  it('期限を過ぎていたら 0 を返す（負の値を外に出さない）', () => {
    expect(remaining(BASE, after(BASE, minutes(3)))).toBe(0);
  });

  it('期限ちょうどは 0', () => {
    expect(remaining(BASE, BASE)).toBe(0);
  });
});

describe('elapsedSince', () => {
  it('経過時間を返す', () => {
    expect(elapsedSince(BASE, after(BASE, minutes(35)))).toBe(minutes(35));
  });

  it('未来の時刻を渡されたら 0 を返す', () => {
    expect(elapsedSince(after(BASE, minutes(1)), BASE)).toBe(0);
  });
});

describe('reached（設備の都合の待ち）', () => {
  it('ちょうどで「達した」とする', () => {
    expect(reached(BASE, BASE)).toBe(true);
  });

  it('まだ来ていなければ達していない', () => {
    expect(reached(BASE + 1, BASE)).toBe(false);
  });

  it('過ぎていれば達している', () => {
    expect(reached(BASE, BASE + 1)).toBe(true);
  });

  /**
   * `hasPassed` との違いは境界の 1 点だけ。**待ち時間を 0 に設定したときに、
   * 本当に待ち時間ゼロになる**ようにするためにある（片付けの猶予など）。
   */
  it('hasPassed と違うのは、期限ちょうどの 1 点だけ', () => {
    for (const offset of [-2, -1, 1, 2]) {
      expect(reached(BASE, BASE + offset)).toBe(hasPassed(BASE, BASE + offset));
    }
    expect(reached(BASE, BASE)).not.toBe(hasPassed(BASE, BASE));
  });
});
