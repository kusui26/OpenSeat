/**
 * テストが使う足場。
 *
 * **本物と同じ道を通す。** マイグレーションを適用し、`PRAGMA` を投げ、
 * 同じ `open()` で開く。テスト専用の近道を作ると、通ったことの意味が薄れる。
 */

import {
  ANONYMOUS,
  createTable,
  createVenueState,
  DEFAULT_POLICY,
  dispatch,
  member,
  targetTicketId,
  ticketOwner,
  tick,
  type Actor,
  type Command,
  type Decision,
  type DomainEvent,
  type Policy,
  type Rejection,
  type Result,
  type Table,
  type Timestamp,
  type VenueState,
} from '@openseat/core';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open, type Connection, type Db } from './client.js';
import { commit, createVenue, insertTable } from './repository.js';

export const VENUE_ID = 'v-test';

/** マイグレーションの置き場。テストはリポジトリのどこから走っても同じ場所を見る。 */
const MIGRATIONS = new URL('./migrations', import.meta.url).pathname;

export interface Harness {
  readonly db: Db;
  readonly path: string;
  /** 閉じて、作った一時ディレクトリごと消す。 */
  readonly dispose: () => void;
  /** 閉じずに開き直す。**再起動を再現する。** */
  readonly reopen: () => Db;
}

/**
 * ファイルの上に空のデータベースを用意する。
 *
 * **メモリ内（`:memory:`）は使わない。** 落として起こし直したときに状態が戻るか、
 * というのがこの PR の問いなので、閉じたら消える置き場では確かめられない。
 */
export function harness(): Harness {
  const directory = mkdtempSync(join(tmpdir(), 'openseat-'));
  const path = join(directory, 'test.db');
  let connection: Connection = open({ path, migrationsFolder: MIGRATIONS });

  return {
    get db() {
      return connection.db;
    },
    path,
    dispose: () => {
      connection.close();
      rmSync(directory, { recursive: true, force: true });
    },
    reopen: () => {
      connection.close();
      connection = open({ path, migrationsFolder: MIGRATIONS });
      return connection.db;
    },
  };
}

export interface SeedParams {
  readonly capacities: readonly number[];
  readonly now: Timestamp;
  readonly policy?: Policy;
}

/** 定員の並びから席を作る。`t-1`・`T-01` のように、読んで分かる ID を振る。 */
function seats(capacities: readonly number[], now: Timestamp): readonly Table[] {
  return capacities.map((capacity, index) =>
    createTable({
      id: `t-${String(index + 1)}`,
      label: `T-${String(index + 1).padStart(2, '0')}`,
      capacity,
      now,
    }),
  );
}

/** 施設と席を作り、その状態を返す。 */
export function seed(db: Db, params: SeedParams): VenueState {
  const tables: readonly Table[] = seats(params.capacities, params.now);
  const state = createVenueState({
    venueId: VENUE_ID,
    policy: params.policy ?? DEFAULT_POLICY,
    tables,
  });

  createVenue(db, { state, slug: 'test', name: 'テスト施設', now: params.now });
  tables.forEach((table, index) => {
    insertTable(db, table, { venueId: VENUE_ID, zoneId: null, token: `token-${String(index + 1)}` });
  });
  return state;
}

// ---- 誰が出しているか ----

/** テストの中の管理者。席の設定まで含めて出せる役割（9.8）。 */
const ADMIN: Actor = member('admin', 'fixture-admin');

/**
 * そのコマンドを出しそうな人。
 *
 * **ここは永続化のテストの足場である。** 誰が何を出せるかを確かめるのは
 * `core` の権限のテストで、こちらは「記録が歪まないこと」だけを見たい。
 * だから実行者は書かずに済むようにしてある。
 */
function actorFor(command: Command): Actor {
  const target: string | null = targetTicketId(command);
  if (target !== null) return ticketOwner(target);
  return 'by' in command && command.by === 'staff' ? ADMIN : ANONYMOUS;
}

// ---- 記録しながら進める ----

/**
 * `core` を呼び、その結果をそのまま記録する。
 *
 * **サーバが PR 3 でやることを、小さくしたものである。** 本物の施設アクターは
 * ここに順序の保証と配信を足すが、記録の仕方は変わらない。
 */
export interface Recorder {
  /** いま手元にある状態。 */
  readonly state: () => VenueState;
  /**
   * コマンドを適用して記録する。拒否されたらそのまま返し、記録もしない。
   *
   * 実行者を省くと、**そのコマンドを出しそうな人**が選ばれる（`actorFor`）。
   */
  readonly send: (
    command: Command,
    at: Timestamp,
    actor?: Actor,
  ) => Result<Decision<VenueState, DomainEvent>, Rejection>;
  /** 時刻を進めて記録する。 */
  readonly advance: (to: Timestamp) => void;
}

/** 決まったことを記録して、新しい状態を返す。 */
function record(
  db: Db,
  before: VenueState,
  decided: Decision<VenueState, DomainEvent>,
  actor: Actor | null,
  at: Timestamp,
): VenueState {
  commit(db, { before, after: decided.state, events: decided.events, actor, at, record: null });
  return decided.state;
}

export function recorder(db: Db, initial: VenueState): Recorder {
  let current: VenueState = initial;
  return {
    state: () => current,
    send: (command, at, actor = actorFor(command)) => {
      const result = dispatch(current, actor, command, at);
      if (result.ok) current = record(db, current, result.value, actor, at);
      return result;
    },
    advance: (to) => {
      const result = tick(current, to);
      if (!result.ok) throw new Error(`tick が拒否されました: ${result.error.code}`);
      current = record(db, current, result.value, null, to);
    },
  };
}
