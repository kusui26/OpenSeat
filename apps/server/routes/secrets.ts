/**
 * 秘密の扱い（9.8、CLAUDE.md 7 章）。
 *
 * **生の値をサーバに残さない。** 端末の匿名トークンも、チケット URL の秘密
 * パラメータも、**ハッシュだけ**を保存する。ここが、その 1 か所である。
 *
 * ## なぜ遅いハッシュ（argon2）でないのか
 *
 * **どちらも推測不能な乱数（128 ビット以上）だからである。** パスワードが遅い
 * ハッシュを要るのは、人が選ぶ値の空間が狭く、総当たりが成り立つためである。
 * 乱数にはそれが成り立たない。**速いハッシュで足りる。**
 *
 * 逆に、突き合わせは**定数時間**で行う。長さの違いや先頭の一致で時間が変わると、
 * 1 文字ずつ当てられる。
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** 端末の匿名トークン。**画面が作れないときのために、サーバも作れる。** */
export function newToken(): string {
  return randomBytes(16).toString('base64url');
}

/** 保存する形。**生の値はここから先へ行かない。** */
export function hashOf(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('base64url');
}

/**
 * 届いた値が、保存されているハッシュと合うか。
 *
 * **定数時間で比べる。** 早く違いが分かる比較だと、応答の速さから 1 文字ずつ
 * 当てられる。
 */
export function matches(secret: string | null, stored: string | null): boolean {
  if (secret === null || stored === null) return false;
  const given = Buffer.from(hashOf(secret));
  const known = Buffer.from(stored);
  return given.length === known.length && timingSafeEqual(given, known);
}
