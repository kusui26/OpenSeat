import { describe, expect, it } from 'vitest';
import { minutes, type Timestamp } from '../time.js';
import {
  ACTIVE_TICKET_STATES,
  END_REASONS,
  END_REASON_STATES,
  TERMINAL_TICKET_STATES,
  TICKET_STATES,
  comparePriority,
  createTicket,
  holdsTable,
  isActive,
  isTerminal,
  type Ticket,
  type TicketState,
} from './ticket.js';

const NOW: Timestamp = 1_700_000_000_000;

function ticketAt(id: string, priorityAt: Timestamp, conflictPriority = false): Ticket {
  return {
    ...createTicket({ id, code: 'A-01', partySize: 2, now: priorityAt }),
    conflictPriority,
  };
}

describe('チケットの状態（全体プラン 7.3）', () => {
  it('状態は 8 種類', () => {
    expect(TICKET_STATES).toEqual([
      'WAITING',
      'PAUSED',
      'CALLED',
      'SEATED',
      'DONE',
      'CANCELLED',
      'NO_SHOW',
      'EXPIRED',
    ]);
  });

  it('終端は 4 種類', () => {
    expect(TERMINAL_TICKET_STATES).toEqual(['DONE', 'CANCELLED', 'NO_SHOW', 'EXPIRED']);
  });

  it('生きている状態は 4 種類', () => {
    expect(ACTIVE_TICKET_STATES).toEqual(['WAITING', 'PAUSED', 'CALLED', 'SEATED']);
  });

  it('終端と生きている状態を合わせると全状態になり、重なりが無い', () => {
    const union = [...TERMINAL_TICKET_STATES, ...ACTIVE_TICKET_STATES];
    expect(new Set(union).size).toBe(union.length);
    expect([...union].sort()).toEqual([...TICKET_STATES].sort());
  });

  it.each(TICKET_STATES)('%s は終端か生きているかのどちらか一方', (state: TicketState) => {
    expect(isTerminal(state)).toBe(!isActive(state));
  });

  it.each(TERMINAL_TICKET_STATES)('%s は終端', (state) => {
    expect(isTerminal(state)).toBe(true);
  });

  it.each(ACTIVE_TICKET_STATES)('%s は生きている', (state) => {
    expect(isActive(state)).toBe(true);
  });

  it('席を持つのは CALLED と SEATED だけ', () => {
    const holding = TICKET_STATES.filter((state) => holdsTable(state));
    expect(holding).toEqual(['CALLED', 'SEATED']);
  });

  it('isTerminal が真になる状態の集合は TERMINAL_TICKET_STATES と一致する', () => {
    const terminal = TICKET_STATES.filter((state) => isTerminal(state));
    expect([...terminal].sort()).toEqual([...TERMINAL_TICKET_STATES].sort());
  });

  it('isActive が真になる状態の集合は ACTIVE_TICKET_STATES と一致する', () => {
    const active = TICKET_STATES.filter((state) => isActive(state));
    expect([...active].sort()).toEqual([...ACTIVE_TICKET_STATES].sort());
  });

  it('席を持つ状態はすべて生きている状態に含まれる', () => {
    const holding = TICKET_STATES.filter((state) => holdsTable(state));
    for (const state of holding) {
      expect(isActive(state), `${state} は生きている状態であるべき`).toBe(true);
    }
  });
});

describe('終わり方と終端状態の対応', () => {
  it('終わり方は 10 種類', () => {
    expect(END_REASONS).toHaveLength(10);
  });

  it('すべての終わり方に、到達する終端状態が定められている', () => {
    for (const reason of END_REASONS) {
      expect(END_REASON_STATES[reason], `${reason} の終端状態`).toBeDefined();
    }
  });

  it('対応表のキーは終わり方の一覧と一致する', () => {
    expect(Object.keys(END_REASON_STATES).sort()).toEqual([...END_REASONS].sort());
  });

  it.each(TERMINAL_TICKET_STATES)('%s に到達する終わり方が 1 つ以上ある', (terminal) => {
    const reasons = END_REASONS.filter((reason) => END_REASON_STATES[reason] === terminal);
    expect(reasons.length).toBeGreaterThan(0);
  });

  it('退席・スタッフ操作・自動解放は DONE に落ちる', () => {
    expect(END_REASON_STATES.checked_out).toBe('DONE');
    expect(END_REASON_STATES.staff_checkout).toBe('DONE');
    expect(END_REASON_STATES.auto_release).toBe('DONE');
  });

  it('施設都合のキャンセルは CANCELLED に落ちる（NO_SHOW ではない）', () => {
    expect(END_REASON_STATES.venue_closed).toBe('CANCELLED');
  });

  it('放置と保留の期限切れと絶対上限は EXPIRED に落ちる', () => {
    expect(END_REASON_STATES.abandoned).toBe('EXPIRED');
    expect(END_REASON_STATES.pause_expired).toBe('EXPIRED');
    expect(END_REASON_STATES.max_age).toBe('EXPIRED');
  });
});

