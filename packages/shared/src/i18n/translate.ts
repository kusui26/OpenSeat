/**
 * 穴を埋める。
 *
 * **仕組みはこれだけでよい。** 複数形も性も無い日本語と、規則が単純な英語しか
 * 対象にしていないので（11.5）、置き換えライブラリを入れる理由が無い。
 * 必要になったら差し替えられるよう、呼ぶ側はこの関数しか知らない形にしてある。
 */

import type { ApiErrorCode } from '../api/errors.js';
import type { Bundle } from './bundle.js';
import type { MessageKey, ParamsOf } from './messages.js';

const PLACEHOLDER = /\{([a-zA-Z][a-zA-Z0-9]*)\}/g;

/** 文言に空いている穴の名前。テストが引数の宣言と突き合わせる。 */
export function placeholdersIn(text: string): readonly string[] {
  return [...text.matchAll(PLACEHOLDER)].map((found) => found[1] ?? '');
}

/**
 * 文言を組み立てる。
 *
 * **埋まらない穴を黙って残さない。** 渡し忘れたら投げる。画面に `{code}` が
 * そのまま出るより、開発中に落ちるほうがよい。
 */
export function translate<K extends MessageKey>(
  bundle: Bundle,
  key: K,
  params: ParamsOf<K>,
): string {
  return fill(bundle.messages[key], params, key);
}

function fill(
  template: string,
  params: Readonly<Record<string, string | number>>,
  key: string,
): string {
  return template.replace(PLACEHOLDER, (whole: string, name: string) => {
    const value: string | number | undefined = params[name];
    if (value === undefined) throw new Error(`文言 ${key} の ${whole} に渡す値がありません`);
    return String(value);
  });
}

/** 断りの文言。**穴は無い。** */
export function translateError(bundle: Bundle, code: ApiErrorCode): string {
  return bundle.errors[code];
}
