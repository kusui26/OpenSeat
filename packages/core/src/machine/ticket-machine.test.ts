import { describe, expect, it } from 'vitest';
import {
  ACTIVE_TICKET_STATES,
  TERMINAL_TICKET_STATES,
  TICKET_STATES,
  type TicketState,
} from '../domain/ticket.js';
import { ambiguous, canReachAny, duplicates, outgoing, reachableFrom, statesIn } from './graph.js';
import {
  MAX_AGE_APPLIES_TO,
  TICKET_EVENTS,
  TICKET_GUARDS,
  TICKET_INITIAL_STATES,
  TICKET_TRANSITIONS,
  type TicketEvent,
} from './ticket-machine.js';
import { matching, transit } from './transit.js';

const ALL_PASS = (): boolean => true;
const ALL_FAIL = (): boolean => false;

/**
 * 全体プラン 7.3 の状態遷移図に描かれている矢印。
 *
 * **これが仕様との照合点である。** 図の 1 本の矢印が複数の事象をまとめている
 * ことがあるため（「本人キャンセル／スタッフ／施設都合」など）、ここでは
 * 起点と終点の組だけを写し、事象との対応は実装側の表が持つ。
 */
const DIAGRAM_ARROWS: readonly (readonly [TicketState, TicketState, string])[] = [
  ['WAITING', 'CALLED', '割当（空席発生 or 受付時に空席あり）'],
  ['WAITING', 'SEATED', '空席の座席QRを読んで前倒し着席'],
  ['WAITING', 'PAUSED', '「呼び出しを保留」'],
  ['WAITING', 'CANCELLED', '本人キャンセル／スタッフ／施設都合'],
  ['WAITING', 'EXPIRED', '放置／受付からの絶対上限'],
  ['PAUSED', 'WAITING', '「準備OK」'],
  ['PAUSED', 'CANCELLED', '本人キャンセル／スタッフ／施設都合'],
  ['PAUSED', 'EXPIRED', '保留の上限超過／受付からの絶対上限'],
  ['CALLED', 'SEATED', '座席QR読み取り／コード入力／スタッフ確認'],
  ['CALLED', 'CALLED', '延長／席の変更'],
  ['CALLED', 'PAUSED', '「パス」／ホールド期限切れ（1回目）'],
  ['CALLED', 'WAITING', 'ホールド期限切れ（末尾へ）／席が塞がっていた報告'],
  ['CALLED', 'NO_SHOW', 'ホールド期限切れ（2回目 or cancel）'],
  ['CALLED', 'CANCELLED', '本人キャンセル／スタッフ／施設都合'],
  ['SEATED', 'DONE', '退席／hard上限の自動解放／全席解放'],
];

function arrowsInTable(): ReadonlySet<string> {
  return new Set(TICKET_TRANSITIONS.map((row) => `${row.from}->${row.to}`));
}

describe('遷移表と全体プラン 7.3 の図の対応', () => {
  it('図のすべての矢印が表に存在する（実装に漏れが無い）', () => {
    const inTable = arrowsInTable();
    const missing = DIAGRAM_ARROWS.filter(([from, to]) => !inTable.has(`${from}->${to}`));
    expect(missing.map(([from, to, label]) => `${from}->${to}（${label}）`)).toEqual([]);
  });

  it('表のすべての矢印が図に存在する（実装に余分が無い）', () => {
    const inDiagram = new Set(DIAGRAM_ARROWS.map(([from, to]) => `${from}->${to}`));
    const extra = TICKET_TRANSITIONS.filter((row) => !inDiagram.has(`${row.from}->${row.to}`));
    expect(extra.map((row) => `${row.from}->${row.to}（${row.on}）`)).toEqual([]);
  });

  it('表は 25 本の遷移を宣言している', () => {
    expect(TICKET_TRANSITIONS).toHaveLength(25);
  });
});

