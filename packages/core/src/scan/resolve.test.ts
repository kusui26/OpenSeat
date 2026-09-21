import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, type Policy } from '../domain/policy.js';
import { createTable, TABLE_STATUSES, type Table, type TableStatus } from '../domain/table.js';
import { createTicket, TICKET_STATES, type Ticket, type TicketState } from '../domain/ticket.js';
import { createVenueState, type VenueState } from '../domain/state.js';
import { COMMAND_TYPES, type CommandType } from '../machine/command.js';
import { minutes, type Timestamp } from '../time.js';
import { resolveTableScan, TABLE_SCAN_KINDS, type TableScanKind } from './resolve.js';

/**
 * 座席 QR の分岐（全体プラン 7.8）。
 *
 * 7.8 の表の 10 行を 1 行 1 テストで写したうえで、**表に無い組み合わせも
 * すべて答えを持つこと**を確かめる。同じ QR が受付・着席・退席・報告を
 * 兼ねる以上、答えの無い組み合わせが 1 つでもあると画面が固まる。
 */

const NOW: Timestamp = 1_700_000_000_000;
const SCANNED = 'tb-scanned';
const OTHER = 'tb-other';

function table(id: string, capacity: number, overrides: Partial<Table> = {}): Table {
  return { ...createTable({ id, label: id, capacity, now: NOW }), status: 'FREE', ...overrides };
}

function ticket(id: string, overrides: Partial<Ticket> = {}): Ticket {
  return { ...createTicket({ id, code: id, partySize: 2, now: NOW }), ...overrides };
}

function venue(
  tables: readonly Table[],
  tickets: readonly Ticket[] = [],
  policy: Policy = DEFAULT_POLICY,
): VenueState {
  return {
    ...createVenueState({ venueId: 'v1', policy, tables }),
    tickets,
    operating: true,
    joinOpen: true,
  };
}

function scan(state: VenueState, ticketId: string | null, tableId = SCANNED): {
  kind: TableScanKind;
  actions: readonly CommandType[];
  assignedTableId: string | null;
  staleTicket: boolean;
} {
  const outcome = resolveTableScan(state, tableId, ticketId);
  if (outcome === null) throw new Error(`席が見つからない: ${tableId}`);
  return outcome;
}

// ---------------------------------------------------------------------------

