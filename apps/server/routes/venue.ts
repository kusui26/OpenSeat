/**
 * 施設を見るための入口（9.7 の 6）。
 *
 * **登録せずに見られる。** 受付 QR の下の「見るだけ」導線がここへ来る（10.1）。
 */

import { VenueStatusQuery } from '@openseat/shared';
import { Hono } from 'hono';
import type { Deps, VenueHandle } from './deps.js';
import { paramOf } from './request.js';
import { problem } from './respond.js';
import { venueStatus } from './views.js';

/** 目安を出す人数。**4 名までで、ふつうの組はここに収まる**（8.1 の人数分布）。 */
export const SIZES: readonly number[] = [1, 2, 3, 4];

export function venueRoutes(deps: Deps): Hono {
  const app = new Hono();

  app.get('/api/v/:venue/status', (c) => {
    const venue: VenueHandle | null = deps.findVenue(paramOf(c, 'venue'));
    if (venue === null) return problem(c, 'NOT_FOUND', deps.defaultLocale);

    const wanted = VenueStatusQuery.safeParse({ partySize: sizeOf(c.req.query('partySize')) });
    if (!wanted.success) return problem(c, 'INVALID_REQUEST', venue.locale);

    return c.json(venueStatus(venue, venue.actor.state(), sizesOf(wanted.data.partySize), deps.clock()));
  });

  return app;
}

/** 数として読めなければ、添えなかったものとして扱う。 */
export function sizeOf(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  return Number.isInteger(parsed) ? parsed : Number.NaN;
}

/** 人数を指していれば、その 1 つだけ。指していなければ、ふつうの組ぶん。 */
export function sizesOf(partySize: number | undefined): readonly number[] {
  return partySize === undefined ? SIZES : [partySize];
}

