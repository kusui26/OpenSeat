/**
 * 1 件ずつ、順に。
 *
 * **施設ごとに 1 つのアクターが、コマンドを 1 件ずつ順に適用する**（9.4）。
 * 並行に来たものは、前の 1 件が終わるまで待つ。
 *
 * ## なぜ要るのか
 *
 * いまの書き込みは最初から最後まで同期で終わる（`better-sqlite3` がそうである）。
 * Node は 1 本の糸で動くので、**そのままでも割り込みは起きない。**
 *
 * それでもここを置くのは、**その性質が「たまたま」だから**である。あとで
 * 通知（PR 16）や配信（PR 7）を適用の途中に足した人は、そこに `await` を 1 つ
 * 書くだけでよく、**そのとき初めて 2 組が同じ席に割り当たる**。起きてから気づく
 * 種類の壊れ方なので、先に塞いでおく。
 *
 * **1 件が失敗しても、列は止めない。** 誰かの操作が断られたからといって、次の人が
 * 並べなくなってはいけない。
 */

/** 順番に実行する。前の 1 件が終わるまで、次は始まらない。 */
export type Serialiser = <T>(work: () => T | Promise<T>) => Promise<T>;

export function serialiser(): Serialiser {
  let tail: Promise<unknown> = Promise.resolve();

  return <T>(work: () => T | Promise<T>): Promise<T> => {
    const next: Promise<T> = tail.then(work);
    // 失敗を握り潰しているように見えるが、**捨てているのは列の側の写しだけ**で、
    // 呼んだ人には `next` がそのまま返る。ここで捕まえないと、1 件の失敗で
    // 以後すべてが失敗する。
    tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
}
