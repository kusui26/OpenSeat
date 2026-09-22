/**
 * 施設の名前から、そのアクターを引く。
 *
 * **施設ごとに 1 つのアクター**（9.4）。URL の `{venue}` は短い名前（`slug`）なので、
 * 内部の識別子に直してから引く。
 *
 * **一度起こしたら、そのまま持ち続ける。** アクターは状態を手元に持っているので
 * （それが 1 件ずつ順に適用するということである）、呼び出しごとに作り直しては
 * ならない。
 */

import type { Db } from '../db/client.js';
import { findVenueBySlug } from '../db/repository.js';
import { openVenueActor, type VenueActor } from './actor.js';

export interface Registry {
  /** その名前の施設。無ければ `null`。 */
  readonly find: (slug: string) => VenueActor | null;
  /** いま起きているアクター。`tick` を配って回るのに使う。 */
  readonly all: () => readonly VenueActor[];
}

export interface OpenRegistryParams {
  readonly db: Db;
  readonly clock: () => number;
  /**
   * 施設を起こしたときに呼ばれる。
   *
   * **ここで繋がなければ、あとから開いた施設だけ配信されない。** アクターは
   * 引かれたときに初めて起きるので（下記）、起動時に並んでいるものへ繋いで
   * 回るやり方では取りこぼす。
   */
  readonly onOpen?: (actor: VenueActor) => void;
}

export function openRegistry(params: OpenRegistryParams): Registry {
  const byId = new Map<string, VenueActor>();

  const find = (slug: string): VenueActor | null => {
    const venueId: string | null = findVenueBySlug(params.db, slug);
    if (venueId === null) return null;

    const known: VenueActor | undefined = byId.get(venueId);
    if (known !== undefined) return known;

    const opened: VenueActor = openVenueActor({ db: params.db, venueId, clock: params.clock });
    byId.set(venueId, opened);
    params.onOpen?.(opened);
    return opened;
  };

  return { find, all: () => [...byId.values()] };
}
