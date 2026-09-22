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

import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
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
  /**
   * 接続の作り方。**テストでは偽物を渡す。**
   *
   * **描くたびに作り直さないこと。** ここが変わると繋ぎ直す（そういう約束に
   * してある）。本番は渡さないので、この約束は画面に影響しない。
   */
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
  const { url, event, open } = params;

  /**
   * **描くたびに作り直されるものを、繋ぎ直しの理由にしない。**
   *
   * `queryKey` は配列、`checks` はスキーマで、どちらも呼ぶ側がその場で組み立てる。
   * これを下の並びに入れると、**描き直すたびに繋ぎ直す** —— 届いた 1 通が描き
   * 直しを起こし、それがまた繋ぎ直しを起こす、という輪になる。実際、1 つの筋書きで
   * **127 本**の接続が張られていた（PR 8 の通しで見つけた）。
   */
  const latest = useRef(params);
  latest.current = params;

  /** 並べるのは**変わったら繋ぎ直すべきもの**だけ。`queryKey` は中身で見る。 */
  const key: string = JSON.stringify(params.queryKey);

  useEffect(() => {
    if (url === null) return;
    const onMessage = (data: string): void => {
      keep(cache, latest.current, data);
    };
    // `exactOptionalPropertyTypes` のため、無いときは欄ごと置かない。
    const how = open === undefined ? {} : { open };
    return connect({ url, event, onLive: setLive, onMessage, ...how });
  }, [url, event, key, open, cache]);

  return url !== null && live;
}

/** 届いた 1 通を、手元に置く。**古いものを捨てるのは `LIVE_QUERY` の仕事。** */
function keep<T extends Timed>(
  cache: QueryClient,
  params: UseLiveParams<T>,
  data: string,
): void {
  const fresh: T | null = read(params.checks, data);
  if (fresh !== null) cache.setQueryData<T>(params.queryKey, fresh);
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
