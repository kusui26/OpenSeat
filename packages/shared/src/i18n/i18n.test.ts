/**
 * 文言。
 *
 * **穴が埋まらないまま利用者に出る**のがいちばん困るので、そこを機械に見てもらう。
 * あわせて 6.5 の原則（「予約」と言わない）も検査する。
 */

import { REJECTION_CODES, TABLE_SCAN_KINDS } from '@openseat/core';
import { describe, expect, it } from 'vitest';
import { API_ERROR_CODES } from '../api/errors.js';
import { BUNDLES, bundleFor } from './index.js';
import { MESSAGES, PLAN_NOTIFICATIONS, SCAN_MESSAGE_KEYS, type MessageKey } from './messages.js';
import { ja } from './ja.js';
import { placeholdersIn, translate, translateError } from './translate.js';

const bundles = Object.values(BUNDLES);
const keys: readonly MessageKey[] = Object.keys(MESSAGES).filter(isMessageKey);

function isMessageKey(value: string): value is MessageKey {
  return Object.hasOwn(MESSAGES, value);
}

describe('穴と引数', () => {
  it.each(bundles)('$locale: 文言の穴と、宣言した引数が 1 対 1', (bundle) => {
    const mismatched = keys
      .map((key) => ({
        key,
        inText: [...new Set(placeholdersIn(bundle.messages[key]))].toSorted(),
        declared: [...MESSAGES[key]].toSorted(),
      }))
      .filter((row) => row.inText.join(',') !== row.declared.join(','));

    expect(mismatched).toEqual([]);
  });

  it('引数を渡せば、穴が埋まる', () => {
    expect(
      translate(ja, 'notify.called', { table: 'T-12', capacity: 4, holdMin: 7 }),
    ).toBe('お席が決まりました。T-12（4 名席）へどうぞ。7 分以内に席の QR を読み取ってください。');
  });

  it('穴の無い文言は、そのまま返る', () => {
    expect(translate(ja, 'notify.conflict', {})).toContain('最優先で次の席をご案内します');
  });

  /**
   * **埋まらない穴を黙って残さない。** 画面に `{code}` がそのまま出るより、
   * 開発中に落ちるほうがよい。
   */
  it('渡し忘れたら落ちる', () => {
    expect(() =>
      translate(ja, 'notify.joined', { code: 'A-01', ahead: 1, etaFrom: 5, etaTo: 10 }),
    ).not.toThrow();
    expect(() =>
      // @ts-expect-error 足りないことは型でも落ちる。実行時にも落ちることを、ここで見る。
      translate(ja, 'notify.joined', { code: 'A-01' }),
    ).toThrow(/notify.joined/);
  });
});

describe('網羅', () => {
  it.each(bundles)('$locale: 宣言したすべての文言に、文字列がある', (bundle) => {
    expect(keys.filter((key) => (bundle.messages[key] ?? '').trim().length === 0)).toEqual([]);
  });

  /**
   * **`core` の拒否コードに、1 つ残らず文言がある。**
   *
   * 型でも保証しているが（`Record<ApiErrorCode, string>`）、実行時にも見る。
   * 抜けると「断られたのに理由が空」になる。
   */
  it.each(bundles)('$locale: すべての理由に文言がある', (bundle) => {
    const empty = API_ERROR_CODES.filter((code) => translateError(bundle, code).trim().length === 0);
    expect(empty).toEqual([]);
  });

  it('拒否コードは core の宣言をすべて含む', () => {
    const covered = new Set<string>(API_ERROR_CODES);
    expect(REJECTION_CODES.filter((code) => !covered.has(code))).toEqual([]);
  });

  /**
   * **座席 QR の分岐 15 通りに、1 つ残らず文言がある。**
   * 1 つでも無いと、その組み合わせで画面が黙る（7.8 は 63 通りある）。
   */
  it('座席 QR の分岐に、すべて文言がある', () => {
    expect(Object.keys(SCAN_MESSAGE_KEYS).toSorted()).toEqual([...TABLE_SCAN_KINDS].toSorted());
  });

  it('17.3 の通知文言 9 行が、すべて鍵を持っている', () => {
    expect(Object.keys(PLAN_NOTIFICATIONS)).toHaveLength(9);
    const unknown = Object.values(PLAN_NOTIFICATIONS).filter((key) => !keys.includes(key));
    expect(unknown).toEqual([]);
  });
});

describe('6.5 の文言の原則', () => {
  /**
   * **「予約」と言わない**（6.5、7.1）。空席を保証できないためである。
   * 「順番待ち」「ご案内」を使う。
   */
  it.each(bundles)('$locale: 「予約」が 1 か所も出てこない', (bundle) => {
    const texts = [...Object.values(bundle.messages), ...Object.values(bundle.errors)];
    expect(texts.filter((text) => text.includes('予約'))).toEqual([]);
  });

  /** 時間上限は「目安」と書く（6.5、7.10）。強制の印象を与えない。 */
  it('着席時間の知らせに「目安」が入っている', () => {
    expect(ja.messages['notify.timeLimitSoon']).toContain('目安');
  });
});

describe('言語の選び方', () => {
  it('知っている言語はその束が返る', () => {
    expect(bundleFor('ja')).toBe(ja);
  });

  it('知らない言語は日本語に倒す', () => {
    expect(bundleFor('fr')).toBe(ja);
  });
});
