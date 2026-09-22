/**
 * コマンドの受け口。
 *
 * **見るのは 2 つ。** 権限を通らない操作が状態に届かないことと、**権限とドメインの
 * 条件が、決まった順で評価される**ことである。
 */

import { describe, expect, it } from 'vitest';
import { ANONYMOUS, member, ticketOwner, type Actor } from '../domain/actor.js';
import { DEFAULT_POLICY } from '../domain/policy.js';
import { createVenueState, findTicket, sameVenueState, type VenueState } from '../domain/state.js';
import { createTable, type Table } from '../domain/table.js';
import { createTicket, type Ticket } from '../domain/ticket.js';
import { minutes, type Timestamp } from '../time.js';
import type { Command } from './command.js';
import { dispatch } from './dispatch.js';
import { isDefect, type RejectionCode } from './rejection.js';

const NOW: Timestamp = 1_700_000_000_000;

const STAFF: Actor = member('staff', 'u-staff');
const ADMIN: Actor = member('admin', 'u-admin');
const OWNER: Actor = member('owner', 'u-owner');

function table(id: string, overrides: Partial<Table> = {}): Table {
  return { ...createTable({ id, label: id, capacity: 4, now: NOW }), status: 'FREE', ...overrides };
}

function venue(overrides: Partial<VenueState> = {}): VenueState {
  const base = createVenueState({
    venueId: 'v1',
    policy: DEFAULT_POLICY,
    tables: [table('tb-1'), table('tb-2')],
  });
  return { ...base, operating: true, joinOpen: true, ...overrides };
}

/** 待っている人が 1 人いる施設。空席が無いので呼び出されない。 */
function waiting(id: string): VenueState {
  const ticket: Ticket = createTicket({ id, code: 'A-01', partySize: 2, now: NOW });
  return venue({
    tables: [table('tb-1', { status: 'OCCUPIED_UNKNOWN' })],
    tickets: [ticket],
  });
}

function expectRefused(
  state: VenueState,
  actor: Actor,
  command: Command,
  code: RejectionCode,
): void {
  const result = dispatch(state, actor, command, NOW + minutes(1));
  expect(result.ok ? '通ってしまった' : result.error.code).toBe(code);
}

describe('権限を通らない操作は、状態に届かない', () => {
  it('匿名は保留にできない', () => {
    expectRefused(waiting('k-1'), ANONYMOUS, { type: 'PAUSE', ticketId: 'k-1' }, 'FORBIDDEN');
  });

  it('本人は運用を終われない', () => {
    expectRefused(venue(), ticketOwner('k-1'), { type: 'CLOSE', by: 'staff' }, 'FORBIDDEN');
  });

  it('スタッフは席を対象外にできない（管理者から上）', () => {
    expectRefused(venue(), STAFF, { type: 'DISABLE_TABLE', tableId: 'tb-1', by: 'staff' }, 'FORBIDDEN');
  });

  it('管理者はできる', () => {
    const result = dispatch(venue(), ADMIN, { type: 'DISABLE_TABLE', tableId: 'tb-1', by: 'staff' }, NOW + minutes(1));
    expect(result.ok).toBe(true);
  });

  it('所有者もできる', () => {
    const result = dispatch(venue(), OWNER, { type: 'DISABLE_TABLE', tableId: 'tb-1', by: 'staff' }, NOW + minutes(1));
    expect(result.ok).toBe(true);
  });

  /** **断ったら、状態は 1 つも変わっていない。** */
  it('断られた操作は、状態を動かさない', () => {
    const before = waiting('k-1');
    const result = dispatch(before, ANONYMOUS, { type: 'PAUSE', ticketId: 'k-1' }, NOW + minutes(1));

    expect(result.ok).toBe(false);
    expect(sameVenueState(before, waiting('k-1'))).toBe(true);
  });
});

describe('本人は、自分のチケットしか相手にできない', () => {
  /** **これが無いと、チケット A の秘密パラメータでチケット B を取り消せる。** */
  it('他人のチケットを保留にできない', () => {
    const state = venue({
      tables: [table('tb-1', { status: 'OCCUPIED_UNKNOWN' })],
      tickets: [
        createTicket({ id: 'k-1', code: 'A-01', partySize: 2, now: NOW }),
        createTicket({ id: 'k-2', code: 'A-02', partySize: 2, now: NOW }),
      ],
    });
    expectRefused(state, ticketOwner('k-1'), { type: 'PAUSE', ticketId: 'k-2' }, 'FORBIDDEN');
  });

  it('自分のチケットなら通る', () => {
    const result = dispatch(waiting('k-1'), ticketOwner('k-1'), { type: 'PAUSE', ticketId: 'k-1' }, NOW + minutes(1));
    expect(result.ok && findTicket(result.value.state, 'k-1')?.state).toBe('PAUSED');
  });

  /** すでに並んでいる人がもう 1 枚取れること（受付は「作る側」なので ID が違う）。 */
  it('並んでいる人が、もう 1 枚受け付けられる', () => {
    const result = dispatch(
      waiting('k-1'),
      ticketOwner('k-1'),
      { type: 'JOIN', ticketId: 'k-9', partySize: 2, requiredTags: [], hasNotificationChannel: false },
      NOW + minutes(1),
    );
    expect(result.ok && findTicket(result.value.state, 'k-9')?.state).toBe('WAITING');
  });
});

