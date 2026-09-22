/**
 * 文言。
 *
 * **利用者に見える文字列をコードに直書きしない**（CLAUDE.md 4 章）。画面も
 * サーバも、鍵を持ってここに聞く。
 *
 * **Phase 2 は日本語だけを書く**（11.5）。仕組みはここで揃うので、Phase 3 で
 * 英語を足すときは `en.ts` を 1 つ書くだけになる。
 */

export type { Bundle } from './bundle.js';
export { LOCALES, type Locale } from './bundle.js';
export {
  ACTION_MESSAGE_KEYS,
  MESSAGES,
  PLAN_NOTIFICATIONS,
  SCAN_MESSAGE_KEYS,
  STATE_MESSAGE_KEYS,
  type MessageKey,
  type ParamsOf,
} from './messages.js';
export { placeholdersIn, translate, translateError } from './translate.js';
export { ja } from './ja.js';

import { LOCALES, type Bundle, type Locale } from './bundle.js';
import { ja } from './ja.js';

/** 言語ごとの束。**施設の設定（`locale`）で選ぶ。** */
export const BUNDLES: Readonly<Record<Locale, Bundle>> = { ja };

/**
 * 施設のロケールに合う束を返す。
 *
 * **知らない言語は日本語に倒す。** 文言が出ないより、読めない言語でも出るほうが
 * 現場では役に立つ。
 */
export function bundleFor(locale: string): Bundle {
  const known: Locale | undefined = LOCALES.find((candidate) => candidate === locale);
  return known === undefined ? ja : BUNDLES[known];
}
