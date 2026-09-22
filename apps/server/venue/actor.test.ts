/**
 * 施設アクター。
 *
 * **この PR の問いは 3 つ。** コマンドが 1 件ずつ順に適用されるか、送り直しで
 * 二度適用されないか、落ちても取り戻せるか（9.4）。
 */

import {
  ANONYMOUS,
  findTable,
  findTicket,
  member,
  minutes,
  ticketOwner,
  type Actor,
  type Command,
  type Timestamp,
} from '@openseat/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../db/client.js';
import { harness, seed, VENUE_ID, type Harness } from '../db/fixtures.js';
import { findRecord, loadVenueState, readEvents } from '../db/repository.js';
import { openVenueActor, RECORD_TTL_MS, type CommandRequest, type VenueActor } from './actor.js';

const OPENED: Timestamp = Date.UTC(2027, 2, 6, 2, 0, 0);
const at = (min: number): Timestamp => OPENED + minutes(min);

const STAFF: Actor = member('staff', 'u-1');

let box: Harness;
let db: Db;
/** 偽の時計。**サーバ時刻だけを信じる**ので、テストはここを動かす（9.4）。 */
let now: Timestamp;

function actorOn(): VenueActor {
  return openVenueActor({ db, venueId: VENUE_ID, clock: () => now });
}

let keySeq = 0;
/** 鍵は画面が作る。テストでは連番でよい。 */
function request(command: Command, actor: Actor = ANONYMOUS): CommandRequest {
  keySeq += 1;
  return { actor, command, key: `k-${String(keySeq)}`, identity: identityFor(command) };
}

/** 受付と飛び込みには、秘密パラメータのハッシュが要る（9.8）。 */
function identityFor(command: Command): CommandRequest['identity'] {
  if (command.type !== 'JOIN' && command.type !== 'WALK_IN') return null;
  return { ticketId: command.ticketId, clientTokenHash: 'hash-of-device', secretHash: 'hash-of-secret' };
}

function joinOf(id: string, partySize = 2): Command {
  return { type: 'JOIN', ticketId: id, partySize, requiredTags: [], hasNotificationChannel: false };
}

beforeEach(() => {
  box = harness();
  db = box.db;
  now = OPENED;
  keySeq = 0;
  seed(db, { capacities: [2, 4], now: OPENED });
});

afterEach(() => {
  box.dispose();
});

describe('1 件ずつ、順に', () => {
  /**
   * **並行に 2 つの受付が来ても、1 席に 2 組が割り当たらない**（Phase 1 の C5）。
   *
   * 不変条件は `core` が見ているので、破れば適用そのものが落ちる。ここで見たいのは
   * **並行に投げても落ちない**ことと、**割当が 1 つずつ進む**ことである。
   */
  it('同時に来た受付でも、1 席に 2 組が割り当たらない', async () => {
    const actor = actorOn();
    await actor.send(request({ type: 'OPEN', closesAt: at(480), by: 'staff' }, STAFF));

    now = at(1);
    const outcomes = await Promise.all([
      actor.send(request(joinOf('a'))),
      actor.send(request(joinOf('b'))),
      actor.send(request(joinOf('c'))),
    ]);

    expect(outcomes.map((outcome) => outcome.kind)).toEqual(['applied', 'applied', 'applied']);

    const state = actor.state();
    const held = state.tables.filter((table) => table.status === 'HELD');
    expect(held).toHaveLength(2);
    // 席を持っているチケットが、席の数と一致する（2 組が同じ席に乗っていない）。
    const seated = state.tickets.filter((ticket) => ticket.tableId !== null);
    expect(new Set(seated.map((ticket) => ticket.tableId)).size).toBe(seated.length);
  });

  it('書いたものと、手元の状態が一致する', async () => {
    const actor = actorOn();
    await actor.send(request({ type: 'OPEN', closesAt: at(480), by: 'staff' }, STAFF));
    now = at(1);
    await actor.send(request(joinOf('a')));

    expect(loadVenueState(db, VENUE_ID)).toEqual(actor.state());
  });
});

