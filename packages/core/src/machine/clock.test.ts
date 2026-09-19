import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY } from '../domain/policy.js';
import { createTable, type Table } from '../domain/table.js';
import { createVenueState, type VenueState } from '../domain/state.js';
import { minutes, seconds, type Timestamp } from '../time.js';
import { apply } from './apply.js';
import { checkClock, withClock } from './clock.js';
import type { Command } from './command.js';
import { isDefect } from './rejection.js';
import { tick } from './tick.js';

/**
 * 時計の単調性（全体プラン 9.4、Phase 1 プラン PR 12 の「単調性」）。
 *
 * 期限の判定はすべて「状態に書いてある絶対時刻」と `now` の比較でできている。
 * **時計が戻ると、いったん過ぎた期限がまた「これから」に戻る。** 壊れ方が
 * 静かなので、入口で落とす。
 */

const NOW: Timestamp = 1_700_000_000_000;

function at(elapsedMin: number): Timestamp {
  return NOW + minutes(elapsedMin);
}

function table(id: string, capacity: number): Table {
  return { ...createTable({ id, label: id, capacity, now: NOW }), status: 'FREE' };
}

function venue(): VenueState {
  return {
    ...createVenueState({ venueId: 'v1', policy: DEFAULT_POLICY, tables: [table('tb-4', 4)] }),
    operating: true,
    joinOpen: true,
  };
}

const JOIN: Command = {
  type: 'JOIN',
  ticketId: 'k1',
  partySize: 2,
  requiredTags: [],
  hasNotificationChannel: true,
};

function advanced(now: Timestamp): VenueState {
  const ticked = tick(venue(), now);
  if (!ticked.ok) throw new Error('tick が拒否された');
  return ticked.value.state;
}

// ---------------------------------------------------------------------------

describe('刻みの記録', () => {
  it('作ったばかりの状態は、まだ何時か知らない', () => {
    expect(venue().clockAt).toBeNull();
  });

  it('tick が刻む', () => {
    expect(advanced(at(10)).clockAt).toBe(at(10));
  });

  it('apply も刻む', () => {
    const applied = apply(venue(), JOIN, at(10));
    expect(applied.ok && applied.value.state.clockAt).toBe(at(10));
  });

  it('同じ時刻なら、状態のオブジェクトを作り直さない', () => {
    const state = advanced(at(10));
    expect(withClock(state, at(10))).toBe(state);
  });
});

describe('戻る時刻を拒否する', () => {
  it('まだ何時か知らない状態は、どの時刻でも受け付ける', () => {
    expect(checkClock(venue(), at(-100))).toBeNull();
  });

  it('進む時刻は通る', () => {
    expect(checkClock(advanced(at(10)), at(11))).toBeNull();
  });

  /** 同じ時刻の `tick` を何度呼んでも状態が変わらないこと（9.12 の 5）を保つため。 */
  it('同じ時刻は通る', () => {
    expect(checkClock(advanced(at(10)), at(10))).toBeNull();
  });

  it('1 ミリ秒でも戻れば落とす', () => {
    expect(checkClock(advanced(at(10)), at(10) - 1)?.code).toBe('CLOCK_WENT_BACKWARD');
  });

  it('tick は戻る時刻を拒否する', () => {
    const result = tick(advanced(at(10)), at(9));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe('CLOCK_WENT_BACKWARD');
  });

  it('apply も戻る時刻を拒否する', () => {
    const result = apply(advanced(at(10)), JOIN, at(9));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe('CLOCK_WENT_BACKWARD');
  });

  it('拒否されたとき、状態は 1 つも変わらない', () => {
    const state = advanced(at(10));
    const result = apply(state, JOIN, at(9));
    expect(result.ok).toBe(false);
    expect(state.tickets).toEqual([]);
  });

  /**
   * **これは実装の誤りであって、利用者の操作の誤りではない。** 境界側は
   * 文言に変えるのではなく、記録して調査する（`rejection.ts`）。
   */
  it('実装の誤りとして扱われる', () => {
    const result = tick(advanced(at(10)), at(9));
    expect(!result.ok && isDefect(result.error)).toBe(true);
  });

  it('apply で進めたあと、tick が戻ることも拒否される', () => {
    const applied = apply(venue(), JOIN, at(10));
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(tick(applied.value.state, at(9)).ok).toBe(false);
  });
});

describe('なぜ要るか（戻せると何が起きるか）', () => {
  /**
   * 時計を戻せると、**いったん切れたホールドの期限がまた「これから」に戻る**。
   * 入口で落とすので、この筋書きは起こせない。
   */
  it('切れたはずのホールドが生き返る筋書きを、入口で止める', () => {
    const joined = apply(venue(), JOIN, NOW);
    expect(joined.ok).toBe(true);
    if (!joined.ok) return;

    // 既定のホールドは 7 分。8 分で切れている。
    const expired = tick(joined.value.state, at(8));
    expect(expired.ok).toBe(true);
    if (!expired.ok) return;
    expect(expired.value.state.tickets[0]?.state).not.toBe('CALLED');

    // ここで時計を戻せたら、期限前の状態として評価されてしまう。
    expect(tick(expired.value.state, at(5)).ok).toBe(false);
  });

  it('10 秒ごとに呼び続けるかぎり、いつも通る', () => {
    let state = venue();
    for (let now: Timestamp = NOW; now <= at(30); now += seconds(10)) {
      const ticked = tick(state, now);
      expect(ticked.ok).toBe(true);
      if (!ticked.ok) return;
      state = ticked.value.state;
    }
    expect(state.clockAt).toBe(at(30));
  });
});
