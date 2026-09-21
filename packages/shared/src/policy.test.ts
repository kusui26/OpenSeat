/**
 * 運用パラメータの契約。
 *
 * **値を二重に持っていないこと**と、**線の上を通っても値が変わらないこと**を見る。
 */

import { DEFAULT_POLICY } from '@openseat/core';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  DEFAULT_SETTINGS_WIRE,
  SettingsWire,
  fromMinutes,
  toMinutes,
  toPolicy,
  toWire,
} from './policy.js';

describe('運用パラメータ（7.16）', () => {
  it('既定値は core のものそのままで、写しを作っていない', () => {
    expect(DEFAULT_SETTINGS).toBe(DEFAULT_POLICY);
  });

  it('7.16 の 29 キーがすべてある', () => {
    expect(Object.keys(SettingsWire.shape)).toHaveLength(29);
  });

  it('契約のキーと core の Policy のキーが、1 つ残らず一致する', () => {
    expect(Object.keys(SettingsWire.shape).toSorted()).toEqual(Object.keys(DEFAULT_POLICY).toSorted());
  });

  it('既定値は、そのまま契約を通る', () => {
    expect(SettingsWire.safeParse(DEFAULT_SETTINGS_WIRE).success).toBe(true);
  });

  it('往復しても、値が 1 つも変わらない', () => {
    expect(toPolicy(toWire(DEFAULT_POLICY))).toEqual(DEFAULT_POLICY);
  });
});

describe('JSON が表せない「上限なし」', () => {
  /**
   * **`JSON.stringify(Infinity)` は `null` を返す。**
   *
   * `fairnessOverrideMin: Infinity` は「純粋な best fit」の指定である（7.16）。
   * そのまま送ると黙って別の設定になり、**設定を保存し直したときだけ割当の方針が
   * 変わる**という、いちばん気づきにくい壊れ方をする。
   */
  it('素の JSON では無限大が消える（だから文字列に逃がしている）', () => {
    expect(JSON.parse(JSON.stringify({ v: Number.POSITIVE_INFINITY }))).toEqual({ v: null });
  });

  it('上限なしの設定が、往復しても上限なしのまま', () => {
    const unbounded = { ...DEFAULT_POLICY, fairnessOverrideMin: Number.POSITIVE_INFINITY };
    const wire = toWire(unbounded);

    expect(wire.fairnessOverrideMin).toBe('Infinity');
    expect(SettingsWire.safeParse(JSON.parse(JSON.stringify(wire))).success).toBe(true);
    expect(toPolicy(wire).fairnessOverrideMin).toBe(Number.POSITIVE_INFINITY);
  });

  it('ふつうの数はそのまま通る', () => {
    expect(fromMinutes(10)).toBe(10);
    expect(toMinutes(10)).toBe(10);
  });

  it('負の分数や、数でないものは断る', () => {
    expect(SettingsWire.safeParse({ ...DEFAULT_SETTINGS_WIRE, holdMin: -1 }).success).toBe(false);
    expect(SettingsWire.safeParse({ ...DEFAULT_SETTINGS_WIRE, holdMin: '7' }).success).toBe(false);
  });

  it('知らないキーは、黙って通さない', () => {
    const extra = { ...DEFAULT_SETTINGS_WIRE, unknownKey: 1 };
    const parsed = SettingsWire.safeParse(extra);
    expect(parsed.success && 'unknownKey' in parsed.data).toBe(false);
  });
});
