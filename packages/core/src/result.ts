/**
 * 成功か失敗かを型で表す。
 *
 * `apply` は「定員を超えている」「受付時間外」といった **正当な拒否** を返す。
 * これを例外で表すと、呼び出し側が捕捉を忘れても型検査は通ってしまう。戻り値に
 * すれば、拒否を読まずに状態を取り出すことができない（Phase 1 プラン 7.3）。
 *
 * 不変条件の違反（`InvariantError`）だけは例外のままにしてある。あちらは
 * 「起きてはならないこと」で、正当な拒否とは種類が違う。
 *
 * ここに置くのは最小限の 4 つだけにする。`map` や `andThen` を並べ始めると、
 * 拒否を握り潰す書き方が短く書けるようになってしまう。
 */

/** 成功なら値を、失敗なら理由を持つ。 */
export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

/** 成功を作る。 */
export function ok<T, E>(value: T): Result<T, E> {
  return { ok: true, value };
}

/** 失敗を作る。 */
export function err<T, E>(error: E): Result<T, E> {
  return { ok: false, error };
}

/** 成功か。`result.ok` を直接読んでも型は絞り込まれるが、意図が読みやすくなる。 */
export function isOk<T, E>(result: Result<T, E>): result is { readonly ok: true; readonly value: T } {
  return result.ok;
}

/** 失敗か。 */
export function isErr<T, E>(result: Result<T, E>): result is { readonly ok: false; readonly error: E } {
  return !result.ok;
}
