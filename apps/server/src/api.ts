/**
 * 利用者の API を、実際の記録に繋ぐ。
 *
 * **ここは境界である。** ルート層が知っているのは [`Deps`](../routes/deps.ts) だけで、
 * それを DB と施設アクターから作るのがこのファイルの仕事である（CLAUDE.md 3.1）。
 */

import type { Timestamp, VenueState } from '@openseat/core';
import type { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import type { Db } from '../db/client.js';
import {
  profileOf,
  secretHashOf,
  tableByToken,
  venueOfTicket,
  type VenueProfile,
} from '../db/repository.js';
import { api } from '../routes/index.js';
import type { Sink } from '../routes/log.js';
import type { Deps, TicketHandle, VenueHandle } from '../routes/deps.js';
import type { Hub } from '../stream/hub.js';
import { mayJoin } from '../venue/rate-limit.js';
import type { Registry } from '../venue/registry.js';

export interface ApiParams {
  readonly db: Db;
  readonly registry: Registry;
  readonly clock: () => Timestamp;
  /** 配信（9.5）。**変化を配るのは `main.ts` が繋ぐ。** */
  readonly hub: Hub;
}

/** 利用者の API（9.7）。 */
export function userApi(params: ApiParams, sink?: Sink): Hono {
  return api(depsOf(params), sink);
}

export function depsOf(params: ApiParams): Deps {
  return {
    clock: params.clock,
    newId: () => randomUUID(),
    defaultLocale: 'ja',
    watch: (venueId, watcher) => params.hub.watch(venueId, watcher),
    findVenue: (slug) => bySlug(params, slug),
    findTicket: (ticketId) => byTicket(params, ticketId),
    findTable: (venueId, token) => tableByToken(params.db, venueId, token),
    mayJoin: (state: VenueState, clientTokenHash: string) =>
      mayJoin({
        db: params.db,
        venueId: state.venueId,
        clientTokenHash,
        limitPerHour: state.policy.joinRateLimitPerHour,
        now: params.clock(),
      }),
  };
}

function bySlug(params: ApiParams, slug: string): VenueHandle | null {
  const actor = params.registry.find(slug);
  if (actor === null) return null;
  const profile: VenueProfile | null = profileOf(params.db, actor.venueId);
  if (profile === null) return null;
  return {
    actor,
    slug: profile.slug,
    name: profile.name,
    timezone: profile.timezone,
    locale: profile.locale,
  };
}

function byTicket(params: ApiParams, ticketId: string): TicketHandle | null {
  const venueId: string | null = venueOfTicket(params.db, ticketId);
  if (venueId === null) return null;
  const profile: VenueProfile | null = profileOf(params.db, venueId);
  if (profile === null) return null;
  const venue: VenueHandle | null = bySlug(params, profile.slug);
  if (venue === null) return null;
  return { ...venue, secretHash: secretHashOf(params.db, venueId, ticketId) };
}
