import { describe, expect, it } from 'vitest';
import { TABLE_STATUSES, type TableStatus } from '../domain/table.js';
import { ambiguous, canReachAny, duplicates, outgoing, reachableFrom, statesIn } from './graph.js';
import {
  CLOSE_APPLIES_TO,
  TABLE_EVENTS,
  TABLE_GUARDS,
  TABLE_INITIAL_STATE,
  TABLE_TRANSITIONS,
  type TableEvent,
} from './table-machine.js';
import { matching, transit } from './transit.js';

const ALL_PASS = (): boolean => true;
const ALL_FAIL = (): boolean => false;

/**
 * 全体プラン 7.4 の状態遷移図に描かれている矢印。
 *
 * **これが仕様との照合点である。** 図の 1 本の矢印が複数の事象をまとめて
 * いることがあるため、起点と終点の組だけを写す。
 */
const DIAGRAM_ARROWS: readonly (readonly [TableStatus, TableStatus, string])[] = [
  ['DISABLED', 'FREE', '運用開始'],
  ['FREE', 'HELD', '割当（CALLED）'],
  ['FREE', 'OCCUPIED', '飛び込み着席／待ちの人の前倒し着席'],
  ['FREE', 'OCCUPIED_UNKNOWN', '第三者の「使用中」報告／スタッフ'],
  ['FREE', 'DISABLED', '運用終了／設定変更／全席解放'],
  ['HELD', 'OCCUPIED', '着席確認'],
  ['HELD', 'FREE', 'ノーショー／パス／キャンセル'],
  ['HELD', 'OCCUPIED_UNKNOWN', '「誰か座っている」報告'],
  ['HELD', 'DISABLED', '全席解放（緊急）'],
  ['OCCUPIED', 'TURNOVER', '退席'],
  ['OCCUPIED', 'NEEDS_CHECK', '上限超過＋猶予／「まだ利用中？」に無応答'],
  ['OCCUPIED', 'DISABLED', '全席解放（緊急）'],
  ['OCCUPIED_UNKNOWN', 'NEEDS_CHECK', '想定滞在時間の経過'],
  ['OCCUPIED_UNKNOWN', 'FREE', 'スタッフが「空席にする」'],
  ['OCCUPIED_UNKNOWN', 'DISABLED', '全席解放（緊急）'],
  ['TURNOVER', 'FREE', '片付け猶予経過'],
  ['TURNOVER', 'DISABLED', '対象外の予約／運用終了／全席解放'],
  ['NEEDS_CHECK', 'FREE', 'スタッフ確認／次の人の「空いていた」／放置の自動解放'],
  ['NEEDS_CHECK', 'TURNOVER', '本人の退席申告'],
  ['NEEDS_CHECK', 'OCCUPIED', '本人の「まだ利用中」／第三者の「使用中だった」／案内された人の着席'],
  ['NEEDS_CHECK', 'OCCUPIED_UNKNOWN', '次に案内された人の「使用中だった」（誰の記録も無い席）'],
  ['NEEDS_CHECK', 'DISABLED', '運用終了／全席解放'],
];

describe('遷移表と全体プラン 7.4 の図の対応', () => {
  it('図のすべての矢印が表に存在する（実装に漏れが無い）', () => {
    const inTable = new Set(TABLE_TRANSITIONS.map((row) => `${row.from}->${row.to}`));
    const missing = DIAGRAM_ARROWS.filter(([from, to]) => !inTable.has(`${from}->${to}`));
    expect(missing.map(([from, to, label]) => `${from}->${to}（${label}）`)).toEqual([]);
  });

  it('表のすべての矢印が図に存在する（実装に余分が無い）', () => {
    const inDiagram = new Set(DIAGRAM_ARROWS.map(([from, to]) => `${from}->${to}`));
    const extra = TABLE_TRANSITIONS.filter((row) => !inDiagram.has(`${row.from}->${row.to}`));
    expect(extra.map((row) => `${row.from}->${row.to}（${row.on}）`)).toEqual([]);
  });

  it('表は 31 本の遷移を宣言している', () => {
    expect(TABLE_TRANSITIONS).toHaveLength(31);
  });
});

describe('宣言の健全性', () => {
  it.each(TABLE_TRANSITIONS)('$from --$on--> $to が正しい形をしている', (row) => {
    expect(TABLE_STATUSES).toContain(row.from);
    expect(TABLE_STATUSES).toContain(row.to);
    expect(TABLE_EVENTS).toContain(row.on);
    if (row.guard !== null) expect(TABLE_GUARDS).toContain(row.guard);
    expect(row.source).toMatch(/^7\.\d+$/);
    expect(row.note.length).toBeGreaterThan(0);
  });

  it('同じ内容の行が二重に宣言されていない', () => {
    expect(duplicates(TABLE_TRANSITIONS)).toEqual([]);
  });

  it('同じ（状態、事象）に複数の行があるとき、無条件の行が混ざっていない', () => {
    expect(ambiguous(TABLE_TRANSITIONS).map((row) => `${row.from}/${row.on}`)).toEqual([]);
  });

  it('宣言されたガードはすべて、いずれかの行から参照されている', () => {
    const used = new Set(TABLE_TRANSITIONS.map((row) => row.guard));
    expect(TABLE_GUARDS.filter((guard) => !used.has(guard))).toEqual([]);
  });

  it('宣言された事象はすべて、いずれかの行から参照されている', () => {
    const used = new Set<TableEvent>(TABLE_TRANSITIONS.map((row) => row.on));
    expect(TABLE_EVENTS.filter((event) => !used.has(event))).toEqual([]);
  });

  it('片付け猶予の経過は 2 通りに分岐し、どちらもガードつきで宣言されている', () => {
    const rows = matching(TABLE_TRANSITIONS, 'TURNOVER', 'TURNOVER_DONE');
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.to).sort()).toEqual(['DISABLED', 'FREE']);
    expect(rows.every((row) => row.guard !== null)).toBe(true);
  });
});