describe('7.8 の表の 10 行', () => {
  it('1. 呼ばれていて、この席が自分の席 → 着席するか、誰かが座っていたと報告する', () => {
    const called = ticket('k1', {
      state: 'CALLED',
      tableId: SCANNED,
      calledAt: NOW,
      holdDeadline: NOW + minutes(7),
    });
    const state = venue([table(SCANNED, 4, { status: 'HELD', occupantTicketId: 'k1' })], [called]);
    expect(scan(state, 'k1')).toMatchObject({
      kind: 'check_in',
      actions: ['CHECK_IN', 'REPORT_TAKEN'],
      assignedTableId: SCANNED,
    });
  });

  it('2. 呼ばれていて別の席が自分の席、この席は空いて収まる → 席の変更を出す', () => {
    const called = ticket('k1', {
      state: 'CALLED',
      tableId: OTHER,
      calledAt: NOW,
      holdDeadline: NOW + minutes(7),
    });
    const state = venue(
      [table(SCANNED, 4), table(OTHER, 4, { status: 'HELD', occupantTicketId: 'k1' })],
      [called],
    );
    expect(scan(state, 'k1')).toMatchObject({
      kind: 'swap_offer',
      actions: ['SWAP_TABLE'],
      assignedTableId: OTHER,
    });
  });

  it('3. 呼ばれていて別の席が自分の席、この席は使えない → 自分の席を案内するだけ', () => {
    const called = ticket('k1', {
      state: 'CALLED',
      tableId: OTHER,
      calledAt: NOW,
      holdDeadline: NOW + minutes(7),
    });
    const state = venue(
      [table(SCANNED, 4, { status: 'OCCUPIED' }), table(OTHER, 4, { status: 'HELD', occupantTicketId: 'k1' })],
      [called],
    );
    expect(scan(state, 'k1')).toMatchObject({
      kind: 'other_table',
      actions: [],
      assignedTableId: OTHER,
    });
  });

  /**
   * **この状態は、`apply` と `tick` を通った施設には現れない。** 収まる空席が
   * あれば、その人はその瞬間にもう呼ばれている（不変条件 `no_starvation`）。
   * 分岐そのものを確かめるために手で組んでいる。前倒しの着席が実際に要るのは
   * 「確認要」の席のほうで（7.11 の 3 層目）、そちらは下の describe で見ている。
   */
  it('4. 待っていて、空席で収まり、順番を崩さない → すぐ使えるようにする', () => {
    const state = venue([table(SCANNED, 2)], [ticket('k1')]);
    expect(scan(state, 'k1')).toMatchObject({ kind: 'early_check_in', actions: ['CHECK_IN_EARLY'] });
  });

  it('5. 着席中で、この席が自分の席 → ご利用中の画面', () => {
    const seated = ticket('k1', { state: 'SEATED', tableId: SCANNED, seatedAt: NOW });
    const state = venue([table(SCANNED, 4, { status: 'OCCUPIED', occupantTicketId: 'k1' })], [seated]);
    expect(scan(state, 'k1')).toMatchObject({ kind: 'seated_here', actions: ['CHECK_OUT'] });
  });

  it('6. チケットなしで空席、収まる待ちがいない → 飛び込み着席を出す（7.12）', () => {
    const state = venue([table(SCANNED, 4)]);
    expect(scan(state, null)).toMatchObject({ kind: 'walk_in_offer', actions: ['WALK_IN'] });
  });

  /**
   * **これも手で組んだ状態である。** 「待ちがいる」は「その席に収まる待ちが
   * いる」と読むので（7.8 の 7 行目）、収まる人が待っている空席は残らない。
   * 空席の QR にはいつでも飛び込み着席を出せることは、`resolve.property.test.ts`
   * が確かめている。
   */
  it('7. チケットなしで空席、待ちがいる → 受付へ誘導する', () => {
    const state = venue([table(SCANNED, 4)], [ticket('k1')]);
    expect(scan(state, null)).toMatchObject({ kind: 'queue_first', actions: [] });
  });

  it('8. チケットなしで確保中 → 呼び出し中のお客様の席である旨', () => {
    const state = venue([table(SCANNED, 4, { status: 'HELD', occupantTicketId: 'k1' })]);
    expect(scan(state, null)).toMatchObject({ kind: 'held_for_other', actions: [] });
  });

  it('9. チケットなしで使用中 → 使用中である旨。誰か分からない席なら報告できる', () => {
    const known = venue([table(SCANNED, 4, { status: 'OCCUPIED', occupantTicketId: 'k1' })]);
    expect(scan(known, null)).toMatchObject({ kind: 'in_use', actions: [] });

    const unknown = venue([table(SCANNED, 4, { status: 'OCCUPIED_UNKNOWN' })]);
    expect(scan(unknown, null)).toMatchObject({ kind: 'in_use', actions: ['CONFIRM_FREE'] });
  });

  it('10. 呼ばれた席に誰かが座っていた → 同じ画面の「誰かが座っています」で報告する', () => {
    const called = ticket('k1', {
      state: 'CALLED',
      tableId: SCANNED,
      calledAt: NOW,
      holdDeadline: NOW + minutes(7),
    });
    const state = venue([table(SCANNED, 4, { status: 'HELD', occupantTicketId: 'k1' })], [called]);
    expect(scan(state, 'k1').actions).toContain('REPORT_TAKEN');
  });
});

