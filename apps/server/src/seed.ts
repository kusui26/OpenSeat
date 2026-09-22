/**
 * 起動時に、施設がまだ無ければ作る。
 *
 * **足場である。** 席の一覧編集は PR 13 で入る。それまでは、起動しても席が
 * 1 つも無い状態になり、通し確認（`infra/smoke.sh`）が何も見られない。
 *
 * **すでにある施設には触らない。** 起動のたびに席を作り直すと、実証実験の最中に
 * 再デプロイしただけで座席 QR が全部無効になる（CLAUDE.md 8）。
 */

import {
  createTable,
  createVenueState,
  DEFAULT_POLICY,
  dispatch,
  member,
  minutes,
  type Timestamp,
  type VenueState,
} from '@openseat/core';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Db } from '../db/client.js';
import { commit, createVenue, insertTable, loadVenueState } from '../db/repository.js';
import type { Config } from './config.js';

/**
 * 座席 QR のトークン。**推測不能なランダム値**（CLAUDE.md 7）。
 * 連番や席番号から導かない。128 ビットを URL に置ける形で。
 */
function tableToken(): string {
  return randomBytes(16).toString('base64url');
}

/** 席の定員の並び。実証実験の対象は 20〜40 席で、2 人掛けが多い想定（12.2）。 */
const CAPACITIES: readonly number[] = [2, 2, 4, 4, 6];

function seatLabel(index: number): string {
  return `T-${String(index + 1).padStart(2, '0')}`;
}

function capacityAt(index: number): number {
  return CAPACITIES[index % CAPACITIES.length] ?? 2;
}

/** その施設がまだ無ければ作る。あれば何もしない。 */
export function ensureVenue(db: Db, config: Config, now: Timestamp): boolean {
  if (loadVenueState(db, config.venueId) !== null) return false;

  const state = createVenueState({ venueId: config.venueId, policy: DEFAULT_POLICY });
  createVenue(db, { state, slug: config.venueId, name: config.venueName, now });

  Array.from({ length: config.seedTables }, (_unused, index) =>
    createTable({ id: randomUUID(), label: seatLabel(index), capacity: capacityAt(index), now }),
  ).forEach((table) => {
    insertTable(db, table, { venueId: config.venueId, zoneId: null, token: tableToken() });
  });

  if (config.seedOpen) openVenue(db, config, now);
  return true;
}

/** 作ったばかりの施設を、運用中にする（足場。7.14）。 */
function openVenue(db: Db, config: Config, now: Timestamp): void {
  const before: VenueState | null = loadVenueState(db, config.venueId);
  if (before === null) return;

  const opened = dispatch(
    before,
    member('staff', 'seed'),
    { type: 'OPEN', closesAt: now + minutes(SEED_OPEN_MIN), by: 'staff' },
    now,
  );
  if (!opened.ok) throw new Error(`施設を開けません: ${opened.error.code}`);

  commit(db, {
    before,
    after: opened.value.state,
    events: opened.value.events,
    actor: member('staff', 'seed'),
    at: now,
    record: null,
    identity: null,
  });
}

/** 足場で開けたときの営業時間。**手で閉じるまで、というのは足場らしくない。** */
const SEED_OPEN_MIN = 12 * 60;
