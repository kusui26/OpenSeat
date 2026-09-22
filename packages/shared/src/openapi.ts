/**
 * OpenAPI の文書を組み立てる（9.7）。
 *
 * **手で書かない。** [一覧](api/catalog.ts)から作るので、入口を足せば文書にも
 * 載る。載せ忘れが起こらない（CLAUDE.md 3.2(5)）。
 *
 * **ライブラリを足していない。** Zod 4 は JSON Schema への変換を自分で持っている
 * （`z.toJSONSchema`）ので、残りは器を組み立てるだけである。ベンダーを 1 つ
 * 増やすには、これでは足りないと分かってからでよい。
 *
 * 何のために要るか（9.7）。**外部連携と、将来のセンサー入力**である。施設の既存
 * システムや、v2 で足すかもしれない在席センサーが、この文書だけを見て話せること。
 */

import { z } from 'zod';
import { ROUTES, UNIVERSAL_ERRORS, type RouteSpec } from './api/catalog.js';
import { ERROR_STATUS, ProblemResponse, type ApiErrorCode } from './api/errors.js';

/** OpenAPI 3.1 は JSON Schema draft 2020-12 をそのまま使う。 */
const TARGET = 'draft-2020-12';

const DIALECT = 'https://json-schema.org/draft/2020-12/schema';

/** JSON Schema の断片。中身まで型で縛らない（そこは Zod が出したもの）。 */
type Schema = Readonly<Record<string, unknown>>;

/** Zod が共有スキーマを置く場所。 */
const ZOD_DEFS = '#/$defs/';

/** OpenAPI が共有スキーマを置く場所。 */
const OPENAPI_DEFS = '#/components/schemas/';

export interface OpenApiOptions {
  readonly title?: string;
  readonly version?: string;
  readonly description?: string;
}

// ---- Zod の出力を OpenAPI の形に移す ----

/**
 * `$ref` の行き先を書き換える。
 *
 * Zod は共有スキーマを `#/$defs/` に置くが、**OpenAPI は
 * `#/components/schemas/` に置く**。指し先を丸ごと差し替える。
 */
function rewriteRefs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(rewriteRefs);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries<unknown>({ ...value }).map(([key, nested]) =>
      key === '$ref' && typeof nested === 'string' && nested.startsWith(ZOD_DEFS)
        ? [key, `${OPENAPI_DEFS}${nested.slice(ZOD_DEFS.length)}`]
        : [key, rewriteRefs(nested)],
    ),
  );
}

function asSchema(value: unknown): Schema {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? { ...value } : {};
}

/**
 * スキーマを 1 つずつ変換しながら、**共有できる形を拾い集める**もの。
 *
 * `id` を付けたスキーマ（`.meta({ id })`）は、何度出てきても 1 度だけ書いて
 * 参照される。`Problem` は入口ごとにステータスの数だけ現れるので、展開すると
 * 文書が数千行ふくらみ、**人が開いても読めなくなる**。
 *
 * **文書 1 つにつき 1 つ作る。** 呼ぶ順に関係なく同じ文書が出るようにするためで、
 * 持ち回りの状態にすると「2 回目だけ違う」が起こる。
 */
interface Converter {
  /** スキーマを JSON Schema にする。要求と応答で姿が変わるので `io` を渡す。 */
  readonly of: (schema: z.ZodType, io: 'input' | 'output') => Schema;
  /** ここまでに拾った共有スキーマ。 */
  readonly components: () => Readonly<Record<string, Schema>>;
}

function converter(): Converter {
  const shared = new Map<string, Schema>();

  const of = (schema: z.ZodType, io: 'input' | 'output'): Schema => {
    // `$schema` は文書の頭で 1 度だけ宣言する（`jsonSchemaDialect`）。
    // 断片ごとに繰り返すと、読むときに中身が埋もれる。
    const { $schema, $defs, ...rest } = z.toJSONSchema(schema, {
      target: TARGET,
      io,
      unrepresentable: 'any',
    });
    for (const [id, definition] of Object.entries(asSchema($defs))) {
      shared.set(id, asSchema(rewriteRefs(definition)));
    }
    return asSchema(rewriteRefs(rest));
  };

  return { of, components: () => Object.fromEntries([...shared.entries()].toSorted(byKey)) };
}

function byKey(a: readonly [string, Schema], b: readonly [string, Schema]): number {
  return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
}

/**
 * 表のオブジェクトから、欄を取り出す。
 *
 * **`z.ZodObject` の `shape` は、型引数を書かないと中身が `any` になる。** 一覧
 * （`catalog.ts`）は形の違う表を並べて持つので型引数を書けない。ここで 1 度だけ
 * 確かめて、`any` を先へ通さない（CLAUDE.md 4 章）。
 */
