/**
 * 整合性が、DB の制約として本当に効いているか。
 *
 * **宣言しただけでは守られない。** `core` を通さずに直接書き込んで、書き込みが
 * 落ちることを確かめる。落ちなければ、その制約は飾りである（CLAUDE.md 3.2(1)）。
 *
 * どの検査も、**`core` の不変条件（`machine/invariants.ts`）と同じ名前**で並べて
 * ある。名前が対応していれば、どちらを読んでいても対応物を探せる。
 */

import { minutes } from '@openseat/core';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from './client.js';
import { harness, seed, VENUE_ID, type Harness } from './fixtures.js';
import { tableStatusLog, tables, tickets, venues } from './schema.js';

const NOW = Date.UTC(2027, 2, 6, 3, 0, 0);

let box: Harness;
let db: Db;

beforeEach(() => {
  box = harness();
  db = box.db;
  seed(db, { capacities: [2, 4], now: NOW });
});

afterEach(() => {
  box.dispose();
});

type TicketRow = typeof tickets.$inferInsert;

/** 通る行。ここから 1 つだけ崩して、崩したものだけが落ちることを見る。 */
function waiting(overrides: Partial<TicketRow> = {}): TicketRow {
  return {
    id: 'k-1',
    venueId: VENUE_ID,
    code: 'A-01',
    partySize: 2,
    state: 'WAITING',
    priorityAt: NOW,
    createdAt: NOW,
    lastSeenAt: NOW,
    ...overrides,
  };
}

function insert(row: TicketRow): void {
  db.insert(tickets).values(row).run();
}

/**
 * 断られた理由を文字列で返す。通ってしまったらそう言う。
 *
 * ドライバは**制約の名前をそのまま**返してくる（`CHECK constraint failed: <名前>`）。
 * 一意インデックスだけは名前ではなく列を挙げるので、そちらは列で見る。
 * Drizzle が包んだときのために、内側の理由も繋げておく。
 */
function refusal(run: () => void): string {
  try {
    run();
  } catch (error) {
    return reason(error);
  }
  return '（断られませんでした）';
}

function reason(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return error.cause instanceof Error ? `${error.message} / ${error.cause.message}` : error.message;
}

describe('チケットの表が断るもの', () => {
  it('（土台にする行は、そのままなら通る）', () => {
    expect(() => insert(waiting())).not.toThrow();
  });

  it('1 つの席を 2 枚が押さえること（one_ticket_per_table）', () => {
    insert(waiting({ id: 'k-1', state: 'CALLED', tableId: 't-1', calledAt: NOW, holdDeadline: NOW + minutes(7) }));
    expect(refusal(() =>
      insert(
        waiting({
          id: 'k-2',
          code: 'A-02',
          state: 'SEATED',
          tableId: 't-1',
          seatedAt: NOW,
        }),
      ),
    )).toMatch(/UNIQUE constraint failed: tickets\.table_id/);
  });

  it('生きている 2 枚が同じ表示コードを持つこと（unique_active_codes）', () => {
    insert(waiting({ id: 'k-1', code: 'A-07' }));
    expect(refusal(() =>
      insert(waiting({ id: 'k-2', code: 'A-07' })))).toMatch(/UNIQUE constraint failed: tickets\.venue_id, tickets\.code/);
  });

  it('（終わったチケットは、同じコードが使い回されても残る）', () => {
    insert(waiting({ id: 'k-1', code: 'A-07', state: 'DONE', endedAt: NOW, endReason: 'checked_out' }));
    expect(() => insert(waiting({ id: 'k-2', code: 'A-07' }))).not.toThrow();
  });

  it('呼び出し中なのに席を持たないこと（assigned_has_table）', () => {
    expect(refusal(() =>
      insert(waiting({ state: 'CALLED', calledAt: NOW, holdDeadline: NOW + minutes(7) })),
    )).toMatch(/assigned_has_table/);
  });

  it('終わったのに席を持ち続けること（terminal_holds_no_table）', () => {
    expect(refusal(() =>
      insert(waiting({ state: 'DONE', endedAt: NOW, endReason: 'checked_out', tableId: 't-1' })),
    )).toMatch(/terminal_holds_no_table/);
  });

  it('呼び出し中なのに期限が無いこと（held_table_has_deadline）', () => {
    expect(refusal(() =>
      insert(waiting({ state: 'CALLED', tableId: 't-1', calledAt: NOW })))).toMatch(/held_table_has_deadline/);
  });

  it('着席中なのに着席の時刻が無いこと（state_timestamps_are_set）', () => {
    expect(refusal(() =>
      insert(waiting({ state: 'SEATED', tableId: 't-1' })))).toMatch(/state_timestamps_are_set/);
  });

  it('待っているのに保留の起点が残っていること（notices_are_scoped）', () => {
    expect(refusal(() =>
      insert(waiting({ pausedSince: NOW })))).toMatch(/notices_are_scoped/);
  });

  it('ノーショーをキャンセルとして記録すること（end_reason_matches_state）', () => {
    expect(refusal(() =>
      insert(waiting({ state: 'NO_SHOW', endedAt: NOW, endReason: 'user_cancel' })),
    )).toMatch(/end_reason_matches_state/);
  });

  it('0 人の組（party_size_is_positive）', () => {
    expect(refusal(() =>
      insert(waiting({ partySize: 0 })))).toMatch(/party_size_is_positive/);
  });

  it('ドメインが宣言していない状態（ticket_state_is_declared）', () => {
    expect(refusal(() =>
      db.run(
        sql`INSERT INTO tickets (id, venue_id, code, party_size, state, priority_at, created_at, last_seen_at)
            VALUES ('k-9', ${VENUE_ID}, 'A-09', 2, 'LINGERING', ${NOW}, ${NOW}, ${NOW})`,
      ),
    )).toMatch(/ticket_state_is_declared/);
  });

  it('存在しない席を指すこと（外部キーが本当に効いている）', () => {
    expect(refusal(() =>
      insert(waiting({ state: 'SEATED', tableId: 't-missing', seatedAt: NOW })),
    )).toMatch(/FOREIGN KEY/i);
  });
});

