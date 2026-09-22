/**
 * 配信で届いたものを、画面の手元に差し替える（9.5、[ADR-0018](../../../docs/adr/0018-server-sent-events.md)）。
 *
 * **届くのは `GET` で取るのと同じ形である。** だから画面は、取りに行ったのか
 * 届いたのかを気にしなくてよい —— 手元の答えを置き換えるだけで済む。
 *
 * ## 古い姿で新しい姿を上書きしないこと
 *
 * 退避（ポーリング）と配信は重なる。**先に投げた古い応答が、あとから届く**
 * ことがあるので、`serverNow` が古いものは捨てる。
 *
 * **決まりは 1 か所に置く**（`LIVE_QUERY`）。配信だけを守っても足りない ——
 * 取りに行った答えは `useQuery` が直に書き込むので、そちらも同じ関門を通す
 * 必要がある。画面は `useQuery` に `...LIVE_QUERY` を混ぜる。
 *
 * ## つながっているあいだは、取りに行かない
 *
 * 二重に取っても新しいことは何も分からない。返すのは「いまつながっているか」
 * だけで、**取りに行く間隔を決めるのは画面の側**である。
 */

import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { Checks } from './api.ts';
import { connect, type OpenSocket } from './live.ts';

/** 配信で運ばれる形。**どれもサーバ時刻を持っている。** */
interface Timed {
  readonly serverNow: number;
}

export interface UseLiveParams<T extends Timed> {
  /** つなぐ先。**`null` ならつながない**（見る資格が無い、など）。 */
  readonly url: string | null;
  /** 受け取る名前（`ticket` / `venue`）。 */
  readonly event: string;
  /** 契約（`packages/shared`）。**描く前に形を確かめる。** */
  readonly checks: Checks<T>;
  /** どの答えを置き換えるか。 */
  readonly queryKey: readonly unknown[];
  /** 接続の作り方。**テストでは偽物を渡す。** */
  readonly open?: OpenSocket;
}

/**
 * 配信を受ける答えに混ぜる決まり。
 *
 * **取りに行った答えと、届いた姿が競る。** どちらも同じ形で、どちらが先に
 * 手元へ着くかは回線次第である。ここを通して、古いほうを捨てる。
 */
export const LIVE_QUERY = { structuralSharing: keepNewest } as const;

/**
 * 新しいほうを残す。**同じ時刻なら、あとから来たほうを採る。**
 *
 * 時刻を持たないものは、比べようがないので新しいほうを採る。
 */
export function keepNewest(held: unknown, fresh: unknown): unknown {
  if (!timed(held) || !timed(fresh)) return fresh;
  return fresh.serverNow >= held.serverNow ? fresh : held;
}

function timed(value: unknown): value is Timed {
  if (typeof value !== 'object' || value === null) return false;
  return 'serverNow' in value && typeof value.serverNow === 'number';
}

/** いまつながっているか。 */
export function useLive<T extends Timed>(params: UseLiveParams<T>): boolean {
  const cache = useQueryClient();
  const [live, setLive] = useState(false);
  const { url, event, checks, queryKey, open } = params;
  const key: string = JSON.stringify(queryKey);

  useEffect(() => {
    if (url === null) return;
    return connect({
      url,
      event,
      // `exactOptionalPropertyTypes` のため、無いときは欄ごと置かない。
      ...(open === undefined ? {} : { open }),
      onLive: setLive,
      onMessage: (data) => {
        const fresh: T | null = read(checks, data);
        // 古いものを捨てるのは `LIVE_QUERY` の仕事。**ここでは書くだけ。**
        if (fresh !== null) cache.setQueryData<T>(queryKey, fresh);
      },
    });
    // 並びそのものではなく**中身**で見る（`queryKey` は毎回作り直されるので、
    // そのまま並べると、描くたびにつなぎ直すことになる）。
  }, [url, event, key, open, cache, checks, queryKey]);

  return url !== null && live;
}

/**
 * 届いたものを確かめる。
 *
 * **形が違えば捨てる。** 描いてから気づくより、描かないほうがよい
 * （`api.ts` が `GET` の返しにしているのと同じ）。
 */
function read<T>(checks: Checks<T>, data: string): T | null {
  try {
    const parsed = checks.safeParse(JSON.parse(data));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