describe('グラフとしての性質', () => {
  it('テーブルは管理対象外の状態から始まる', () => {
    expect(TABLE_INITIAL_STATE).toBe('DISABLED');
  });

  it('すべての状態が初期状態から到達できる', () => {
    const reachable = reachableFrom(TABLE_TRANSITIONS, [TABLE_INITIAL_STATE]);
    expect(TABLE_STATUSES.filter((status) => !reachable.has(status))).toEqual([]);
  });

  it.each(TABLE_STATUSES)('%s から空席（FREE）へ戻れる（席が永久に塞がらない）', (status) => {
    // 7.11 の「最悪でも席が永久に塞がらない」という主張の、グラフとしての裏づけ。
    // ふるまいとして本当に戻るかは PR 10 の性質テストで確かめる。
    expect(canReachAny(TABLE_TRANSITIONS, status, ['FREE'])).toBe(true);
  });

  it.each(TABLE_STATUSES)('%s から管理対象外（DISABLED）へ戻れる（運用を止められる）', (status) => {
    expect(canReachAny(TABLE_TRANSITIONS, status, ['DISABLED'])).toBe(true);
  });

  it('どの状態にも行き止まりが無い（出口が 1 本以上ある）', () => {
    const deadEnds = TABLE_STATUSES.filter(
      (status) => outgoing(TABLE_TRANSITIONS, status).length === 0,
    );
    expect(deadEnds).toEqual([]);
  });

  it('表に現れる状態は、宣言された 7 状態の範囲に収まる', () => {
    for (const status of statesIn(TABLE_TRANSITIONS)) {
      expect(TABLE_STATUSES).toContain(status);
    }
  });

  it('確認要（NEEDS_CHECK）からは空席にも使用中にも戻れる', () => {
    const destinations = outgoing(TABLE_TRANSITIONS, 'NEEDS_CHECK').map((row) => row.to);
    expect(destinations).toContain('FREE');
    expect(destinations).toContain('OCCUPIED');
    expect(destinations).toContain('OCCUPIED_UNKNOWN');
  });
});

describe('transit（表に従って遷移する）', () => {
  it.each(TABLE_TRANSITIONS)('$from で $on が起きると $to へ進む', (row) => {
    const evaluate = (guard: string): boolean => guard === row.guard;
    const outcome = transit(TABLE_TRANSITIONS, row.from, row.on, evaluate);
    expect(outcome.kind).toBe('moved');
    if (outcome.kind === 'moved') expect(outcome.to).toBe(row.to);
  });

  it('表に無い組み合わせは undeclared として拒否される', () => {
    const declared = new Set(TABLE_TRANSITIONS.map((row) => `${row.from}/${row.on}`));
    const wrong: string[] = [];
    for (const status of TABLE_STATUSES) {
      for (const event of TABLE_EVENTS) {
        if (declared.has(`${status}/${event}`)) continue;
        if (transit(TABLE_TRANSITIONS, status, event, ALL_PASS).kind !== 'undeclared') {
          wrong.push(`${status}/${event}`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  it('片付け猶予の経過は、対象外の予約があるかで行き先が変わる', () => {
    const managed = transit(TABLE_TRANSITIONS, 'TURNOVER', 'TURNOVER_DONE', (g) => g === 'stillManaged');
    const disabling = transit(TABLE_TRANSITIONS, 'TURNOVER', 'TURNOVER_DONE', (g) => g === 'disableAfterCurrent');
    expect(managed.kind === 'moved' && managed.to).toBe('FREE');
    expect(disabling.kind === 'moved' && disabling.to).toBe('DISABLED');
  });

  it('自動解放が無効なら、確認要のまま留まる', () => {
    const outcome = transit(TABLE_TRANSITIONS, 'NEEDS_CHECK', 'AUTO_FREE', ALL_FAIL);
    expect(outcome.kind).toBe('blocked');
    if (outcome.kind === 'blocked') expect(outcome.tried).toEqual(['autoFreeEnabled']);
  });
});

describe('運用終了と全席解放の違い（7.14、7.9）', () => {
  it('運用終了で即座に外れるのは、利用していない 3 つの状態だけ', () => {
    expect([...CLOSE_APPLIES_TO].sort()).toEqual(['FREE', 'NEEDS_CHECK', 'TURNOVER']);
  });

  it('宣言された適用範囲と、表の CLOSE の行が一致する', () => {
    const inTable = TABLE_TRANSITIONS.filter((row) => row.on === 'CLOSE').map((row) => row.from);
    expect([...inTable].sort()).toEqual([...CLOSE_APPLIES_TO].sort());
  });

  it.each(['HELD', 'OCCUPIED', 'OCCUPIED_UNKNOWN'] as const)(
    '利用中の %s は運用終了では外れない（現在の利用が終わってから外す）',
    (status) => {
      expect(transit(TABLE_TRANSITIONS, status, 'CLOSE', ALL_PASS).kind).toBe('undeclared');
    },
  );

  it.each(TABLE_STATUSES.filter((status) => status !== 'DISABLED'))(
    '全席解放は %s からでも管理対象外にできる（緊急時にすべて外す）',
    (status) => {
      const outcome = transit(TABLE_TRANSITIONS, status, 'VENUE_RELEASE', ALL_PASS);
      expect(outcome.kind).toBe('moved');
      if (outcome.kind === 'moved') expect(outcome.to).toBe('DISABLED');
    },
  );
});