describe('宣言の健全性', () => {
  it.each(TICKET_TRANSITIONS)('$from --$on--> $to が正しい形をしている', (row) => {
    expect(TICKET_STATES).toContain(row.from);
    expect(TICKET_STATES).toContain(row.to);
    expect(TICKET_EVENTS).toContain(row.on);
    if (row.guard !== null) expect(TICKET_GUARDS).toContain(row.guard);
    expect(row.source).toMatch(/^7\.\d+$/);
    expect(row.note.length).toBeGreaterThan(0);
  });

  it('同じ内容の行が二重に宣言されていない', () => {
    expect(duplicates(TICKET_TRANSITIONS)).toEqual([]);
  });

  it('同じ（状態、事象）に複数の行があるとき、無条件の行が混ざっていない', () => {
    // 無条件の行は常に成立し、後ろの行を覆い隠してしまう。
    const shadowing = ambiguous(TICKET_TRANSITIONS);
    expect(shadowing.map((row) => `${row.from}/${row.on}`)).toEqual([]);
  });

  it('宣言されたガードはすべて、いずれかの行から参照されている', () => {
    const used = new Set(TICKET_TRANSITIONS.map((row) => row.guard));
    const unused = TICKET_GUARDS.filter((guard) => !used.has(guard));
    expect(unused).toEqual([]);
  });

  it('宣言された事象はすべて、いずれかの行から参照されている', () => {
    const used = new Set<TicketEvent>(TICKET_TRANSITIONS.map((row) => row.on));
    const unused = TICKET_EVENTS.filter((event) => !used.has(event));
    expect(unused).toEqual([]);
  });

  it('ホールドの期限切れは 3 通りに分岐し、すべてガードつきで宣言されている', () => {
    const rows = matching(TICKET_TRANSITIONS, 'CALLED', 'HOLD_EXPIRE');
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.to).sort()).toEqual(['NO_SHOW', 'PAUSED', 'WAITING']);
    expect(rows.every((row) => row.guard !== null)).toBe(true);
  });
});

describe('グラフとしての性質', () => {
  const initial = Object.values(TICKET_INITIAL_STATES);

  it('チケットは受付か飛び込みで生まれる', () => {
    expect(TICKET_INITIAL_STATES.JOIN).toBe('WAITING');
    expect(TICKET_INITIAL_STATES.WALK_IN).toBe('SEATED');
  });

  it('すべての状態が初期状態から到達できる', () => {
    const reachable = reachableFrom(TICKET_TRANSITIONS, initial);
    const unreachable = TICKET_STATES.filter((state) => !reachable.has(state));
    expect(unreachable).toEqual([]);
  });

  it.each(TERMINAL_TICKET_STATES)('終端の %s から出る遷移が無い', (state) => {
    expect(outgoing(TICKET_TRANSITIONS, state)).toEqual([]);
  });

  it.each(ACTIVE_TICKET_STATES)('%s からいずれかの終端へ到達できる（行き止まりが無い）', (state) => {
    expect(canReachAny(TICKET_TRANSITIONS, state, TERMINAL_TICKET_STATES)).toBe(true);
  });

  it('表に現れる状態は、宣言された 8 状態の範囲に収まる', () => {
    for (const state of statesIn(TICKET_TRANSITIONS)) {
      expect(TICKET_STATES).toContain(state);
    }
  });

  it('保留は行き止まりにならない（準備OKで戻れる）', () => {
    const fromPaused = outgoing(TICKET_TRANSITIONS, 'PAUSED').map((row) => row.to);
    expect(fromPaused).toContain('WAITING');
  });
});

