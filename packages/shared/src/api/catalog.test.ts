/**
 * 開発プラン 9.7 と、実際の入口の突き合わせ。
 *
 * **「概略に書いてあるのに、作り忘れた」と「勝手に足した」の両方を落とす。**
 * 一覧（`catalog.ts`）は宣言で、ここはその照合にすぎない。
 */

import { COMMAND_TYPES } from '@openseat/core';
import { describe, expect, it } from 'vitest';
import { LATER_ROUTES, PLAN_ROWS, ROUTES, unreachableCommands } from './catalog.js';
import { STAFF_TABLE_ACTIONS, STAFF_TICKET_ACTIONS, OPERATION_ACTIONS } from './staff.js';
import { TABLE_REPORTS } from './tables.js';
import { TICKET_ACTIONS, TicketActionRequest } from './tickets.js';

/** パスに書かれた `{...}` の名前。 */
function placeholdersOf(path: string): readonly string[] {
  return [...path.matchAll(/\{([a-zA-Z]+)\}/g)].map((found) => found[1] ?? '');
}

/** 判別可能なユニオンが並べている `action` の名前。 */
function actionsInUnion(): readonly string[] {
  return TicketActionRequest.options.map((option) => option.shape.action.value);
}

describe('9.7 の表と、実際の入口', () => {
  it('9.7 のどの行にも、入口か「あとで」がある', () => {
    const covered = new Set<string>([
      ...ROUTES.map((route) => route.from),
      ...LATER_ROUTES.map((later) => later.from).filter((from) => from !== null),
    ]);
    expect(Object.keys(PLAN_ROWS).filter((row) => !covered.has(row))).toEqual([]);
  });

  it('9.7 に無い入口には、足した理由がある', () => {
    const extras = ROUTES.filter((route) => route.added !== undefined);
    expect(extras.filter((route) => (route.added ?? '').trim().length < 10)).toEqual([]);
    // 足したものが 1 つも無いなら、この検査は空回りしている。
    expect(extras.length).toBeGreaterThan(0);
  });

  it('「あとで」には、どの PR で入るかが書いてある', () => {
    expect(LATER_ROUTES.filter((later) => later.when.trim().length < 5)).toEqual([]);
  });

  it('入口の名前とパスが重なっていない', () => {
    const ids = ROUTES.map((route) => route.id);
    const endpoints = ROUTES.map((route) => `${route.method} ${route.path}`);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(endpoints).size).toBe(endpoints.length);
  });

  it('パスの穴と、パスパラメータの宣言が 1 対 1', () => {
    const mismatched = ROUTES.map((route) => ({
      id: route.id,
      inPath: placeholdersOf(route.path).toSorted(),
      declared: Object.keys(route.params?.shape ?? {}).toSorted(),
    })).filter((row) => row.inPath.join(',') !== row.declared.join(','));
    expect(mismatched).toEqual([]);
  });
});

describe('core のコマンドと、入口', () => {
  /**
   * **どのコマンドにも、それを出せる入口がある。**
   *
   * 1 つでも出せないコマンドがあると、`core` に書いた遷移が現場で使えない。
   * 座席 QR の分岐（7.8）が「席を変えられます」と出しても送り先が無い、という
   * 形で表に出る。
   */
  it('出せないコマンドが 1 つも無い', () => {
    expect(unreachableCommands()).toEqual([]);
  });

  it('入口が挙げるコマンドは、すべて実在する', () => {
    const known = new Set<string>(COMMAND_TYPES);
    const unknown = ROUTES.flatMap((route) => route.commands).filter(
      (command) => !known.has(command),
    );
    expect(unknown).toEqual([]);
  });
});

describe('操作の名前と、コマンドの対応表', () => {
  it('本人の操作は、表とユニオンが一致する', () => {
    expect(actionsInUnion().toSorted()).toEqual(Object.keys(TICKET_ACTIONS).toSorted());
  });

  it('本人が出せる操作は 13 種（9.7 の 10 種に、席の変更・前倒し・心拍を足したもの）', () => {
    expect(Object.keys(TICKET_ACTIONS)).toHaveLength(13);
  });

  it('スタッフと管理の操作も、すべて実在するコマンドを指す', () => {
    const known = new Set<string>(COMMAND_TYPES);
    const declared = [
      ...Object.values(STAFF_TICKET_ACTIONS),
      ...Object.values(STAFF_TABLE_ACTIONS),
      ...Object.values(OPERATION_ACTIONS),
      ...Object.values(TABLE_REPORTS),
    ];
    expect(declared.filter((command) => !known.has(command))).toEqual([]);
  });
});
