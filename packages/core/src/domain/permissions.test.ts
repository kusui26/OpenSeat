/**
 * 権限表。
 *
 * **表そのものが正しいかは、人が読んで決めることである。** ここで見るのは、
 * 表が**漏れなく・矛盾なく**書かれていることと、**表に無い組み合わせが通らない**
 * ことである。
 */

import { describe, expect, it } from 'vitest';
import { COMMAND_TYPES, type CommandType } from '../machine/command.js';
import { ROLES, sideOf, ticketOwner, type Role } from './actor.js';
import { PERMISSIONS, isPermitted, ownsTarget, targetTicketId } from './permissions.js';

/**
 * 表を、値の並びとして読む。
 *
 * `as const` のままだと、TypeScript が**いまの中身から**長さを 1〜5 と決めてしまい、
 * 「空の行が無いか」を実行時に見ようとすると「ありえない比較」と言われる。
 * **空の行が書かれた日に効いてほしい検査**なので、型を広げて残す。
 */
const TABLE: Readonly<Record<string, readonly Role[]>> = PERMISSIONS;

describe('表の書かれ方', () => {
  it('すべてのコマンドが並んでいる', () => {
    expect(Object.keys(PERMISSIONS).toSorted()).toEqual([...COMMAND_TYPES].toSorted());
  });

  it('挙がっている役割は、すべて実在する', () => {
    const known = new Set<string>(ROLES);
    const unknown = Object.values(PERMISSIONS)
      .flat()
      .filter((role) => !known.has(role));
    expect(unknown).toEqual([]);
  });

  it('同じ役割を 2 度書いていない', () => {
    const duplicated = Object.entries(PERMISSIONS).filter(
      ([, roles]) => new Set(roles).size !== roles.length,
    );
    expect(duplicated).toEqual([]);
  });

  /** **誰も出せないコマンドは、あっても意味が無い。** 書き忘れの形として出る。 */
  it('誰も出せないコマンドが無い', () => {
    const orphans = Object.entries(TABLE).filter(([, roles]) => roles.length === 0);
    expect(orphans).toEqual([]);
  });

  /**
   * **匿名で出せるのは、4 つだけであってほしい。**
   *
   * 受付（7.5）、飛び込み着席（7.12）、席についての報告 2 つ（7.8・7.11）。
   * ここが増えるときは、**チケットも持たない通りすがりの人に何を許すのか**を
   * 考え直す合図である。
   */
  it('匿名で出せるコマンドが、増えていない', () => {
    const open = COMMAND_TYPES.filter((command) => isPermitted('anonymous', command));
    expect(open.toSorted()).toEqual(['CONFIRM_FREE', 'JOIN', 'REPORT_IN_USE', 'WALK_IN']);
  });

  /** 所有者は、管理者にできることをすべてできる（9.8 の役割の並び）。 */
  it('所有者は管理者にできることをすべてできる', () => {
    const missing = COMMAND_TYPES.filter(
      (command) => isPermitted('admin', command) && !isPermitted('owner', command),
    );
    expect(missing).toEqual([]);
  });

  /** 管理者は、スタッフにできることをすべてできる。 */
  it('管理者はスタッフにできることをすべてできる', () => {
    const missing = COMMAND_TYPES.filter(
      (command) => isPermitted('staff', command) && !isPermitted('admin', command),
    );
    expect(missing).toEqual([]);
  });
});

describe('役割 × コマンドの総当たり', () => {
  const pairs: readonly (readonly [Role, CommandType])[] = ROLES.flatMap((role) =>
    COMMAND_TYPES.map((command): readonly [Role, CommandType] => [role, command]),
  );

  it('110 通りすべてに、表の答えがある', () => {
    expect(pairs).toHaveLength(ROLES.length * COMMAND_TYPES.length);
    expect(pairs.filter(([role, command]) => typeof isPermitted(role, command) !== 'boolean')).toEqual(
      [],
    );
  });

  it.each(pairs)('%s が %s を出せるかは、表のとおり', (role, command) => {
    const allowed: readonly Role[] = PERMISSIONS[command];
    expect(isPermitted(role, command)).toBe(allowed.includes(role));
  });
});

describe('本人が相手にできるチケット', () => {
  const owner = ticketOwner('k-1');

  it('自分のチケットなら通る', () => {
    expect(ownsTarget(owner, { type: 'PAUSE', ticketId: 'k-1' })).toBe(true);
  });

  /** **これが無いと、チケット A の秘密パラメータでチケット B を取り消せる。** */
  it('他人のチケットは通らない', () => {
    expect(ownsTarget(owner, { type: 'PAUSE', ticketId: 'k-2' })).toBe(false);
  });

  /**
   * **受付と飛び込みは、作る側である。**
   *
   * すでに並んでいる人がもう 1 枚取ろうとすると ID が違うので、ここを
   * 取り違えると 2 枚目が取れなくなる。
   */
  it('受付と飛び込みは、持っているチケットと ID が違っても通る', () => {
    const join = { type: 'JOIN', ticketId: 'k-9', partySize: 2, requiredTags: [], hasNotificationChannel: false } as const;
    const walkIn = { type: 'WALK_IN', ticketId: 'k-9', tableId: 't-1', partySize: 2 } as const;

    expect(targetTicketId(join)).toBeNull();
    expect(ownsTarget(owner, join)).toBe(true);
    expect(ownsTarget(owner, walkIn)).toBe(true);
  });

  it('チケットを相手にしない操作は、そもそも関係しない', () => {
    expect(ownsTarget(owner, { type: 'CONFIRM_FREE', tableId: 't-1', by: 'user' })).toBe(true);
  });

  it('スタッフは、どのチケットも相手にできる', () => {
    const staff = { role: 'staff', ticketId: null, userId: 'u-1' } as const;
    expect(ownsTarget(staff, { type: 'CANCEL', ticketId: 'k-2', by: 'staff', reason: 'other' })).toBe(
      true,
    );
  });

  /** 添えなかった報告は、誰の相手でもない（7.8 の 10 は任意）。 */
  it('相手を添えない報告は、本人でも通る', () => {
    expect(ownsTarget(owner, { type: 'REPORT_IN_USE', tableId: 't-1', ticketId: null })).toBe(true);
  });
});

describe('役割と、記録に残る側', () => {
  it.each(ROLES)('%s には、記録する側が決まっている', (role) => {
    expect(['user', 'staff']).toContain(sideOf(role));
  });

  it('利用者側は匿名と本人、スタッフ側はそれ以外', () => {
    expect(ROLES.filter((role) => sideOf(role) === 'user')).toEqual(['anonymous', 'ticket_owner']);
    expect(ROLES.filter((role) => sideOf(role) === 'staff')).toEqual(['staff', 'admin', 'owner']);
  });
});
