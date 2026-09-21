/**
 * 記録（SQLite）。
 *
 * **これは本番のスキーマではない。** スキーマ・イベントログの形式・スナップショット
 * の設計は Phase 2 で決める（Phase 1 プラン 11 章）。ここで確かめたいのは 3 つだけ。
 *
 * 1. `node:sqlite` が依存を足さずに使えるか（9.13 の主張）
 * 2. コンテナのボリュームに置いたファイルが、再デプロイをまたいで残るか
 * 3. 落ちても状態を取り戻せるか
 *
 * ## なぜイベントではなく「入力」を記録するのか
 *
 * **`core` に入れたもの（コマンドと `tick` の時刻）をそのまま順に並べておき、
 * 起動時にもう一度流す。** `apply` と `tick` は純粋関数なので、同じ入力からは
 * 必ず同じ状態が出る（ADR-0004）。これで再起動の取り戻しを、新しい形式を 1 つも
 * 決めずに確かめられる。
 *
 * 本番はイベントログ＋スナップショットになる（9.2）。**その形式を決めるのは
 * Phase 2 で、スパイクで先取りしない。**
 */

import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { Command, Timestamp } from '@openseat/core';
import { COMMAND_TYPES } from '@openseat/core';

/** `core` に入れたもの。これを順に流し直せば、同じ状態に戻る。 */
export type Input =
  | { readonly kind: 'command'; readonly at: Timestamp; readonly command: Command }
  | { readonly kind: 'tick'; readonly at: Timestamp };

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS inputs (
    seq     INTEGER PRIMARY KEY AUTOINCREMENT,
    kind    TEXT    NOT NULL,
    at      INTEGER NOT NULL,
    payload TEXT    NOT NULL
  );
`;

/**
 * 入力を順に書き足し、順に読み戻すだけの記録。
 *
 * **業務の判断をしない**（CLAUDE.md 3.1 の「永続化層」）。何を書くかは
 * 呼び出し側が決める。
 */
export class Store {
  private readonly db: DatabaseSync;
  private readonly insert: StatementSync;
  private readonly selectAll: StatementSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    // 落ちたときに書きかけが残らないようにする。SQLite の既定は落とし穴が多い。
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec(SCHEMA);
    this.insert = this.db.prepare('INSERT INTO inputs (kind, at, payload) VALUES (?, ?, ?)');
    this.selectAll = this.db.prepare('SELECT kind, at, payload FROM inputs ORDER BY seq');
  }

  append(input: Input): void {
    const payload: string = input.kind === 'command' ? JSON.stringify(input.command) : '{}';
    this.insert.run(input.kind, input.at, payload);
  }

  /** 書いた順に読み戻す。読めない行は落とす（自分が書いたものしか無い前提）。 */
  replay(): readonly Input[] {
    return this.selectAll.all().flatMap((row) => toInput(row));
  }

  get size(): number {
    return this.replay().length;
  }

  close(): void {
    this.db.close();
  }
}

// ---- 読み戻し ----

interface Row {
  readonly kind: unknown;
  readonly at: unknown;
  readonly payload: unknown;
}

function isRow(value: unknown): value is Row {
  return typeof value === 'object' && value !== null && 'kind' in value && 'at' in value;
}

/**
 * 1 行を入力に戻す。戻せなければ空を返す。
 *
 * **自分が書いたものを読み直すだけなので、種別しか確かめない。** 外から来た値を
 * 検証する仕組み（`packages/shared` の Zod）は Phase 2 で作る。
 */
function toInput(row: unknown): readonly Input[] {
  if (!isRow(row) || typeof row.at !== 'number') return [];
  if (row.kind === 'tick') return [{ kind: 'tick', at: row.at }];
  if (row.kind !== 'command' || typeof row.payload !== 'string') return [];
  const command: unknown = parse(row.payload);
  return isCommand(command) ? [{ kind: 'command', at: row.at, command }] : [];
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isCommand(value: unknown): value is Command {
  if (typeof value !== 'object' || value === null || !('type' in value)) return false;
  const kind: unknown = value.type;
  return typeof kind === 'string' && COMMAND_TYPES.some((known) => known === kind);
}
