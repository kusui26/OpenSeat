import { describe, expect, it } from 'vitest';
import { err, isErr, isOk, ok, type Result } from './result.js';

describe('Result', () => {
  it('成功は値を持つ', () => {
    const result: Result<number, string> = ok(3);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(3);
  });

  it('失敗は理由を持つ', () => {
    const result: Result<number, string> = err('だめ');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('だめ');
  });

  it('isOk と isErr は互いに反対', () => {
    expect(isOk(ok(1))).toBe(true);
    expect(isErr(ok(1))).toBe(false);
    expect(isOk(err('x'))).toBe(false);
    expect(isErr(err('x'))).toBe(true);
  });

  it('isOk で絞り込むと値が読める', () => {
    const result: Result<string, number> = ok('あり');
    expect(isOk(result) ? result.value : '無し').toBe('あり');
  });

  it('isErr で絞り込むと理由が読める', () => {
    const result: Result<string, number> = err(404);
    expect(isErr(result) ? result.error : 0).toBe(404);
  });

  it('null や 0 を成功として運べる（値の有無で成否を判定しない）', () => {
    const zero: Result<number, string> = ok(0);
    const nothing: Result<null, string> = ok(null);
    expect(isOk(zero)).toBe(true);
    expect(isOk(nothing)).toBe(true);
  });
});