describe('送り直しで、二度適用しない', () => {
  it('同じ鍵で 2 回送っても、1 回しか適用されない', async () => {
    const actor = actorOn();
    await actor.send(request({ type: 'OPEN', closesAt: at(480), by: 'staff' }, STAFF));

    now = at(1);
    const send: CommandRequest = {
      actor: ANONYMOUS,
      command: joinOf('a'),
      key: 'same',
      identity: identityFor(joinOf('a')),
    };
    const first = await actor.send(send);
    const second = await actor.send(send);

    expect(first.kind).toBe('applied');
    expect(second.kind).toBe('replayed');
    expect(actor.state().tickets).toHaveLength(1);
  });

  it('送り直しには、前回の結末が返る', async () => {
    const actor = actorOn();
    await actor.send(request({ type: 'OPEN', closesAt: at(480), by: 'staff' }, STAFF));

    now = at(1);
    const send: CommandRequest = {
      actor: ANONYMOUS,
      command: joinOf('a'),
      key: 'same',
      identity: identityFor(joinOf('a')),
    };
    await actor.send(send);
    const again = await actor.send(send);

    expect(again.kind === 'replayed' && again.record).toEqual({
      key: 'same',
      at: at(1),
      commandType: 'JOIN',
      ok: true,
      rejectionCode: null,
      ticketId: 'a',
    });
  });

  /** **1 回目が「満席です」だったものが 2 回目で通ると、画面の説明がつかない。** */
  it('断られた結末も、送り直しで同じものが返る', async () => {
    const actor = actorOn();
    // 運用していないので受付は断られる。
    const send: CommandRequest = {
      actor: ANONYMOUS,
      command: joinOf('a'),
      key: 'same',
      identity: identityFor(joinOf('a')),
    };
    const first = await actor.send(send);
    const second = await actor.send(send);

    expect(first.kind === 'rejected' && first.rejection.code).toBe('JOIN_CLOSED');
    expect(second.kind === 'replayed' && second.record.rejectionCode).toBe('JOIN_CLOSED');
  });

  /**
   * **欠陥は控えない。** 実装の誤りに同じ答えを返しても意味が無い。直したあとに
   * 通ってほしい。
   */
  it('欠陥は控えず、送り直しで作り直される', async () => {
    const actor = actorOn();
    await actor.send(request({ type: 'OPEN', closesAt: at(480), by: 'staff' }, STAFF));

    // 名乗りと役割が食い違う（境界の組み立ての誤り）。
    now = at(1);
    const broken: CommandRequest = {
      actor: STAFF,
      command: { type: 'CLOSE', by: 'user' },
      key: 'defect',
      identity: null,
    };
    const first = await actor.send(broken);

    expect(first.kind === 'rejected' && first.rejection.code).toBe('ACTOR_MISMATCH');
    expect(findRecord(db, VENUE_ID, 'defect')).toBeNull();
  });

  it('違う鍵なら、別の操作として通る', async () => {
    const actor = actorOn();
    await actor.send(request({ type: 'OPEN', closesAt: at(480), by: 'staff' }, STAFF));

    now = at(1);
    await actor.send({ actor: ANONYMOUS, command: joinOf('a'), key: 'one', identity: identityFor(joinOf('a')) });
    await actor.send({ actor: ANONYMOUS, command: joinOf('b'), key: 'two', identity: identityFor(joinOf('b')) });

    expect(actor.state().tickets).toHaveLength(2);
  });
});