describe('名乗りと役割の食い違い', () => {
  /**
   * **監査の記録が嘘になるのを防ぐ。** スタッフが取り消したのに `user_cancel` と
   * 残ったら、あとから「誰が消したのか」を追えない（7.9、CLAUDE.md 7 章）。
   */
  it('スタッフが利用者側と名乗ったら断る', () => {
    expectRefused(
      waiting('k-1'),
      STAFF,
      { type: 'CANCEL', ticketId: 'k-1', by: 'user', reason: 'other' },
      'ACTOR_MISMATCH',
    );
  });

  it('本人がスタッフ側と名乗っても断る', () => {
    expectRefused(
      waiting('k-1'),
      ticketOwner('k-1'),
      { type: 'CANCEL', ticketId: 'k-1', by: 'staff', reason: 'other' },
      'ACTOR_MISMATCH',
    );
  });

  /** **入力の誤りではなく、境界の組み立ての誤りである。** 利用者には出さない。 */
  it('食い違いは欠陥として扱う', () => {
    const result = dispatch(
      waiting('k-1'),
      STAFF,
      { type: 'CANCEL', ticketId: 'k-1', by: 'user', reason: 'other' },
      NOW + minutes(1),
    );
    expect(!result.ok && isDefect(result.error)).toBe(true);
  });

  it('管理者も所有者も、スタッフ側として名乗る', () => {
    for (const actor of [ADMIN, OWNER]) {
      const result = dispatch(
        waiting('k-1'),
        actor,
        { type: 'CANCEL', ticketId: 'k-1', by: 'staff', reason: 'other' },
        NOW + minutes(1),
      );
      expect(result.ok).toBe(true);
    }
  });
});

describe('権限とドメインの条件は、この順で評価される', () => {
  /** 着席の記録が残った「確認要」の席。[ADR-0011](../../../../docs/adr/0011-who-may-free-an-uncertain-seat.md) の場面。 */
  function recorded(): VenueState {
    const ticket: Ticket = {
      ...createTicket({ id: 'k-1', code: 'A-01', partySize: 2, now: NOW }),
      state: 'SEATED',
      tableId: 'tb-1',
      seatedAt: NOW,
    };
    return venue({
      tables: [table('tb-1', { status: 'NEEDS_CHECK', statusSince: NOW, occupantTicketId: 'k-1' })],
      tickets: [ticket],
    });
  }

  /**
   * **権限の表は通る。** 誰でも「空いていました」と報告できる（7.11 の 3 層目）。
   * 断るのはドメインの側で、理由も `STAFF_ONLY` になる。
   */
  it('匿名の「空いていました」は、ドメインが STAFF_ONLY で断る', () => {
    expectRefused(recorded(), ANONYMOUS, { type: 'CONFIRM_FREE', tableId: 'tb-1', by: 'user' }, 'STAFF_ONLY');
  });

  it('スタッフの「空いていました」は通る', () => {
    const result = dispatch(recorded(), STAFF, { type: 'CONFIRM_FREE', tableId: 'tb-1', by: 'staff' }, NOW + minutes(1));
    expect(result.ok && findTicket(result.value.state, 'k-1')?.state).toBe('DONE');
  });

  /**
   * **権限が先に立つ。** 状態の側でも断られる操作でも、役割が足りなければ
   * `FORBIDDEN` が返る。状態を読まずに断れるほうが速く、**存在しないチケットの
   * 有無を、権限の無い人に教えずに済む。**
   */
  it('役割も状態も駄目なら、権限が先に断る', () => {
    expectRefused(venue(), ANONYMOUS, { type: 'PAUSE', ticketId: 'k-missing' }, 'FORBIDDEN');
  });

  it('役割が足りていれば、状態の理由が返る', () => {
    expectRefused(venue(), ticketOwner('k-missing'), { type: 'PAUSE', ticketId: 'k-missing' }, 'TICKET_NOT_FOUND');
  });
});