describe('7.8 に無い組み合わせ', () => {
  it('保留中の人は、まず「準備OK」を押す', () => {
    const paused = ticket('k1', {
      state: 'PAUSED',
      pauseDeadline: NOW + minutes(10),
      pausedSince: NOW,
    });
    const state = venue([table(SCANNED, 4)], [paused]);
    expect(scan(state, 'k1')).toMatchObject({ kind: 'resume_first', actions: ['READY'] });
  });

  it('待っていても、順番を崩す席なら何も出さない', () => {
    const earlier = ticket('k1', { partySize: 2, priorityAt: NOW });
    const later = ticket('k2', { partySize: 2, priorityAt: NOW + minutes(5) });
    const state = venue([table(SCANNED, 2)], [earlier, later]);
    expect(scan(state, 'k2')).toMatchObject({ kind: 'keep_waiting', actions: [] });
    expect(scan(state, 'k1')).toMatchObject({ kind: 'early_check_in' });
  });

  it('着席中の人が別の席を読んだら、自分の席を案内する', () => {
    const seated = ticket('k1', { state: 'SEATED', tableId: OTHER, seatedAt: NOW });
    const state = venue(
      [table(SCANNED, 4), table(OTHER, 4, { status: 'OCCUPIED', occupantTicketId: 'k1' })],
      [seated],
    );
    expect(scan(state, 'k1')).toMatchObject({ kind: 'seated_elsewhere', assignedTableId: OTHER });
  });

  it('片付け中の席は、まもなく案内できる旨', () => {
    const state = venue([table(SCANNED, 4, { status: 'TURNOVER' })]);
    expect(scan(state, null)).toMatchObject({ kind: 'turnover', actions: [] });
  });

  it('対象外の席は、順番待ちと関係ない旨', () => {
    const state = venue([table(SCANNED, 4, { status: 'DISABLED' })]);
    expect(scan(state, null)).toMatchObject({ kind: 'not_managed', actions: [] });
  });

  /** 対象外になっても、そこに座っている人は退席できる。閉じ込めない。 */
  it('対象外の席でも、着席中の人は退席できる', () => {
    const seated = ticket('k1', { state: 'SEATED', tableId: SCANNED, seatedAt: NOW });
    const state = venue([table(SCANNED, 4, { status: 'DISABLED', enabled: false })], [seated]);
    expect(scan(state, 'k1')).toMatchObject({ kind: 'seated_here', actions: ['CHECK_OUT'] });
  });

  it('存在しない席の QR には答えを返さない', () => {
    expect(resolveTableScan(venue([table(SCANNED, 4)]), 'missing', null)).toBeNull();
  });
});

describe('呼び出しが無効になったあとで席に来た人（7.7 の 8）', () => {
  const expired = ticket('k1', { state: 'EXPIRED', endedAt: NOW, endReason: 'max_age' });

  it('チケットが終わっていることを伝える', () => {
    const state = venue([table(SCANNED, 4)], [expired]);
    expect(scan(state, 'k1').staleTicket).toBe(true);
  });

  it('空席で待ちがなければ、そのまま飛び込み着席できる', () => {
    const state = venue([table(SCANNED, 4)], [expired]);
    expect(scan(state, 'k1')).toMatchObject({ kind: 'walk_in_offer', actions: ['WALK_IN'] });
  });

  it('待ちがいれば受付へ誘導する', () => {
    const state = venue([table(SCANNED, 4)], [expired, ticket('k2')]);
    expect(scan(state, 'k1')).toMatchObject({ kind: 'queue_first', actions: [] });
  });

  it('生きているチケットでは立たない', () => {
    const state = venue([table(SCANNED, 4)], [ticket('k1')]);
    expect(scan(state, 'k1').staleTicket).toBe(false);
  });
});