describe('transit（表に従って遷移する）', () => {
  it.each(TICKET_TRANSITIONS)('$from で $on が起きると $to へ進む', (row) => {
    const evaluate = (guard: string): boolean => guard === row.guard;
    const outcome = transit(TICKET_TRANSITIONS, row.from, row.on, evaluate);
    expect(outcome.kind).toBe('moved');
    if (outcome.kind === 'moved') {
      expect(outcome.to).toBe(row.to);
    }
  });

  it('表に無い組み合わせは undeclared として拒否される', () => {
    const declared = new Set(TICKET_TRANSITIONS.map((row) => `${row.from}/${row.on}`));
    const undeclared: string[] = [];
    for (const state of TICKET_STATES) {
      for (const event of TICKET_EVENTS) {
        if (declared.has(`${state}/${event}`)) continue;
        const outcome = transit(TICKET_TRANSITIONS, state, event, ALL_PASS);
        if (outcome.kind !== 'undeclared') undeclared.push(`${state}/${event}`);
      }
    }
    expect(undeclared).toEqual([]);
  });

  it('宣言されていない組み合わせの数は、全組み合わせから宣言分を引いた数', () => {
    const total = TICKET_STATES.length * TICKET_EVENTS.length;
    const declared = new Set(TICKET_TRANSITIONS.map((row) => `${row.from}/${row.on}`)).size;
    expect(total).toBe(8 * 17);
    expect(declared).toBeLessThan(total);
  });

  it('終端の状態ではどの事象も起こせない', () => {
    for (const state of TERMINAL_TICKET_STATES) {
      for (const event of TICKET_EVENTS) {
        expect(transit(TICKET_TRANSITIONS, state, event, ALL_PASS).kind).toBe('undeclared');
      }
    }
  });

  it('ガードが通らなければ blocked になり、試したガードが分かる', () => {
    const outcome = transit(TICKET_TRANSITIONS, 'CALLED', 'EXTEND', ALL_FAIL);
    expect(outcome.kind).toBe('blocked');
    if (outcome.kind === 'blocked') {
      expect(outcome.tried).toEqual(['underExtensionLimit']);
    }
  });

  it('無条件の遷移はガードの評価に関係なく通る', () => {
    expect(transit(TICKET_TRANSITIONS, 'WAITING', 'CANCEL', ALL_FAIL).kind).toBe('moved');
  });

  it('ホールドの期限切れは、成立したガードに応じて行き先が変わる', () => {
    const requeueOnce = transit(TICKET_TRANSITIONS, 'CALLED', 'HOLD_EXPIRE', (g) => g === 'requeueOnNoShow');
    const requeueBack = transit(TICKET_TRANSITIONS, 'CALLED', 'HOLD_EXPIRE', (g) => g === 'requeueToBackOnNoShow');
    const final = transit(TICKET_TRANSITIONS, 'CALLED', 'HOLD_EXPIRE', (g) => g === 'finalNoShow');

    expect(requeueOnce.kind === 'moved' && requeueOnce.to).toBe('PAUSED');
    expect(requeueBack.kind === 'moved' && requeueBack.to).toBe('WAITING');
    expect(final.kind === 'moved' && final.to).toBe('NO_SHOW');
  });
});

describe('受付からの絶対上限の適用範囲', () => {
  it('WAITING と PAUSED にだけ適用する', () => {
    expect([...MAX_AGE_APPLIES_TO].sort()).toEqual(['PAUSED', 'WAITING']);
  });

  it('宣言された適用範囲と、表の MAX_AGE の行が一致する', () => {
    const inTable = TICKET_TRANSITIONS.filter((row) => row.on === 'MAX_AGE').map((row) => row.from);
    expect([...inTable].sort()).toEqual([...MAX_AGE_APPLIES_TO].sort());
  });

  it('CALLED には適用しない（席を確保した人を上限で打ち切らない）', () => {
    expect(transit(TICKET_TRANSITIONS, 'CALLED', 'MAX_AGE', ALL_PASS).kind).toBe('undeclared');
  });

  it('SEATED には適用しない（着席時間の上限が別に働く）', () => {
    expect(transit(TICKET_TRANSITIONS, 'SEATED', 'MAX_AGE', ALL_PASS).kind).toBe('undeclared');
  });
});