function fieldsOf(container: z.ZodObject): readonly (readonly [string, z.ZodType])[] {
  return Object.entries<unknown>(container.shape).flatMap(([name, field]) =>
    field instanceof z.ZodType ? [[name, field] as const] : [],
  );
}

// ---- 入口 1 つぶん ----

/** パスの `{venue}` などを、OpenAPI のパラメータに開く。 */
function pathParameters(route: RouteSpec, convert: Converter): readonly Schema[] {
  if (route.params === null) return [];
  return fieldsOf(route.params).map(([name, field]) => ({
    name,
    in: 'path',
    required: true,
    schema: convert.of(field, 'input'),
  }));
}

/** 省いてよいものは `required: false` にする。 */
function optionalParameters(
  container: z.ZodObject | null,
  location: 'query' | 'header',
  convert: Converter,
): readonly Schema[] {
  if (container === null) return [];
  return fieldsOf(container).map(([name, field]) => ({
    name,
    in: location,
    required: !field.safeParse(undefined).success,
    schema: convert.of(field, 'input'),
  }));
}

function parameters(route: RouteSpec, convert: Converter): readonly Schema[] {
  return [
    ...pathParameters(route, convert),
    ...optionalParameters(route.query, 'query', convert),
    ...optionalParameters(route.headers, 'header', convert),
  ];
}

function requestBody(route: RouteSpec, convert: Converter): Schema | null {
  if (route.request === null) return null;
  return {
    required: true,
    content: { 'application/json': { schema: convert.of(route.request, 'input') } },
  };
}

/**
 * 断りの応答。
 *
 * **理由ごとではなく、ステータスごとにまとめる。** 同じ 409 に複数の理由が
 * 乗るので、呼ぶ側はステータスで分岐してから `code` を見る。
 */
function errorResponses(route: RouteSpec, convert: Converter): Readonly<Record<string, Schema>> {
  const codes: readonly ApiErrorCode[] = [...route.errors, ...UNIVERSAL_ERRORS];
  const problem: Schema = convert.of(ProblemResponse, 'output');
  const byStatus = new Map<number, ApiErrorCode[]>();
  for (const code of codes) {
    const status = ERROR_STATUS[code];
    byStatus.set(status, [...(byStatus.get(status) ?? []), code]);
  }
  return Object.fromEntries(
    [...byStatus.entries()]
      .toSorted(([a], [b]) => a - b)
      .map(([status, list]) => [
        String(status),
        {
          description: list.toSorted().join(' / '),
          content: { 'application/json': { schema: problem } },
        },
      ]),
  );
}

function responses(route: RouteSpec, convert: Converter): Readonly<Record<string, Schema>> {
  return {
    '200': {
      description: route.summary,
      content: { 'application/json': { schema: convert.of(route.response, 'output') } },
    },
    ...errorResponses(route, convert),
  };
}

function operation(route: RouteSpec, convert: Converter): Schema {
  const body = requestBody(route, convert);
  return {
    operationId: route.id,
    summary: route.summary,
    tags: [route.audience],
    parameters: parameters(route, convert),
    ...(body === null ? {} : { requestBody: body }),
    responses: responses(route, convert),
  };
}

/** 同じパスに複数のメソッドが並ぶので、まとめてから組み立てる。 */
function paths(convert: Converter): Readonly<Record<string, Schema>> {
  const grouped = new Map<string, Record<string, Schema>>();
  for (const route of ROUTES) {
    const existing = grouped.get(route.path) ?? {};
    grouped.set(route.path, {
      ...existing,
      [route.method.toLowerCase()]: operation(route, convert),
    });
  }
  return Object.fromEntries(grouped);
}

// ---- 文書 ----

const TAGS: readonly Schema[] = [
  { name: 'user', description: '利用者' },
  { name: 'board', description: '入口ボード' },
  { name: 'staff', description: 'スタッフ' },
  { name: 'admin', description: '管理者' },
];

const DESCRIPTION = 'フードコートの座席順番待ち。アプリ不要・アカウント不要で、入力は人数だけ。';

/**
 * 文書を組み立てる。
 *
 * **`servers` は入れない。** 施設ごとに置き場が違い（自前の VPS、Railway、
 * 施設のサブドメイン）、ここに書くと必ず古くなる。
 */
export function openApiDocument(options: OpenApiOptions = {}): Schema {
  const convert = converter();
  const built = paths(convert);
  return {
    openapi: '3.1.0',
    jsonSchemaDialect: DIALECT,
    info: {
      title: options.title ?? 'OpenSeat API',
      version: options.version ?? '0.0.0',
      description: options.description ?? DESCRIPTION,
      license: { name: 'Apache-2.0', identifier: 'Apache-2.0' },
    },
    tags: TAGS,
    paths: built,
    components: { schemas: convert.components() },
  };
}