describe('落ちても取り戻せる', () => {
  it('起こし直すと、同じ状態から続けられる', async () => {
    const first = actorOn();
    await first.send(request({ type: 'OPEN', closesAt: at(480), by: 'staff' }, STAFF));
    now = at(1);
    await first.send(request(joinOf('a')));
    now = at(2);
    await first.send(request({ type: 'CHECK_IN', ticketId: 'a', tableId: 't-1' }, ticketOwner('a')));

    db = box.reopen();
    const second = actorOn();

    expect(second.state()).toEqual(first.state());
    expect(findTicket(second.state(), 'a')?.state).toBe('SEATED');
  });

  /** **控えも残る。** 落ちた直後の送り直しで、二度適用してはいけない。 */
  it('起こし直しても、送り直しは二度適用されない', async () => {
    const first = actorOn();
    await first.send(request({ type: 'OPEN', closesAt: at(480), by: 'staff' }, STAFF));
    now = at(1);
    await first.send({ actor: ANONYMOUS, command: joinOf('a'), key: 'same', identity: identityFor(joinOf('a')) });

    db = box.reopen();
    const second = actorOn();
    const again = await second.send({
      actor: ANONYMOUS,
      command: joinOf('a'),
      key: 'same',
      identity: identityFor(joinOf('a')),
    });

    expect(again.kind).toBe('replayed');
    expect(second.state().tickets).toHaveLength(1);
  });

  it('施設が無ければ、起こさずに落ちる', () => {
    expect(() => openVenueActor({ db, venueId: 'nope', clock: () => now })).toThrow(/nope/);
  });
});

describe('時刻を進める', () => {
  /**
   * **止まっていたあいだに時間が飛んでも、来ている期限がすべて片づく**
   * （Phase 1 の PR 12 と同じ性質を、サーバ越しに）。
   */
  it('1 時間止まっていても、1 回で片づく', async () => {
    const actor = actorOn();
    await actor.send(request({ type: 'OPEN', closesAt: at(480), by: 'staff' }, STAFF));
    now = at(1);
    await actor.send(request(joinOf('a')));
    expect(findTicket(actor.state(), 'a')?.state).toBe('CALLED');

    // 60 分飛ばす。呼び出しの期限（7 分）も、受付からの上限（90 分）も過ぎている。
    now = at(61);
    await actor.advance();

    const ticket = findTicket(actor.state(), 'a');
    expect(ticket?.state).not.toBe('CALLED');
    expect(actor.lastTickAt()).toBe(at(61));
  });

  it('何も起きない刻みでは、イベントが増えない', async () => {
    const actor = actorOn();
    await actor.send(request({ type: 'OPEN', closesAt: at(480), by: 'staff' }, STAFF));
    const before = readEvents(db, VENUE_ID).length;

    now = at(1);
    await actor.advance();

    expect(readEvents(db, VENUE_ID)).toHaveLength(before);
    expect(actor.lastTickAt()).toBe(at(1));
  });

  /**
   * **何も起きなくても、進んだ時刻は書く。**
   *
   * 「状態が知っている最後の時刻」（`clockAt`）は、**時計が戻っていないことを
   * 確かめるためだけに持っている**（9.4）。これを書かずにいると、落ちて起き直した
   * ときに巻き戻りを見逃す。イベントが 1 つも出ない刻みでも、ここだけは残る。
   */
  it('何も起きない刻みでも、進んだ時刻は残る', async () => {
    const actor = actorOn();
    await actor.send(request({ type: 'OPEN', closesAt: at(480), by: 'staff' }, STAFF));

    now = at(1);
    await actor.advance();
    expect(loadVenueState(db, VENUE_ID)?.clockAt).toBe(at(1));

    // 起こし直しても残っているので、巻き戻りを見つけられる。
    db = box.reopen();
    const second = actorOn();
    now = at(0);
    const outcome = await second.send(request(joinOf('a')));
    expect(outcome.kind === 'rejected' && outcome.rejection.code).toBe('CLOCK_WENT_BACKWARD');
  });

  /** 同じ時刻で 2 回進めても、状態は変わらない（`core` の `tick_idempotent`）。 */
  it('同じ時刻の刻みは、2 回目に何も書かない', async () => {
    const actor = actorOn();
    await actor.send(request({ type: 'OPEN', closesAt: at(480), by: 'staff' }, STAFF));
    now = at(1);
    await actor.advance();

    const before = loadVenueState(db, VENUE_ID);
    await actor.advance();

    expect(loadVenueState(db, VENUE_ID)).toEqual(before);
  });

  it('時計が戻ったら、コマンドが断られる', async () => {
    const actor = actorOn();
    await actor.send(request({ type: 'OPEN', closesAt: at(480), by: 'staff' }, STAFF));
    now = at(10);
    await actor.advance();

    now = at(5);
    const outcome = await actor.send(request(joinOf('a')));
    expect(outcome.kind === 'rejected' && outcome.rejection.code).toBe('CLOCK_WENT_BACKWARD');
  });

  /** 古い控えは捨てる（24 時間。ADR-0015）。 */
  it('1 日より古い控えは捨てられる', async () => {
    const actor = actorOn();
    await actor.send(request({ type: 'OPEN', closesAt: at(480), by: 'staff' }, STAFF));
    now = at(1);
    await actor.send({ actor: ANONYMOUS, command: joinOf('a'), key: 'old', identity: identityFor(joinOf('a')) });
    expect(findRecord(db, VENUE_ID, 'old')).not.toBeNull();

    now = at(1) + RECORD_TTL_MS + minutes(1);
    await actor.advance();

    expect(findRecord(db, VENUE_ID, 'old')).toBeNull();
  });
});