describe('確認要の席（7.11 の 3 層目）', () => {
  const needsCheck = table(SCANNED, 4, { status: 'NEEDS_CHECK' });

  it('案内された人には、そのまま座るか使用中かを選ばせる', () => {
    const state = venue([needsCheck], [ticket('k1')]);
    expect(scan(state, 'k1')).toMatchObject({
      kind: 'needs_check',
      actions: ['CHECK_IN_EARLY', 'REPORT_IN_USE'],
    });
  });

  it('案内されていない人には、空席か使用中かを知らせてもらう', () => {
    // k1 が案内される（受付が早い）。k2 は同じ席を見に来ただけ。
    const state = venue([needsCheck], [ticket('k1'), ticket('k2', { createdAt: NOW + minutes(1), priorityAt: NOW + minutes(1) })]);
    expect(scan(state, 'k2')).toMatchObject({
      kind: 'needs_check',
      actions: ['CONFIRM_FREE', 'REPORT_IN_USE'],
    });
  });

  it('案内を切っている施設では、待っている人も知らせるだけになる', () => {
    const state = venue([needsCheck], [ticket('k1')], { ...DEFAULT_POLICY, assignNeedsCheck: false });
    expect(scan(state, 'k1')).toMatchObject({
      kind: 'needs_check',
      actions: ['CONFIRM_FREE', 'REPORT_IN_USE'],
    });
  });

  it('確実な空席があるうちは、確認要の席に案内しない', () => {
    const state = venue([needsCheck, table(OTHER, 4)], [ticket('k1')]);
    expect(scan(state, 'k1')).toMatchObject({
      kind: 'needs_check',
      actions: ['CONFIRM_FREE', 'REPORT_IN_USE'],
    });
  });

  it('チケットを持たない人には、空席か使用中かを知らせてもらう', () => {
    expect(scan(venue([needsCheck]), null)).toMatchObject({
      kind: 'needs_check',
      actions: ['CONFIRM_FREE', 'REPORT_IN_USE'],
    });
  });

  /**
   * **着席の記録が残っている席では「空いていました」を出さない**（7.11 の 3 層目）。
   * 押せばその記録の人のチケットが終わるので、スタッフだけの操作にしてある
   * （`machine/scan-commands.test.ts` の「確認要の席を空席に戻せる人」）。
   */
  const withRecord = table(SCANNED, 4, { status: 'NEEDS_CHECK', occupantTicketId: 'k9' });
  const occupant = ticket('k9', { state: 'SEATED', tableId: SCANNED, seatedAt: NOW });

  it('記録が残る席では、チケットのない人に「使用中でした」だけを出す', () => {
    expect(scan(venue([withRecord], [occupant]), null)).toMatchObject({
      kind: 'needs_check',
      actions: ['REPORT_IN_USE'],
    });
  });

  it('記録が残る席では、案内されていない待ち人にも「使用中でした」だけを出す', () => {
    const state = venue([withRecord, table(OTHER, 4, { status: 'NEEDS_CHECK' })], [occupant, ticket('k1')]);
    expect(scan(state, 'k1')).toMatchObject({ kind: 'needs_check', actions: ['REPORT_IN_USE'] });
  });

  /** 案内された本人は、座ることで解消できる。確かめに行った人がその席を得る（7.11）。 */
  it('記録が残る席でも、案内された人はそのまま座れる', () => {
    expect(scan(venue([withRecord], [occupant, ticket('k1')]), 'k1')).toMatchObject({
      kind: 'needs_check',
      actions: ['CHECK_IN_EARLY', 'REPORT_IN_USE'],
    });
  });
});

describe('席の変更の条件（7.8 の 2 行目）', () => {
  function calledElsewhere(scanned: Table, policy: Policy = DEFAULT_POLICY): VenueState {
    const called = ticket('k1', {
      state: 'CALLED',
      tableId: OTHER,
      calledAt: NOW,
      holdDeadline: NOW + minutes(7),
      partySize: 3,
    });
    return venue([scanned, table(OTHER, 4, { status: 'HELD', occupantTicketId: 'k1' })], [called], policy);
  }

  it('人数が収まらなければ変更を出さない', () => {
    expect(scan(calledElsewhere(table(SCANNED, 2)), 'k1').kind).toBe('other_table');
  });

  it('希望タグを満たさなければ変更を出さない', () => {
    const wheelchair = ticket('k1', {
      state: 'CALLED',
      tableId: OTHER,
      calledAt: NOW,
      holdDeadline: NOW + minutes(7),
      requiredTags: ['wheelchair'],
    });
    const state = venue(
      [table(SCANNED, 4), table(OTHER, 4, { status: 'HELD', occupantTicketId: 'k1', tags: ['wheelchair'] })],
      [wheelchair],
    );
    expect(scan(state, 'k1').kind).toBe('other_table');
  });

  it('設定で禁じられていれば変更を出さない', () => {
    const strict: Policy = { ...DEFAULT_POLICY, allowTableSwap: false };
    expect(scan(calledElsewhere(table(SCANNED, 4), strict), 'k1').kind).toBe('other_table');
  });

  it('対象外の席へは移れない', () => {
    const disabled = table(SCANNED, 4, { enabled: false, status: 'DISABLED' });
    expect(scan(calledElsewhere(disabled), 'k1').kind).toBe('not_managed');
  });
});

// ---------------------------------------------------------------------------

