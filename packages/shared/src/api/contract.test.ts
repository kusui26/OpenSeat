/**
 * 契約と `core` の型が食い違わないこと。
 *
 * **契約は `core` の宣言から作っている**（`z.enum(TICKET_STATES)` のように）。
 * ここで見るのは、その作り方が効いているかである。手で書き写した並びが混ざったら
 * 落ちる。
 */

import {
  COMMAND_TYPES,
  CANCEL_REASONS,
  DEFAULT_POLICY,
  END_REASONS,
  TABLE_SCAN_KINDS,
  TABLE_STATUSES,
  TICKET_STATES,
  createTable,
  createTicket,
  createVenueState,
  type Ticket,
} from '@openseat/core';
import { describe, expect, it } from 'vitest';
import {
  CancelReason,
  EndReason,
  TableScanKind,
  TableStatus,
  TicketState,
} from '../values.js';
import { AvailableAction, TableView, TicketView } from './views.js';
import { VenueStatusResponse } from './venue.js';

describe('列挙は core の宣言そのもの', () => {
  it.each([
    ['TicketState', TicketState.options, TICKET_STATES],
    ['TableStatus', TableStatus.options, TABLE_STATUSES],
    ['EndReason', EndReason.options, END_REASONS],
    ['CancelReason', CancelReason.options, CANCEL_REASONS],
    ['TableScanKind', TableScanKind.options, TABLE_SCAN_KINDS],
    ['AvailableAction', AvailableAction.options, COMMAND_TYPES],
  ])('%s が core と同じ並び', (_name, contract, core) => {
    expect(contract).toEqual([...core]);
  });
});

describe('core のチケットを、契約の形で返せる', () => {
  const NOW = Date.UTC(2027, 2, 6, 3, 0, 0);

  /**
   * 利用者に見せる形へ写す。
   *
   * **本物はサーバ側（PR 4）が持つ。** ここに置いてあるのは、**`core` の
   * チケットが契約に収まることを確かめるため**だけの最小の写しである。
   */
  function viewOf(ticket: Ticket): Readonly<Record<string, unknown>> {
    return {
      id: ticket.id,
      code: ticket.code,
      state: ticket.state,
      partySize: ticket.partySize,
      requiredTags: [...ticket.requiredTags],
      tableLabel: null,
      holdDeadline: ticket.holdDeadline,
      pauseDeadline: ticket.pauseDeadline,
      extensionsLeft: 1,
      eta: { kind: 'estimate', minutes: 12, fromMin: 10, toMin: 15, ahead: 3 },
      timeLimit: null,
      endReason: ticket.endReason,
      actions: ['CANCEL', 'PAUSE'],
    };
  }

  it('受付直後のチケットが、そのまま契約を通る', () => {
    const ticket = createTicket({ id: 'k-1', code: 'A-01', partySize: 2, now: NOW });
    expect(TicketView.safeParse(viewOf(ticket)).success).toBe(true);
  });

  it('タグつきのチケットも通る', () => {
    const ticket = createTicket({
      id: 'k-2',
      code: 'A-02',
      partySize: 4,
      now: NOW,
      requiredTags: ['wheelchair', 'power'],
    });
    const parsed = TicketView.safeParse(viewOf(ticket));
    expect(parsed.success && parsed.data.requiredTags).toEqual(['wheelchair', 'power']);
  });

  it('core が出さない状態は、契約が断る', () => {
    const ticket = createTicket({ id: 'k-3', code: 'A-03', partySize: 2, now: NOW });
    const broken = { ...viewOf(ticket), state: 'LINGERING' };
    expect(TicketView.safeParse(broken).success).toBe(false);
  });

  it('表示コードの形が違えば断る', () => {
    const ticket = createTicket({ id: 'k-4', code: 'a1', partySize: 2, now: NOW });
    expect(TicketView.safeParse(viewOf(ticket)).success).toBe(false);
  });
});

describe('core の施設の状態を、契約の形で返せる', () => {
  const NOW = Date.UTC(2027, 2, 6, 3, 0, 0);
  const state = createVenueState({
    venueId: 'v-1',
    policy: DEFAULT_POLICY,
    tables: [createTable({ id: 't-1', label: 'T-01', capacity: 2, now: NOW })],
  });

  it('席が、そのまま契約を通る', () => {
    const table = state.tables[0];
    const parsed = TableView.safeParse({
      label: table?.label,
      capacity: table?.capacity,
      tags: [...(table?.tags ?? [])],
      status: table?.status,
      calledCode: null,
    });
    expect(parsed.success).toBe(true);
  });

  it('運用の状態が、そのまま契約を通る', () => {
    const parsed = VenueStatusResponse.safeParse({
      serverNow: NOW,
      venue: {
        slug: 'demo',
        name: 'テスト施設',
        timezone: 'Asia/Tokyo',
        operating: state.operating,
        joinOpen: state.joinOpen,
        closesAt: state.closesAt,
      },
      waiting: 0,
      freeTables: 0,
      managedTables: state.tables.length,
      estimates: [{ partySize: 2, eta: { kind: 'no_seat' } }],
      longWaitConfirmMin: state.policy.longWaitConfirmMin,
    });
    expect(parsed.success).toBe(true);
  });
});
