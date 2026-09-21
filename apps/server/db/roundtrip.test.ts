/**
 * 落ちても状態を取り戻せるか。
 *
 * **この PR の問いの、3 つめである。** 1 回の適用を記録するたびに、書いたものを
 * 読み戻して、手元の状態と 1 つも違わないことを確かめる。最後に接続ごと閉じて
 * 開き直し、それでも同じであることを見る。
 *
 * **メモリ内の SQLite は使わない。** 閉じたら消える置き場では、この問いに
 * 答えられない。
 */

import {
  DEFAULT_POLICY,
  findTable,
  findTicket,
  minutes,
  type Table,
  type Timestamp,
  type VenueState,
} from '@openseat/core';
import { asc } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from './client.js';
import { harness, recorder, seed, VENUE_ID, type Harness, type Recorder } from './fixtures.js';
import { loadVenueState, readEvents, readTableSpans } from './repository.js';
import { events } from './schema.js';

const OPENED = Date.UTC(2027, 2, 6, 2, 0, 0);
const at = (min: number): Timestamp => OPENED + minutes(min);

let box: Harness;
let db: Db;
let run: Recorder;

beforeEach(() => {
  box = harness();
  db = box.db;
  run = recorder(db, seed(db, { capacities: [2, 4], now: OPENED }));
});

afterEach(() => {
  box.dispose();
});

/** 記録したものを読み戻す。**`null` は「施設が無い」で、ここでは起こらない。** */
function reloaded(): VenueState {
  const state = loadVenueState(db, VENUE_ID);
  if (state === null) throw new Error('施設が読み戻せません');
  return state;
}

/**
 * 手元の状態と、読み戻した状態が同じであること。
 *
 * **`core` の `sameVenueState` は使えない。** あれは運用パラメータを**参照で**
 * 比べる（`tick` が設定を作り直していないことを見るための判定で、値の一致より
 * 厳しい）。読み戻した設定は必ず別のオブジェクトなので、永続化の検査には向かない。
 *
 * ここで見たいのは「値が 1 つも変わらないこと」なので、深い比較で見る。
 * **`sameVenueState` が見ていない欄も含めて**見られるぶん、こちらのほうが厳しい。
 */
function expectSame(label: string): void {
  expect(reloaded(), label).toEqual(run.state());
}

/**
 * 実証実験の一場面をなぞる。
 *
 * **狙いは 1 つ、`t-1` を手放した人と受け取る人が同じ適用に入ることである。**
 * 片付け猶予が 0 分（既定）なので、退席したその瞬間に次の人へ渡る。ここで
 * 書き込みの順序を間違えると、部分一意インデックスが**正しい変更のほうを**弾く。
 */
function playScenario(): void {
  run.send({ type: 'OPEN', closesAt: at(480), by: 'staff' }, OPENED);
  expectSame('運用を開始した');

  run.send(
    { type: 'JOIN', ticketId: 'k-1', partySize: 2, requiredTags: [], hasNotificationChannel: false },
    at(1),
  );
  run.send(
    { type: 'JOIN', ticketId: 'k-2', partySize: 4, requiredTags: [], hasNotificationChannel: true },
    at(2),
  );
  run.send(
    { type: 'JOIN', ticketId: 'k-3', partySize: 2, requiredTags: [], hasNotificationChannel: false },
    at(3),
  );
  expectSame('3 組が受付した');

  run.send({ type: 'CHECK_IN', ticketId: 'k-1', tableId: 't-1' }, at(4));
  expectSame('1 組目が着席した');

  run.send({ type: 'CHECK_OUT', ticketId: 'k-1', by: 'user' }, at(5));
  expectSame('1 組目が退席し、その席がそのまま次の組へ渡った');

  run.advance(at(14));
  expectSame('呼び出しの期限が切れた');

  run.send({ type: 'READY', ticketId: 'k-3' }, at(15));
  run.advance(at(16));
  expectSame('保留から戻って、また呼ばれた');

  run.send({ type: 'REPORT_TAKEN', ticketId: 'k-3', tableId: 't-1' }, at(17));
  expectSame('案内された席が塞がっていた');

  run.send({ type: 'CLOSE', by: 'staff' }, at(60));
  expectSame('運用を終了した');
}