describe('createTicket', () => {
  it('受付直後は WAITING で、席を持たない', () => {
    const ticket = createTicket({ id: 't1', code: 'A-01', partySize: 3, now: NOW });
    expect(ticket.state).toBe('WAITING');
    expect(ticket.tableId).toBeNull();
    expect(ticket.calledAt).toBeNull();
    expect(ticket.endReason).toBeNull();
  });

  it('順番の基準と受付時刻が同じ値で始まる', () => {
    const ticket = createTicket({ id: 't1', code: 'A-01', partySize: 2, now: NOW });
    expect(ticket.priorityAt).toBe(NOW);
    expect(ticket.createdAt).toBe(NOW);
  });

  it('回数の欄はすべて 0 から始まる', () => {
    const ticket = createTicket({ id: 't1', code: 'A-01', partySize: 2, now: NOW });
    expect(ticket.extensions).toBe(0);
    expect(ticket.passes).toBe(0);
    expect(ticket.noShows).toBe(0);
    expect(ticket.pausedTotal).toBe(0);
  });

  it('希望タグと通知手段は省略できる', () => {
    const ticket = createTicket({ id: 't1', code: 'A-01', partySize: 2, now: NOW });
    expect(ticket.requiredTags).toEqual([]);
    expect(ticket.hasNotificationChannel).toBe(false);
  });

  it('希望タグと通知手段を指定できる', () => {
    const ticket = createTicket({
      id: 't1',
      code: 'A-01',
      partySize: 2,
      now: NOW,
      requiredTags: ['wheelchair'],
      hasNotificationChannel: true,
    });
    expect(ticket.requiredTags).toEqual(['wheelchair']);
    expect(ticket.hasNotificationChannel).toBe(true);
  });
});

describe('comparePriority（順番の比較）', () => {
  it('受付が早い人が先', () => {
    const early = ticketAt('t1', NOW);
    const late = ticketAt('t2', NOW + minutes(5));
    expect(comparePriority(early, late)).toBeLessThan(0);
    expect(comparePriority(late, early)).toBeGreaterThan(0);
  });

  it('席が塞がっていた人は、同じ時刻の他者より先（全体プラン 7.8）', () => {
    const conflicted = ticketAt('t2', NOW, true);
    const normal = ticketAt('t1', NOW, false);
    expect(comparePriority(conflicted, normal)).toBeLessThan(0);
  });

  it('席が塞がっていた人でも、より早く受付した人は追い越せない', () => {
    const conflicted = ticketAt('t2', NOW + minutes(5), true);
    const earlier = ticketAt('t1', NOW, false);
    expect(comparePriority(conflicted, earlier)).toBeGreaterThan(0);
  });

  it('同時刻・同条件なら ID で決定的に並ぶ', () => {
    const a = ticketAt('a', NOW);
    const b = ticketAt('b', NOW);
    expect(comparePriority(a, b)).toBeLessThan(0);
    expect(comparePriority(b, a)).toBeGreaterThan(0);
  });

  it('同じチケット同士は 0', () => {
    const ticket = ticketAt('t1', NOW);
    expect(comparePriority(ticket, ticket)).toBe(0);
  });

  it('並べ替えの結果が入力の順序に依存しない', () => {
    const tickets = [ticketAt('c', NOW), ticketAt('a', NOW), ticketAt('b', NOW)];
    const forward = [...tickets].sort(comparePriority).map((ticket) => ticket.id);
    const backward = [...tickets].reverse().sort(comparePriority).map((ticket) => ticket.id);
    expect(forward).toEqual(['a', 'b', 'c']);
    expect(backward).toEqual(forward);
  });
});