describe('記録が終わってから、配信する', () => {
  /** **順番を入れ替えない**（9.4）。配信のときには、もう書けている。 */
  it('知らせが来たときには、もう書き終わっている', async () => {
    const actor = actorOn();
    const seen: number[] = [];
    actor.onCommitted(() => {
      seen.push(readEvents(db, VENUE_ID).length);
    });

    await actor.send(request({ type: 'OPEN', closesAt: at(480), by: 'staff' }, STAFF));

    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(readEvents(db, VENUE_ID).length);
  });

  it('断られたときは、知らせない', async () => {
    const actor = actorOn();
    let called = 0;
    actor.onCommitted(() => {
      called += 1;
    });

    await actor.send(request(joinOf('a')));
    expect(called).toBe(0);
  });

  it('時刻を進めて何か起きたら、知らせる', async () => {
    const actor = actorOn();
    await actor.send(request({ type: 'OPEN', closesAt: at(480), by: 'staff' }, STAFF));
    now = at(1);
    await actor.send(request(joinOf('a')));

    let called = 0;
    actor.onCommitted(() => {
      called += 1;
    });
    now = at(61);
    await actor.advance();

    expect(called).toBeGreaterThan(0);
  });
});

describe('壊れた状態は書き込まない', () => {
  /**
   * `core` が不変条件で弾き、DB の制約が二重に受ける（[ADR-0013](../../../docs/adr/0013-what-we-record.md)）。
   * **断られたとき、状態も記録も動いていない。**
   */
  it('断られたコマンドは、状態も記録も動かさない', async () => {
    const actor = actorOn();
    await actor.send(request({ type: 'OPEN', closesAt: at(480), by: 'staff' }, STAFF));
    const before = actor.state();
    const events = readEvents(db, VENUE_ID).length;

    now = at(1);
    // 存在しない席に着席しようとする。
    const outcome = await actor.send(
      request({ type: 'CHECK_IN', ticketId: 'nope', tableId: 't-1' }, ticketOwner('nope')),
    );

    expect(outcome.kind).toBe('rejected');
    expect(actor.state()).toBe(before);
    expect(readEvents(db, VENUE_ID)).toHaveLength(events);
    expect(findTable(loadVenueState(db, VENUE_ID) ?? before, 't-1')?.status).toBe('FREE');
  });
});
