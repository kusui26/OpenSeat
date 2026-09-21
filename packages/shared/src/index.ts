/**
 * OpenSeat の API 契約・文言・設定の形。
 *
 * **ここが「外と話すときの形」の唯一の出典である**（CLAUDE.md 3.2(5)）。型は
 * すべて `z.infer` で導き、同じ形を手で書かない。
 *
 * `packages/core` に依存するが、**逆は無い**。ドメインは外の形を知らない。
 */

export * from './values.js';
export * from './policy.js';
export * from './api/errors.js';
export * from './api/views.js';
export * from './api/tickets.js';
export * from './api/tables.js';
export * from './api/venue.js';
export * from './api/staff.js';
export * from './api/admin.js';
export * from './api/catalog.js';
export * from './openapi.js';
export * from './i18n/index.js';
