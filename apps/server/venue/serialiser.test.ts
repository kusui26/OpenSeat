/**
 * 1 件ずつ、順に。
 *
 * **ここは仕掛けそのものを試す。** 施設アクターの中では書き込みが同期で終わるので、
 * 割り込みが起きる場面を作れない。だから**わざと待つ仕事**を流して、順番が保たれる
 * ことを確かめる。あとで適用の途中に `await` が入っても、この検査が守る。
 */

import { describe, expect, it } from 'vitest';
import { serialiser } from './serialiser.js';

/** 指定したミリ秒だけ待つ。**順番を崩す機会を作るためだけに使う。** */
function after<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

describe('順番', () => {
  it('先に積んだものが、先に終わる', async () => {
    const queue = serialiser();
    const done: number[] = [];

    await Promise.all([
      queue(async () => {
        await after(20, null);
        done.push(1);
      }),
      queue(async () => {
        await after(5, null);
        done.push(2);
      }),
      queue(() => {
        done.push(3);
      }),
    ]);

    expect(done).toEqual([1, 2, 3]);
  });

  /** **前の 1 件が終わるまで、次は始まらない。** 途中に割り込まれない。 */
  it('前の 1 件が終わるまで、次が始まらない', async () => {
    const queue = serialiser();
    const trace: string[] = [];

    const slow = queue(async () => {
      trace.push('1 が始まった');
      await after(20, null);
      trace.push('1 が終わった');
    });
    const fast = queue(() => {
      trace.push('2 が始まった');
    });

    await Promise.all([slow, fast]);
    expect(trace).toEqual(['1 が始まった', '1 が終わった', '2 が始まった']);
  });

  it('結果はそれぞれの呼び出しに返る', async () => {
    const queue = serialiser();
    const values = await Promise.all([queue(() => 'a'), queue(() => after(5, 'b')), queue(() => 'c')]);
    expect(values).toEqual(['a', 'b', 'c']);
  });
});

describe('失敗しても列は止まらない', () => {
  /**
   * **誰かの操作が断られたからといって、次の人が並べなくなってはいけない。**
   */
  it('1 件が投げても、後ろが流れる', async () => {
    const queue = serialiser();
    const failed = queue(() => {
      throw new Error('だめ');
    });

    await expect(failed).rejects.toThrow('だめ');
    await expect(queue(() => 'つぎ')).resolves.toBe('つぎ');
  });

  it('投げた失敗は、呼んだ人にそのまま返る', async () => {
    const queue = serialiser();
    const results = await Promise.allSettled([
      queue(() => Promise.reject(new Error('1 つめ'))),
      queue(() => ' 2 つめ'),
    ]);

    expect(results.map((result) => result.status)).toEqual(['rejected', 'fulfilled']);
  });
});
