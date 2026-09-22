/**
 * 文言。
 *
 * **画面に文字列を直書きしない**（CLAUDE.md 4 章）。鍵を持って、ここに聞く。
 * 中身は `packages/shared` にあり、英語は Phase 3 で足す（11.5）。
 */

import {
  ACTION_MESSAGE_KEYS,
  bundleFor,
  STATE_MESSAGE_KEYS,
  translate,
  translateError,
  type ApiErrorCode,
  type Bundle,
  type MessageKey,
  type ParamsOf,
} from '@openseat/shared';
import type { CommandType, TicketState } from '@openseat/core';

/**
 * いまの言語。
 *
 * **施設の設定で決まる**（9.6）。読み込む前は日本語に倒しておく ——
 * 文言が出ないより、読めない言語でも出るほうが現場では役に立つ。
 */
let bundle: Bundle = bundleFor('ja');

export function useLocale(locale: string): void {
  bundle = bundleFor(locale);
}

export function t<K extends MessageKey>(key: K, params: ParamsOf<K>): string {
  return translate(bundle, key, params);
}

/** 断りの文言。**サーバも同じものを返す**ので、どちらを出しても揃う。 */
export function tError(code: ApiErrorCode): string {
  return translateError(bundle, code);
}

/** チケットの状態の一言（7.3）。 */
export function tState(state: TicketState): string {
  return translate(bundle, STATE_MESSAGE_KEYS[state], {});
}

/** 押せる操作の名前。**サーバが返した操作をそのまま引く。** */
export function tAction(command: CommandType): string {
  return translate(bundle, ACTION_MESSAGE_KEYS[command], {});
}
