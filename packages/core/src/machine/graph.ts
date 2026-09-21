/**
 * 遷移表をグラフとして調べる。
 *
 * 図を目で追うより確実に、抜け・到達不能・行き止まりを見つけるための道具。
 * 主にテストから使う（遷移表の到達可能性と行き止まりの検査、`reachability.test.ts`
 * の網羅性の検査）。
 */

import type { Transition } from './transit.js';

type AnyTable<S extends string, E extends string, G extends string> = readonly Transition<S, E, G>[];

/** ある状態から出ている遷移。 */
export function outgoing<S extends string, E extends string, G extends string>(
  table: AnyTable<S, E, G>,
  from: S,
): readonly Transition<S, E, G>[] {
  return table.filter((row) => row.from === from);
}

/** ある状態へ入ってくる遷移。 */
export function incoming<S extends string, E extends string, G extends string>(
  table: AnyTable<S, E, G>,
  to: S,
): readonly Transition<S, E, G>[] {
  return table.filter((row) => row.to === to);
}

/** 表に現れるすべての状態。 */
export function statesIn<S extends string, E extends string, G extends string>(
  table: AnyTable<S, E, G>,
): ReadonlySet<S> {
  return new Set(table.flatMap((row) => [row.from, row.to]));
}

/**
 * 初期状態から到達できる状態の集合。
 *
 * どの状態にも辿り着けないことが分かれば、宣言の抜けか、要らない状態がある。
 */
export function reachableFrom<S extends string, E extends string, G extends string>(
  table: AnyTable<S, E, G>,
  initial: readonly S[],
): ReadonlySet<S> {
  const seen = new Set<S>(initial);
  const queue: S[] = [...initial];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    for (const row of outgoing(table, current)) {
      if (!seen.has(row.to)) {
        seen.add(row.to);
        queue.push(row.to);
      }
    }
  }
  return seen;
}

/**
 * ある状態から、指定した状態のいずれかへ到達できるか。
 *
 * 「すべての非終端状態から終端へ到達できる」ことを確かめ、行き止まり
 * （チケットや席が永久に残る状態）が無いことを保証する。
 */
export function canReachAny<S extends string, E extends string, G extends string>(
  table: AnyTable<S, E, G>,
  from: S,
  targets: readonly S[],
): boolean {
  const goals = new Set<S>(targets);
  if (goals.has(from)) return true;
  const reachable = reachableFrom(table, [from]);
  return [...goals].some((goal) => reachable.has(goal));
}

/**
 * 同じ（状態、事象）の組に複数の行があり、そのうち無条件の行が混ざっているもの。
 *
 * 無条件の行は常に成立するため、後ろの行を覆い隠してしまう。宣言の誤りとして
 * 検出する。複数の行があるときは、すべてガードつきで、互いに排他であること。
 */
export function ambiguous<S extends string, E extends string, G extends string>(
  table: AnyTable<S, E, G>,
): readonly Transition<S, E, G>[] {
  return table.filter((row) => {
    const siblings = table.filter((other) => other.from === row.from && other.on === row.on);
    return siblings.length > 1 && row.guard === null;
  });
}

/** まったく同じ内容の行が二重に宣言されていないか。 */
export function duplicates<S extends string, E extends string, G extends string>(
  table: AnyTable<S, E, G>,
): readonly string[] {
  const seen = new Set<string>();
  const found = new Set<string>();
  for (const row of table) {
    const signature = `${row.from}/${row.on}/${row.to}/${row.guard ?? '-'}`;
    if (seen.has(signature)) found.add(signature);
    seen.add(signature);
  }
  return [...found];
}

/** 表が参照しているガードの名前の集合。 */
export function guardsUsedIn<S extends string, E extends string, G extends string>(
  table: AnyTable<S, E, G>,
): ReadonlySet<G> {
  const guards = new Set<G>();
  for (const row of table) {
    if (row.guard !== null) guards.add(row.guard);
  }
  return guards;
}

/** 表が扱っている事象の集合。 */
export function eventsUsedIn<S extends string, E extends string, G extends string>(
  table: AnyTable<S, E, G>,
): ReadonlySet<E> {
  return new Set(table.map((row) => row.on));
}
