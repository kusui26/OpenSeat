/**
 * 管理者の契約（9.7 の管理 9、10.1 の管理者画面）。
 *
 * **管理者の操作も監査ログに残る**（CLAUDE.md 7 章、PR 12）。
 */

import { z } from 'zod';
import { SettingsWire } from '../policy.js';
import { PartySize, TableLabel, Tags, Timestamp, VenueSlug } from '../values.js';
import { ServerTime } from './views.js';

export const AdminVenuePath = z.object({ venue: VenueSlug });

// ---- 運用設定（`GET` / `PUT /api/admin/v/{venue}/settings`） ----

/**
 * いまの設定と、いつ誰が公開したか。
 *
 * **実証実験の期間中は、当日の設定値を記録して勝手に変更しない**（CLAUDE.md 8）。
 * `publishedAt` と `version` があるので、当日どの設定で動いていたかが後から分かる。
 */
export const SettingsResponse = ServerTime.extend({
  settings: SettingsWire,
  /** 公開するたびに 1 つ増える。A/B の記録（12.3）に使う。 */
  version: z.int().min(1),
  publishedAt: Timestamp,
  /** プリセットから作ったなら、その名前（10.3）。手で組んだなら `null`。 */
  preset: z.string().nullable(),
});

export type SettingsResponse = z.infer<typeof SettingsResponse>;

/**
 * 設定を公開する。
 *
 * **全部を送る。** 一部だけを送る形にすると、送らなかったキーが既定に戻るのか
 * 据え置かれるのかが、呼ぶ側から見て決まらない。
 */
export const SettingsUpdateRequest = z.object({
  settings: SettingsWire,
  preset: z.string().nullable().default(null),
});

export type SettingsUpdateRequest = z.infer<typeof SettingsUpdateRequest>;

// ---- 席の一覧（`GET` / `PUT /api/admin/v/{venue}/tables`） ----

/**
 * 席 1 つの設定。
 *
 * **座席 QR のトークンは返さない。** 印刷（PR 13）はサーバの中で QR を描くので、
 * トークンを画面まで運ぶ必要がない。運ばなければ、画面のログにも履歴にも残らない
 * （CLAUDE.md 7 章）。
 */
export const TableSetting = z.object({
  label: TableLabel,
  capacity: PartySize,
  tags: Tags.default([]),
  /** 小さいほど先に埋める。「入口に近い席から」のような運用を表す（7.6）。 */
  adminRank: z.int().default(0),
  /** OpenSeat の管理対象か。false なら常に自由席（7.14）。 */
  enabled: z.boolean().default(true),
});

export type TableSetting = z.infer<typeof TableSetting>;

export const TablesResponse = ServerTime.extend({
  tables: z.array(
    TableSetting.extend({
      /** いまその席が使われているか。**使われている席は消せない。** */
      inUse: z.boolean(),
      /** 対象外にする操作が保留されているか（7.6 のエッジケース）。 */
      disableAfterCurrent: z.boolean(),
    }),
  ),
});

export type TablesResponse = z.infer<typeof TablesResponse>;

/**
 * 席の一覧を差し替える。
 *
 * **運用中の変更を拒まない**（7.6 のエッジケース）。使われている席を対象外にする
 * 操作は、その利用が終わるまで保留される。**現場は止まらない。**
 */
export const TablesUpdateRequest = z.object({ tables: z.array(TableSetting).min(1) });

export type TablesUpdateRequest = z.infer<typeof TablesUpdateRequest>;
