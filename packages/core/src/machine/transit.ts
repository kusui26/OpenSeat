/**
 * 状態遷移の宣言と適用。
 *
 * 状態機械は **データの表** として宣言し、コードの分岐では書かない。
 * 表に無い遷移は起こせない（CLAUDE.md 3.2）。新しい状態や遷移を足すときは、
 * 表に追記する以外の方法を取らないこと。
 *
 * この層は状態・事象・ガードの具体名を知らない。チケットとテーブルの表は
 * `ticket-machine.ts` と `table-machine.ts` にある。
 */

/**
 * 1 本の遷移。
 *
 * `guard` は名前だけを持ち、判定の実装はここには無い。適用する側が評価関数を
 * 渡す。これにより、表は「何が起こりうるか」だけを語り、「いま起こるか」の
 * 判断は振る舞いの層に閉じる。
 */
export interface Transition<
  State extends string,
  Event extends string,
  Guard extends string,
> {
  readonly from: State;
  readonly on: Event;
  readonly to: State;
  /** 条件つきの遷移ならガードの名前。無条件なら null。 */
  readonly guard: Guard | null;
  /** 全体プランのどの節に由来するか。仕様との照合点になる。 */
  readonly source: string;
  /** 何が起きたときの遷移かを日本語で。 */
  readonly note: string;
}

/** 遷移を試みた結果。 */
export type TransitOutcome<State extends string, Guard extends string> =
  /** 表に宣言があり、ガードも通った。 */
  | { readonly kind: 'moved'; readonly to: State; readonly guard: Guard | null }
  /**
   * 表に宣言が無い。その状態でその事象は起こりえない。
   * 利用者の操作としては「その状態ではできません」にあたる。
   */
  | { readonly kind: 'undeclared' }
  /**
   * 宣言はあるが、どのガードも通らなかった。
   * 「延長の回数が上限に達している」のような、正当な拒否にあたる。
   */
  | { readonly kind: 'blocked'; readonly tried: readonly Guard[] };

/** ガードの名前を受け取り、いま成立しているかを返す。 */
export type GuardEvaluator<Guard extends string> = (guard: Guard) => boolean;

/** ある状態とある事象に対して宣言されている遷移をすべて返す。 */
export function matching<State extends string, Event extends string, Guard extends string>(
  table: readonly Transition<State, Event, Guard>[],
  from: State,
  on: Event,
): readonly Transition<State, Event, Guard>[] {
  return table.filter((row) => row.from === from && row.on === on);
}

/**
 * いま採られる行。どの行のガードも通らなければ `null`。
 *
 * 宣言の順に評価し、**最初にガードを通った行**を採る。無条件の行は常に通る。
 * 同じ組み合わせに複数の行があるときは、ガードが互いに排他になるように
 * 宣言すること（`ambiguous()` が検査する）。
 *
 * **選び方の規則はここ 1 か所にしかない。** `transit()` もこれを使う。
 * 「どの行が採られるか」を別々に書くと、検査と実行で答えが割れる。
 */
export function taken<State extends string, Event extends string, Guard extends string>(
  table: readonly Transition<State, Event, Guard>[],
  from: State,
  on: Event,
  evaluate: GuardEvaluator<Guard>,
): Transition<State, Event, Guard> | null {
  return matching(table, from, on).find((row) => row.guard === null || evaluate(row.guard)) ?? null;
}

/**
 * 遷移を試みる。
 *
 * 行き先が決まったか、宣言が無いか、宣言はあるがどのガードも通らなかったかを
 * 区別して返す。どの行が採られるかは `taken()` が決める。
 */
export function transit<State extends string, Event extends string, Guard extends string>(
  table: readonly Transition<State, Event, Guard>[],
  from: State,
  on: Event,
  evaluate: GuardEvaluator<Guard>,
): TransitOutcome<State, Guard> {
  const rows = matching(table, from, on);
  if (rows.length === 0) return { kind: 'undeclared' };

  const row = taken(table, from, on, evaluate);
  if (row !== null) return { kind: 'moved', to: row.to, guard: row.guard };
  return { kind: 'blocked', tried: rows.map((candidate) => candidate.guard).filter(isGuard) };
}

function isGuard<Guard extends string>(guard: Guard | null): guard is Guard {
  return guard !== null;
}
