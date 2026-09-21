/**
 * API に現れる基本の値。
 *
 * **ここが「外から来るもの」の唯一の関門である。** 境界はこれを通ったものしか
 * `core` に渡さない（CLAUDE.md 3.1 の「入力の検証」）。
 *
 * 状態や種別の列挙は、**`core` の宣言をそのまま `z.enum` に流し込む**。
 * 同じ並びを手で書き写すと、片方に足したときにもう片方が置いていかれる
 * （CLAUDE.md 4 章の DRY）。
 */

import {
  CANCEL_REASONS,
  END_REASONS,
  TABLE_SCAN_KINDS,
  TABLE_STATUSES,
  TICKET_STATES,
} from '@openseat/core';
import { z } from 'zod';

// ---- 識別子 ----

/**
 * URL に出る施設の短い名前（`/v/{venue}`）。
 *
 * 小文字・数字・ハイフンだけにする。**大文字を許すと、印刷した QR と手入力の
 * URL が食い違う**（多くの環境でホスト名は小文字に正規化されるが、パスはされない）。
 */
export const VenueSlug = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/, '小文字・数字・ハイフンだけが使えます');

/**
 * チケットの識別子。形は生成側（サーバ）が決めるので、長さだけを縛る。
 *
 * **席の内部 ID は、契約に出てこない。** 外から席を指すのは**座席 QR のトークン**か
 * **印刷された席番号**だけである。内部 ID を外に出すと、QR を読まずに他人の席を
 * 指せてしまう。
 */
export const TicketId = z.string().min(1).max(64);

/**
 * チケット URL の秘密パラメータ（`?k=`。9.8）。
 *
 * **これはログに出さない。** エラーの文脈情報にも入れない（CLAUDE.md 7 章）。
 * 推測不能なランダム値で、本人性の確認に使う。
 */
export const TicketSecret = z.string().min(16).max(128);

/**
 * 座席 QR のトークン。
 *
 * **連番や席番号から導かない**（CLAUDE.md 7 章）。URL に置ける文字だけにする。
 */
export const TableToken = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/);

/** 利用者に見せる短い表示コード（`A-23`）。ボードに出し、口頭でも読み上げる。 */
export const TicketCode = z.string().regex(/^[A-Z]-\d{2}$/);

/** 印刷される席番号。施設が決めるので、中身は縛らない。 */
export const TableLabel = z.string().min(1).max(16);

// ---- 時刻 ----

/**
 * 時刻。**エポックからのミリ秒（UTC）**（CLAUDE.md 6 章）。
 *
 * **クライアントの時計を信じない**（9.4）。サーバが入れた絶対時刻を、画面は
 * 表示に使うだけである。
 */
export const Timestamp = z.int();

/** 分。運用パラメータの単位に合わせる（7.16）。 */
export const Minutes = z.int().min(0);

// ---- 人数とタグ ----

/**
 * 受け付ける人数の、**契約としての**上限。
 *
 * 施設ごとの本当の上限は運用パラメータ（`maxPartySize`。7.16）で決まり、
 * 判断するのは `core` である。ここで縛るのは「およそありえない値」までで、
 * **ここを施設の設定に合わせない**（合わせると設定の変更で契約が変わる）。
 */
export const ABSOLUTE_MAX_PARTY_SIZE = 99;

export const PartySize = z.int().min(1).max(ABSOLUTE_MAX_PARTY_SIZE);

/** 車いす対応席など。候補を絞るだけで、順番は早めない（7.6）。 */
export const Tag = z.string().min(1).max(32);

/**
 * タグの並び。
 *
 * **`.readonly()` は付けない。** TypeScript では読み取り専用になるが、
 * **OpenAPI の `readOnly` は「応答にだけ出る欄」を意味する**（要求には書けない）。
 * 希望のタグは受付で送るものなので、それでは契約が嘘になる。`core` 側の
 * `readonly` 配列との行き来は、境界で写す（`[...tags]`）。
 */
export const Tags = z.array(Tag).max(8);

// ---- `core` から流し込む列挙 ----

export const TicketState = z.enum(TICKET_STATES);
export const TableStatus = z.enum(TABLE_STATUSES);
export const EndReason = z.enum(END_REASONS);
export const CancelReason = z.enum(CANCEL_REASONS);
export const TableScanKind = z.enum(TABLE_SCAN_KINDS);

// ---- 再送への備え ----

/**
 * 冪等キー（9.4）。
 *
 * **モバイル回線の再送で二重に適用しない**ための鍵である。同じ鍵で二度届いた
 * コマンドは、一度しか適用されない。仕組みそのものは PR 4 で入る。
 */
export const IdempotencyKey = z.string().min(8).max(64);

/**
 * 端末の匿名トークン（9.8）。
 *
 * **氏名も電話番号も取らない。** これは端末を見分けるためだけの値で、
 * **保存するときはハッシュ化する**（CLAUDE.md 7 章）。
 */
export const ClientToken = z.string().min(16).max(128);