describe('答えの無い組み合わせが 1 つも無い', () => {
  /**
   * **席 7 状態 × 読み取った人 9 通り（チケットなし ＋ 8 つの状態）= 63 通り。**
   *
   * 7.8 の表は主な組み合わせしか書いていないが、実装はすべてに答えなければ
   * ならない。ここで総当たりし、どれも宣言された種別に落ちることを確かめる。
   */
  const SCANNERS = ['none', ...TICKET_STATES] as const;

  function stateFor(status: TableStatus, scanner: (typeof SCANNERS)[number]): VenueState {
    const scanned = table(SCANNED, 4, {
      status,
      enabled: status !== 'DISABLED',
      occupantTicketId: status === 'HELD' || status === 'OCCUPIED' ? 'k1' : null,
    });
    if (scanner === 'none') return venue([scanned, table(OTHER, 4)]);
    return venue([scanned, table(OTHER, 4)], [scannerTicket(scanner, status)]);
  }

  /** 読み取った人。席を持つ状態では、読み取った席を自分の席にしておく。 */
  function scannerTicket(state: TicketState, status: TableStatus): Ticket {
    const holdsScanned = status === 'HELD' || status === 'OCCUPIED';
    return ticket('k1', {
      state,
      tableId: state === 'CALLED' || state === 'SEATED' ? (holdsScanned ? SCANNED : OTHER) : null,
      calledAt: state === 'CALLED' ? NOW : null,
      holdDeadline: state === 'CALLED' ? NOW + minutes(7) : null,
      seatedAt: state === 'SEATED' ? NOW : null,
      pauseDeadline: state === 'PAUSED' ? NOW + minutes(10) : null,
      pausedSince: state === 'PAUSED' ? NOW : null,
      endedAt: state === 'DONE' ? NOW : null,
      endReason: state === 'DONE' ? 'checked_out' : null,
    });
  }

  const combinations = TABLE_STATUSES.flatMap((status) =>
    SCANNERS.map((scanner) => ({ status, scanner })),
  );

  it('席 7 状態 × 読み取った人 9 通りの 63 通りを試す', () => {
    expect(TABLE_STATUSES).toHaveLength(7);
    expect(SCANNERS).toHaveLength(9);
    expect(combinations).toHaveLength(63);
  });

  it.each(combinations)('$status の席を $scanner が読んでも、答えが返る', ({ status, scanner }) => {
    const outcome = resolveTableScan(stateFor(status, scanner), SCANNED, scanner === 'none' ? null : 'k1');
    expect(outcome).not.toBeNull();
    expect(TABLE_SCAN_KINDS).toContain(outcome?.kind);
  });

  it('出す操作は、すべて実在するコマンドの種別である', () => {
    for (const { status, scanner } of combinations) {
      const outcome = resolveTableScan(stateFor(status, scanner), SCANNED, scanner === 'none' ? null : 'k1');
      for (const action of outcome?.actions ?? []) {
        expect(COMMAND_TYPES).toContain(action);
      }
    }
  });

  it('宣言された種別は、すべてどこかの組み合わせで出る（死んだ種別が無い）', () => {
    const produced = new Set<TableScanKind>();
    for (const { status, scanner } of combinations) {
      const outcome = resolveTableScan(stateFor(status, scanner), SCANNED, scanner === 'none' ? null : 'k1');
      if (outcome !== null) produced.add(outcome.kind);
    }
    // 1 つだけは、ほかに収まる待ちの人がいる状態が要るので、この総当たりには
    // 出ない（上の describe で 1 本見ている）。そしてその状態は、apply と tick を
    // 通った施設には現れない（resolve.property.test.ts が見張っている）。
    const needsMoreSetup: readonly TableScanKind[] = [
      'queue_first', // 空席だが、ほかに収まる待ちの人がいる（7.8 の 7）
    ];
    const expected = TABLE_SCAN_KINDS.filter((kind) => !needsMoreSetup.includes(kind));
    expect([...produced].sort()).toEqual([...expected].sort());
  });

  it('読み取った席は、必ず結果に載る', () => {
    for (const { status, scanner } of combinations) {
      const outcome = resolveTableScan(stateFor(status, scanner), SCANNED, scanner === 'none' ? null : 'k1');
      expect(outcome?.tableId).toBe(SCANNED);
    }
  });
});
