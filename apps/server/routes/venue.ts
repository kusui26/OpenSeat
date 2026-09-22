/**
 * 施設を見るための入口（9.7 の 6）。
 *
 * **登録せずに見られる。** 受付 QR の下の「見るだけ」導線がここへ来る（10.1）。
 */

import { managedTables, type VenueState } from '@openseat/core';
import { VenueStatusQuery, type VenueStatusResponse } from '@openseat/shared';
import { Hono } from 'hono';
import type { Deps, VenueHandle } from './deps.js';
import { paramOf } from './request.js';
import { problem } from './respond.js';
import { estimatesFor } from './views.js';

/** 目安を出す人数。**4 名までで、ふつうの組はここに収まる**（8.1 の人数分布）。 */
const SIZES: readonly number[] = [1, 2, 3, 4];

export function venueRoutes(deps: Deps): Hono {
  const app = new Hono();

  app.get('/api/v/:venue/status', (c) => {
    const venue: VenueHandle | null = deps.findVenue(paramOf(c, 'venue'));
    if (venue === null) return problem(c, 'NOT_FOUND', deps.defaultLocale);

    const wanted = VenueStatusQuery.safeParse({ partySize: sizeOf(c.req.query('partySize')) });
    if (!wanted.success) return problem(c, 'INVALID_REQUEST', venue.locale);

    const sizes: readonly number[] = wanted.data.partySize === undefined ? SIZES : [wanted.data.partySize];
    return c.json(statusOf(deps, venue, sizes));
  });

  return app;
}

/** 数として読めなければ、添えなかったものとして扱う。 */
function sizeOf(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  return Number.isInteger(parsed) ? parsed : Number.NaN;
}

/**
 * 施設のいまの様子。
 *
 * **席の内訳は数だけ。** どの席が空いているかを外に出すと、並ばずに直行する人が
 * 出て、案内された人の席が塞がる（7.11 の事故が増える）。
 */
function statusOf(deps: Deps, venue: VenueHandle, sizes: readonly number[]): VenueStatusResponse {
  const now = deps.clock();
  const state: VenueState = venue.actor.state();
  const managed = managedTables(state);
  return {
    serverNow: now,
    venue: profileOf(venue, state),
    waiting: state.tickets.filter((ticket) => QUEUED.includes(ticket.state)).length,
    freeTables: managed.filter((table) => table.status === 'FREE').length,
    managedTables: managed.length,
    estimates: [...estimatesFor(state, sizes, now)],
    longWaitConfirmMin: state.policy.longWaitConfirmMin,
  };
}

function profileOf(venue: VenueHandle, state: VenueState): VenueStatusResponse['venue'] {
  return {
    slug: venue.slug,
    name: venue.name,
    timezone: venue.timezone,
    operating: state.operating,
    joinOpen: state.joinOpen,
    closesAt: state.closesAt,
  };
}

/** 待っているとみなす状態。着席した人は行列から出ている。 */
const QUEUED: readonly string[] = ['WAITING', 'PAUSED', 'CALLED'];