describe('席の表が断るもの', () => {
  it('誰も座れない定員（capacity_is_positive）', () => {
    expect(refusal(() =>
      db.update(tables).set({ capacity: 0 }).run())).toMatch(/capacity_is_positive/);
  });

  it('対象外なのに使える姿の席（unmanaged_table_is_disabled）', () => {
    expect(refusal(() =>
      db.update(tables).set({ enabled: false, status: 'FREE' }).run())).toMatch(/unmanaged_table_is_disabled/);
  });

  it('運用から外れた席に残る「対象外にする」予約（disabled_table_has_no_reservation）', () => {
    expect(refusal(() =>
      db.update(tables).set({ status: 'DISABLED', disableAfterCurrent: true }).run(),
    )).toMatch(/disabled_table_has_no_reservation/);
  });

  it('誰も使っていない席に残る占有者（occupant_only_when_taken）', () => {
    expect(refusal(() =>
      db.update(tables).set({ status: 'FREE', occupantTicketId: 'k-1' }).run(),
    )).toMatch(/occupant_only_when_taken/);
  });

  it('同じ席番号の席が 2 つ（tables_venue_label）', () => {
    expect(refusal(() =>
      db
        .insert(tables)
        .values({
          id: 't-3',
          venueId: VENUE_ID,
          token: 'token-3',
          label: 'T-01',
          capacity: 2,
          status: 'DISABLED',
          statusSince: NOW,
        })
        .run(),
    )).toMatch(/UNIQUE constraint failed: tables\.venue_id, tables\.label/);
  });

  it('同じ座席 QR を持つ席が 2 つ（tables_token）', () => {
    expect(refusal(() =>
      db
        .insert(tables)
        .values({
          id: 't-3',
          venueId: VENUE_ID,
          token: 'token-1',
          label: 'T-03',
          capacity: 2,
          status: 'DISABLED',
          statusSince: NOW,
        })
        .run(),
    )).toMatch(/UNIQUE constraint failed: tables\.token/);
  });
});

describe('施設の表が断るもの', () => {
  it('運用していないのに受付だけ開くこと（join_requires_operating）', () => {
    expect(refusal(() =>
      db.update(venues).set({ operating: false, joinOpen: true }).run())).toMatch(/join_requires_operating/);
  });
});

describe('席の姿の履歴が断るもの', () => {
  it('1 つの席に、開いた区間が 2 つ（one_open_span_per_table）', () => {
    expect(refusal(() =>
      db
        .insert(tableStatusLog)
        .values({ venueId: VENUE_ID, tableId: 't-1', status: 'FREE', fromAt: NOW, untilAt: null })
        .run(),
    )).toMatch(/UNIQUE constraint failed: table_status_log\.table_id/);
  });

  it('始まる前に終わる区間（span_moves_forward）', () => {
    expect(refusal(() =>
      db
        .insert(tableStatusLog)
        .values({
          venueId: VENUE_ID,
          tableId: 't-1',
          status: 'FREE',
          fromAt: NOW,
          untilAt: NOW - 1,
        })
        .run(),
    )).toMatch(/span_moves_forward/);
  });
});
