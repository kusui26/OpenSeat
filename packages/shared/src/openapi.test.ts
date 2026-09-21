/**
 * OpenAPI の文書。
 *
 * **書き出した `docs/openapi.json` が古くなっていないこと**を、ここで見る。
 * マイグレーションと同じで、**生成物はコミットするが、正は生成元のほう**である。
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ROUTES } from './api/catalog.js';
import { openApiDocument } from './openapi.js';

const document = openApiDocument();
const COMMITTED = new URL('../../../docs/openapi.json', import.meta.url);

/** 文書の `paths`。中身は生成物なので、読むときに形を確かめる。 */
function pathsOf(doc: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const paths: unknown = doc['paths'];
  return typeof paths === 'object' && paths !== null ? { ...paths } : {};
}

/** 文書の中の入口を、`METHOD パス` の形で並べる。 */
function operationsIn(doc: Readonly<Record<string, unknown>>): readonly string[] {
  return Object.entries(pathsOf(doc))
    .flatMap(([path, methods]) =>
      typeof methods === 'object' && methods !== null
        ? Object.keys(methods).map((method) => `${method.toUpperCase()} ${path}`)
        : [],
    )
    .toSorted();
}

/** 文書の中の操作（メソッド 1 つぶん）を、ぜんぶ並べる。 */
function operationsOf(doc: Readonly<Record<string, unknown>>): readonly Readonly<Record<string, unknown>>[] {
  return Object.values(pathsOf(doc)).flatMap((methods: unknown) =>
    typeof methods === 'object' && methods !== null
      ? Object.values<unknown>({ ...methods }).flatMap((operation) =>
          typeof operation === 'object' && operation !== null ? [{ ...operation }] : [],
        )
      : [],
  );
}

describe('OpenAPI の文書', () => {
  it('一覧にある入口が、1 本残らず載っている', () => {
    const declared = ROUTES.map((route) => `${route.method} ${route.path}`).toSorted();
    expect(operationsIn(document)).toEqual(declared);
  });

  it('何度組み立てても、同じものが出る', () => {
    expect(openApiDocument()).toEqual(document);
  });

  /**
   * **同じ形を何度も展開しない。** `Problem` だけで入口 × ステータスの数だけ
   * 現れるので、展開すると文書が数千行ふくらみ、人が開いても読めなくなる。
   */
  it('共通の形は 1 度だけ書いて、あとは参照する', () => {
    const components: unknown = document['components'];
    const schemas: unknown =
      typeof components === 'object' && components !== null && 'schemas' in components
        ? components.schemas
        : null;
    const names =
      typeof schemas === 'object' && schemas !== null ? Object.keys({ ...schemas }) : [];
    expect(names).toContain('Problem');

    const serialized = JSON.stringify(document);
    // 拾った形は、どれも実際に参照されている（置いただけのものが無い）。
    const unused = names.filter((name) => !serialized.includes(`"#/components/schemas/${name}"`));
    expect(unused).toEqual([]);
    // Zod 側の置き場（`#/$defs/`）が残っていない。**残ると参照が切れる。**
    expect(serialized).not.toContain('#/$defs/');
  });

  it('3.1 として名乗り、方言を 1 度だけ宣言する', () => {
    expect(document['openapi']).toBe('3.1.0');
    expect(document['jsonSchemaDialect']).toBe('https://json-schema.org/draft/2020-12/schema');
    // 断片ごとに `$schema` を繰り返さない（読むときに中身が埋もれる）。
    expect(JSON.stringify(document)).not.toContain('"$schema"');
  });

  it('どの入口にも、断りの返しがある', () => {
    const withoutErrors = operationsOf(document)
      .map((operation) => ({ id: operation['operationId'], responses: operation['responses'] }))
      .filter(({ responses }) => {
        if (typeof responses !== 'object' || responses === null) return true;
        return !Object.keys(responses).some((status) => status.startsWith('4') || status === '500');
      });
    expect(withoutErrors).toEqual([]);
  });

  /**
   * **書き出した文書が古いと、外部連携が壊れる。**
   *
   * 落ちたら `pnpm openapi` を走らせて、差分をコミットすること。
   */
  it('コミットされている docs/openapi.json が最新である', () => {
    const committed: unknown = JSON.parse(readFileSync(COMMITTED, 'utf8'));
    expect(committed).toEqual(document);
  });
});
