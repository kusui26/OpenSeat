/**
 * コマンドの受け口。**権限を見てから適用する。**
 *
 * **これが状態を変える唯一の入口である。** `apply` はパッケージの外に公開して
 * いない（`index.ts`）。だから**権限を通らずに状態を変える道が、外からは無い**。
 * 「気をつける」ではなく、構造でそうしてある（CLAUDE.md 3 章）。
 *
 * ## 見る順
 *
 * 1. **その役割に、その操作が許されているか**（`PERMISSIONS` の表）
 * 2. **本人なら、自分のチケットを相手にしているか**
 * 3. **コマンドが名乗る側と、実行者の役割が合っているか**
 * 4. あとは `apply` —— 状態の条件（遷移表・ガード・ADR-0011）はそちらが見る
 *
 * **1〜3 は状態を読まない。** 誰が何を出せるかは施設の状況に左右されないし、
 * 状態を読まずに断れるほうが速い。**逆に、状態で決まることは 1〜3 に書かない。**
 * 「着席の記録が残っている席を空席に戻せるのはスタッフだけ」（ADR-0011）は
 * 席の状態の条件なので、`apply` の側に置いてある。
 */

import { isPermitted, ownsTarget } from '../domain/permissions.js';
import { sideOf, type Actor, type Side } from '../domain/actor.js';
import type { VenueState } from '../domain/state.js';
import type { Decision } from '../decision.js';
import { err, type Result } from '../result.js';
import type { Timestamp } from '../time.js';
import { apply } from './apply.js';
import type { Command } from './command.js';
import type { DomainEvent } from './events.js';
import { rejection, type Rejection } from './rejection.js';

/**
 * 権限を見てから、コマンドを適用する。
 *
 * **実行者が誰であるかは確かめない。** セッション（PR 12）と匿名トークン（PR 5）が
 * 確かめたものを信じる（`domain/actor.ts`）。ここで見るのは「その役割にその操作が
 * 許されているか」だけである。
 */
export function dispatch(
  state: VenueState,
  actor: Actor,
  command: Command,
  now: Timestamp,
): Result<Decision<VenueState, DomainEvent>, Rejection> {
  const refused: Rejection | null = refuse(actor, command);
  return refused === null ? apply(state, command, now) : err(refused);
}

/** 断る理由があれば返す。無ければ `null`。 */
function refuse(actor: Actor, command: Command): Rejection | null {
  if (!isPermitted(actor.role, command.type)) {
    return rejection('FORBIDDEN', `${actor.role} は ${command.type} を出せない`);
  }
  if (!ownsTarget(actor, command)) {
    return rejection('FORBIDDEN', `${command.type} の相手が、示されたチケットと違う`);
  }
  return checkSide(actor, command);
}

/**
 * コマンドが名乗る側と、実行者の役割が合っているか。
 *
 * **これが食い違うと、監査の記録が嘘になる。** スタッフが取り消したのに
 * `user_cancel` と残ったら、あとから「誰が消したのか」を追えない（7.9、
 * CLAUDE.md 7 章）。入力の誤りではなく**境界の組み立ての誤り**なので、
 * 欠陥として扱う（`isDefect`）。
 */
function checkSide(actor: Actor, command: Command): Rejection | null {
  const declared: Side | null = 'by' in command ? command.by : null;
  if (declared === null) return null;

  const actual: Side = sideOf(actor.role);
  if (declared === actual) return null;
  return rejection(
    'ACTOR_MISMATCH',
    `${command.type} は ${declared} 側と名乗っているが、実行者は ${actor.role}（${actual} 側）`,
  );
}
