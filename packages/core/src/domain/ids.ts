/**
 * 識別子。
 *
 * いずれも `string` の別名で、名前的な型（ブランド型）にはしていない。
 * ブランド型を作るには型アサーションが避けられず、`as` は禁止されているため
 * （CLAUDE.md 4 章）。取り違えは型では防げないので、引数名と関数の粒度で防ぐ。
 *
 * **ID は `core` では生成しない。** 生成には乱数が必要で、`core` は乱数を持てない
 * （ADR-0004）。ID はコマンドに含めて外から渡す。例外は表示コード（`TicketCode`）で、
 * これは状態から決定的に導けるため `core` が採番する（`state.ts` の `nextTicketCode`）。
 */

/** 施設の識別子。 */
export type VenueId = string;

/** テーブルの識別子。URL に現れる座席トークンとは別物で、こちらは内部用。 */
export type TableId = string;

/** チケットの識別子。 */
export type TicketId = string;

/**
 * 利用者に見せる短い表示コード。`A-23` の形。
 * 呼び出しボードに出し、口頭でも読み上げられることを想定する。
 */
export type TicketCode = string;

/** 印刷される席番号。`T-12` など、施設が決める。 */
export type TableLabel = string;

/**
 * 席の属性と、利用者の希望を表すタグ。
 * 車いす対応・子ども椅子・電源・窓側など。割当では候補の絞り込みにのみ使い、
 * 優先度は変えない（全体プラン 7.6）。
 */
export type Tag = string;