describe('書いて読み戻した施設', () => {
  it('変化のたびに、手元の状態とそっくり一致する', () => {
    playScenario();
  });

  it('空いた席が、同じ 1 回の変化でそのまま次の組へ渡る', () => {
    run.send({ type: 'OPEN', closesAt: at(480), by: 'staff' }, OPENED);
    run.send(
      { type: 'JOIN', ticketId: 'k-1', partySize: 2, requiredTags: [], hasNotificationChannel: false },
      at(1),
    );
    run.send(
      { type: 'JOIN', ticketId: 'k-2', partySize: 2, requiredTags: [], hasNotificationChannel: false },
      at(2),
    );
    run.send(
      { type: 'JOIN', ticketId: 'k-3', partySize: 2, requiredTags: [], hasNotificationChannel: false },
      at(3),
    );
    run.send({ type: 'CHECK_IN', ticketId: 'k-1', tableId: 't-1' }, at(4));

    const before = findTicket(run.state(), 'k-3')?.state;
    run.send({ type: 'CHECK_OUT', ticketId: 'k-1', by: 'user' }, at(5));

    expect({ before, after: findTicket(reloaded(), 'k-3')?.state }).toEqual({
      before: 'WAITING',
      after: 'CALLED',
    });
    expect(findTicket(reloaded(), 'k-3')?.tableId).toBe('t-1');
  });

  it('接続を閉じて開き直しても、同じ状態に戻る', () => {
    playScenario();
    const inHand = run.state();

    db = box.reopen();

    expect(reloaded()).toEqual(inHand);
  });

  /**
   * **JSON は無限大を表せない。** `JSON.stringify(Infinity)` は `null` を返す。
   * そのまま保存していたら、**再起動したときだけ割当の方針が変わる**という、
   * いちばん気づきにくい壊れ方をしていた（7.16 の `fairness_override_min`）。
   */
  it('JSON が表せない「純粋な best fit」の設定も失わない', () => {
    box.dispose();
    box = harness();
    db = box.db;
    seed(db, {
      capacities: [2],
      now: OPENED,
      policy: { ...DEFAULT_POLICY, fairnessOverrideMin: Number.POSITIVE_INFINITY },
    });

    expect(reloaded().policy.fairnessOverrideMin).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('状態と一緒に記録したもの', () => {
  it('イベントを、書いたとおりに読み戻せる', () => {
    playScenario();
    const recorded = readEvents(db, VENUE_ID);

    expect(recorded.length).toBeGreaterThan(10);
    expect(recorded[0]?.type).toBe('VenueOpened');
    expect(recorded.at(-1)?.type).toBeTypeOf('string');
  });

  /**
   * **`at` は「そうなった時刻」で、記録した順ではない。**
   *
   * 期限で起きたことには期限の時刻が入る（`settle.ts`）。運用を終えた瞬間に
   * 「43 分前に、あの席は確認要になっていた」と分かることがあり、そのイベントは
   * `VenueClosed` より**あとに**記録されながら**前の**時刻を持つ。
   *
   * だから**順序を問うときは `seq` を見る。** ここを取り違えると、配信の
   * 追いつき（9.5）が静かに取りこぼす。
   */
  it('番号は記録した順で、起きた順ではない', () => {
    playScenario();
    const rows = db
      .select({ seq: events.seq, at: events.at, recordedAt: events.recordedAt })
      .from(events)
      .orderBy(asc(events.seq))
      .all();

    // 記録した時刻は、決して戻らない。
    const recorded = rows.map((row) => row.recordedAt);
    expect(recorded).toEqual(recorded.toSorted((a, b) => a - b));
    // そうなった時刻は、記録した時刻を追い越さない。
    expect(rows.filter((row) => row.at > row.recordedAt)).toEqual([]);
    // そして、少なくとも 1 つは前のイベントより前の時刻を持つ。
    const lagging = rows.filter((row, index) => index > 0 && row.at < (rows[index - 1]?.at ?? 0));
    expect(lagging.length).toBeGreaterThan(0);
  });

  it('席の履歴が、最初から最後まで隙間なく続く', () => {
    playScenario();
    const spans = readTableSpans(db, VENUE_ID);

    for (const table of run.state().tables) {
      const mine = spans.filter((span) => span.tableId === table.id);
      expect({ table: table.id, spans: mine.length }).not.toEqual({ table: table.id, spans: 0 });
      // 端どうしが噛み合っている。1 つでもずれれば稼働率が狂う。
      const joints = mine.slice(1).map((span, index) => [mine[index]?.untilAt, span.fromAt]);
      expect(joints.filter(([until, from]) => until !== from)).toEqual([]);
      // 最後の 1 つだけが開いている。
      expect(mine.filter((span) => span.untilAt === null).length).toBe(1);
    }
  });

  /**
   * **`core` は席の姿が変わった時刻を、前に戻すことがある。**
   *
   * 呼び出しの期限が切れたあと、`tick` が走る前に本人が別の空席へ移ると、
   * **あとで確保した席が、それより前の時刻に空く**（`spanBoundary` の説明）。
   *
   * ここはその場面を固定してある。**`core` 側でこれを直したら、このテストが
   * 落ちて知らせる。** そのときは記録を丸める仕掛けごと外せる。
   */
  it('呼び出しの期限を過ぎてから席を変えても、履歴は前に戻らない', () => {
    run.send({ type: 'OPEN', closesAt: at(480), by: 'staff' }, OPENED);
    run.send(
      { type: 'JOIN', ticketId: 'k-1', partySize: 2, requiredTags: [], hasNotificationChannel: false },
      at(18),
    );
    const called = findTicket(run.state(), 'k-1');
    expect({ table: called?.tableId, deadline: called?.holdDeadline }).toEqual({
      table: 't-1',
      deadline: at(25),
    });

    // 期限（25 分）を過ぎた 26 分に、本人が別の空席の QR を読む。
    run.send({ type: 'SWAP_TABLE', ticketId: 'k-1', tableId: 't-2' }, at(26));
    expect(findTable(run.state(), 't-2')?.statusSince).toBe(at(26));

    // 同じ 26 分に `tick` が走り、「25 分に切れていた」と判断する。
    run.advance(at(26));
    expect(findTable(run.state(), 't-2')?.statusSince).toBe(at(25));

    // それでも記録は前に戻らない。確保は長さ 0 の区間になる。
    const spans = readTableSpans(db, VENUE_ID).filter((span) => span.tableId === 't-2');
    expect(spans.filter((span) => span.untilAt !== null && span.untilAt < span.fromAt)).toEqual([]);
    const held = spans.find((span) => span.status === 'HELD');
    expect({ from: held?.fromAt, until: held?.untilAt }).toEqual({ from: at(26), until: at(26) });
  });

  it('開いている区間は、席がいまの姿になった時刻から始まる', () => {
    playScenario();
    const spans = readTableSpans(db, VENUE_ID);

    const mismatched = run
      .state()
      .tables.map((table: Table) => ({
        table: table.id,
        statusSince: table.statusSince,
        status: table.status,
        open: spans.find((span) => span.tableId === table.id && span.untilAt === null),
      }))
      // 始まりは前に戻らないので、`>=` で見る（上のテストの場面）。
      .filter(({ statusSince, status, open }) => (open?.fromAt ?? -1) < statusSince || open?.status !== status);

    expect(mismatched).toEqual([]);
  });

  /**
   * **スタッフと管理者の操作は、例外なく監査に残る**（CLAUDE.md 7）。
   * 時計が起こした変化には実行者がいないので、そこは空のままにする。
   */
  it('誰が押したかを残し、時計が起こしたものは空にする', () => {
    run.send({ type: 'OPEN', closesAt: at(480), by: 'staff' }, OPENED, { kind: 'staff', id: 'u-1' });
    run.send(
      { type: 'JOIN', ticketId: 'k-1', partySize: 2, requiredTags: [], hasNotificationChannel: false },
      at(1),
      { kind: 'user', id: null },
    );
    run.advance(at(30));

    const rows = db
      .select({ type: events.type, kind: events.actorKind, id: events.actorId })
      .from(events)
      .all();

    expect(rows.find((row) => row.type === 'VenueOpened')).toEqual({
      type: 'VenueOpened',
      kind: 'staff',
      id: 'u-1',
    });
    expect(rows.find((row) => row.type === 'TicketJoined')?.kind).toBe('user');
    // 時計が終わらせたチケットに、押した人はいない。
    expect(rows.find((row) => row.type === 'TicketEnded')?.kind).toBeNull();
  });
});
