/**
 * 言語ごとの束の形。
 *
 * **鍵はすべて揃っていなければならない。** `Record` にしてあるので、文言を
 * 1 つ足したら、**すべての言語で型エラーになる**。訳し忘れが編集中に出る。
 */

import type { ApiErrorCode } from '../api/errors.js';
import type { MessageKey } from './messages.js';

/** 対応する言語。**Phase 2 は日本語だけ。** 英語は Phase 3（11.5）。 */
export const LOCALES = ['ja'] as const;

export type Locale = (typeof LOCALES)[number];

export interface Bundle {
  readonly locale: Locale;
  /** 穴の空いた文言。埋めるのは `translate`。 */
  readonly messages: Readonly<Record<MessageKey, string>>;
  /** 断りの文言。**`core` の拒否コードと境界のコードを漏れなく覆う。** */
  readonly errors: Readonly<Record<ApiErrorCode, string>>;
}
