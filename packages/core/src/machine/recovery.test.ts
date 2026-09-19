import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, type Policy, type TimeLimitMode } from '../domain/policy.js';
import { createTable, type Table } from '../domain/table.js';
import type { Ticket } from '../domain/ticket.js';
import { createVenueState, findTable, findTicket, type VenueState } from '../domain/state.js';
import type { Decision } from '../decision.js';
import type { Result } from '../result.js';
import { minutes, type Timestamp } from '../time.js';
import { apply } from './apply.js';
import type { Command } from './command.js';
import type { DomainEvent, DomainEventType } from './events.js';
import type { Rejection, RejectionCode } from './rejection.js';
import { tick } from './tick.js';

/**
 * 着席時間の上限（全体プラン 7.10）と、整合性の回復（7.11）。
 *
 * どちらも「時間が経つと何が起きるか」の話なので、`tick` を進めて確かめる。
 */

const NOW: Timestamp = 1_700_000_000_000;

function at(elapsedMin: number): Timestamp {
  return NOW + minutes(elapsedMin);
}

function table(id: string, capacity: number, overrides: Partial<Table> = {}): Table {
  return { ...createTable({ id, label: id, capacity, now: NOW }), status: 'FREE', ...overrides };
}

function venue(policy: Policy = DEFAULT_POLICY, tables: readonly Table[] = [table('tb-4', 4)]): VenueState {
  return { ...createVenueState({ venueId: 'v1', policy, tables }), operating: true, joinOpen: true };
}

type Outcome = Result<Decision<VenueState, DomainEvent>, Rejection>;

function expectOk(result: Outcome): Decision<VenueState, DomainEvent> {
  if (!result.ok) throw new Error(`拒否された: ${result.error.code} ${result.error.describe}`);
  return result.value;
}

function expectRejected(result: Outcome, code: RejectionCode): Rejection {
  if (result.ok) throw new Error(`拒否されるはずが通った: ${JSON.stringify(result.value.events)}`);
  expect(result.error.code).toBe(code);
  return result.error;
}

function run(state: VenueState, command: Command, now: Timestamp): VenueState {
  return expectOk(apply(state, command, now)).state;
}

function advance(state: VenueState, now: Timestamp): VenueState {
  return expectOk(tick(state, now)).state;
}

function ticketOf(state: VenueState, id: string): Ticket {
  const found = findTicket(state, id);
  if (found === undefined) throw new Error(`チケットが無い: ${id}`);
  return found;
}

function tableOf(state: VenueState, id: string): Table {
  const found = findTable(state, id);
  if (found === undefined) throw new Error(`席が無い: ${id}`);
  return found;
}

function eventTypes(decided: Decision<VenueState, DomainEvent>): readonly DomainEventType[] {
  return decided.events.map((event) => event.type);
}

/**
 * 1 人が着席し、待っている人が 1 人いる状態。上限は待ちがいるときだけ効く。
 *
 * 2 卓目は「対象外」にしてある。「使用中（誰か分からない）」にすると、時間が
 * 経つうちにそちらも確認要から空席へ動いてしまい、見たいものが埋もれる。
 */
function seatedWithQueue(policy: Policy): VenueState {
  const tables = [table('tb-4', 4), table('tb-2', 2, { status: 'DISABLED' })];
  let state = venue(policy, tables);
  state = run(
    state,
    { type: 'JOIN', ticketId: 'k1', partySize: 3, requiredTags: [], hasNotificationChannel: true },
    NOW,
  );
  state = run(state, { type: 'CHECK_IN', ticketId: 'k1', tableId: 'tb-4' }, at(1));
  state = run(
    state,
    { type: 'JOIN', ticketId: 'k2', partySize: 4, requiredTags: [], hasNotificationChannel: true },
    at(2),
  );
  expect(ticketOf(state, 'k1').state).toBe('SEATED');
  expect(ticketOf(state, 'k2').state).toBe('WAITING');
  return state;
}

/**
 * 上限だけを見るための設定。
 *
 * 問いかけ（7.11 の 2 層目）を十分あとへずらし、受付からの絶対上限も外す。
 * どちらも上限より先に来ると、見たいものが埋もれる。
 */
function limitOnly(mode: TimeLimitMode): Policy {
  return {
    ...DEFAULT_POLICY,
    timeLimitMode: mode,
    stillHerePromptMin: 600,
    ticketMaxAgeMin: 600,
  };
}

// ---------------------------------------------------------------------------

describe('着席時間の上限（7.10 の 3 モード）', () => {
  it('off では、どれだけ経っても何も起きない', () => {
    const state = seatedWithQueue(limitOnly('off'));
    const late = advance(state, at(300));
    expect(ticketOf(late, 'k1').state).toBe('SEATED');
    expect(tableOf(late, 'tb-4').status).toBe('OCCUPIED');
  });

  it('soft では、上限に達すると知らせが出る（席はまだ動かない）', () => {
    const state = seatedWithQueue(limitOnly('soft'));
    // 着席は 1 分。上限 60 分なので 61 分で知らせ。
    const decided = expectOk(tick(state, at(62)));
    expect(eventTypes(decided)).toEqual(['TimeLimitReached']);
    expect(tableOf(decided.state, 'tb-4').status).toBe('OCCUPIED');
  });

  it('知らせには、いま何組が待っているかが載る', () => {
    const decided = expectOk(tick(seatedWithQueue(limitOnly('soft')), at(62)));
    expect(decided.events[0]).toMatchObject({ type: 'TimeLimitReached', waitingCount: 1 });
  });

  it('知らせは 1 回だけ出る', () => {
    const noticed = advance(seatedWithQueue(limitOnly('soft')), at(62));
    expect(expectOk(tick(noticed, at(63))).events).toEqual([]);
  });

  it('soft では、上限と猶予を過ぎると席が「確認要」になる。チケットは着席のまま', () => {
    const state = seatedWithQueue(limitOnly('soft'));
    // 1 + 60 + 15 = 76 分。
    const over = advance(state, at(77));
    expect(tableOf(over, 'tb-4').status).toBe('NEEDS_CHECK');
    expect(ticketOf(over, 'k1').state).toBe('SEATED');
  });

  /** 7.10 が `hard` を勧めない理由そのもの。自動解放は事故を生む。 */
  it('hard では、上限と猶予を過ぎるとチケットも終わる', () => {
    const over = advance(seatedWithQueue(limitOnly('hard')), at(77));
    expect(ticketOf(over, 'k1').state).toBe('DONE');
    expect(ticketOf(over, 'k1').endReason).toBe('auto_release');
  });

  /** 7.10 の「次の人に『空席の可能性大』として案内可」。確実な空席にはしない。 */
  it('hard で解放された席は「確認要」であって、空席ではない', () => {
    const over = advance(seatedWithQueue(limitOnly('hard')), at(77));
    expect(tableOf(over, 'tb-4').status).toBe('NEEDS_CHECK');
  });

  it('猶予の途中ではまだ動かない', () => {
    const state = seatedWithQueue(limitOnly('soft'));
    expect(tableOf(advance(state, at(70)), 'tb-4').status).toBe('OCCUPIED');
  });

  it('上限と猶予を変えれば、そのぶん早く動く', () => {
    const quick: Policy = { ...limitOnly('soft'), timeLimitMin: 10, overstayGraceMin: 2 };
    const over = advance(seatedWithQueue(quick), at(14));
    expect(tableOf(over, 'tb-4').status).toBe('NEEDS_CHECK');
  });
});

describe('待っている人がいないときは急かさない（7.10 の limit_only_when_waiting）', () => {
  /** 待ちを作らない。席は 1 卓だけで、着席後は誰も並んでいない。 */
  function seatedAlone(policy: Policy): VenueState {
    let state = venue(policy);
    state = run(
      state,
      { type: 'JOIN', ticketId: 'k1', partySize: 3, requiredTags: [], hasNotificationChannel: true },
      NOW,
    );
    return run(state, { type: 'CHECK_IN', ticketId: 'k1', tableId: 'tb-4' }, at(1));
  }

  it('待ちがいなければ、上限を大きく過ぎても何も起きない', () => {
    const alone = advance(seatedAlone(limitOnly('soft')), at(300));
    expect(tableOf(alone, 'tb-4').status).toBe('OCCUPIED');
    expect(ticketOf(alone, 'k1').state).toBe('SEATED');
  });

  it('待ちがいなければ、知らせも出ない', () => {
    expect(expectOk(tick(seatedAlone(limitOnly('soft')), at(200))).events).toEqual([]);
  });

  /** **待ちが生まれた瞬間に評価される。** 待ちの有無は刻々と変わる。 */
  it('待ちが生まれた瞬間に、上限が効き始める', () => {
    // 自動解放を切っておく。切らないと確認要から空席まで一気に進み、
    // 「上限が効き始めた」ことが見えなくなる。
    const noAutoFree: Policy = { ...limitOnly('soft'), needsCheckAutoFreeMin: null };
    const alone = advance(seatedAlone(noAutoFree), at(200));
    expect(tableOf(alone, 'tb-4').status).toBe('OCCUPIED');

    const queued = run(
      alone,
      { type: 'JOIN', ticketId: 'k2', partySize: 4, requiredTags: [], hasNotificationChannel: true },
      at(201),
    );
    expect(ticketOf(queued, 'k2').state).toBe('WAITING');
    expect(tableOf(advance(queued, at(202)), 'tb-4').status).toBe('NEEDS_CHECK');
  });

  it('設定を切れば、待ちがいなくても効く', () => {
    const always: Policy = { ...limitOnly('soft'), limitOnlyWhenWaiting: false };
    expect(tableOf(advance(seatedAlone(always), at(77)), 'tb-4').status).toBe('NEEDS_CHECK');
  });
});

describe('「まだご利用中ですか」（7.11 の 2 層目）', () => {
  /** 上限が先に来ないよう、モードを off にしてある。問いかけは off でも動く。 */
  const asking: Policy = { ...DEFAULT_POLICY, timeLimitMode: 'off' };

  function seated(policy: Policy = asking): VenueState {
    let state = venue(policy);
    state = run(
      state,
      { type: 'JOIN', ticketId: 'k1', partySize: 3, requiredTags: [], hasNotificationChannel: true },
      NOW,
    );
    return run(state, { type: 'CHECK_IN', ticketId: 'k1', tableId: 'tb-4' }, at(1));
  }

  /** 7.10 の末尾「これは退席ボタンの押し忘れを拾うためのもので、上限モードが off でも動く」。 */
  it('上限モードが off でも動く', () => {
    const decided = expectOk(tick(seated(), at(52)));
    expect(eventTypes(decided)).toEqual(['StillHereAsked']);
  });

  it('滞在が p90（既定 50 分）を過ぎると出る', () => {
    expect(expectOk(tick(seated(), at(50))).events).toEqual([]);
    expect(eventTypes(expectOk(tick(seated(), at(52))))).toEqual(['StillHereAsked']);
  });

  it('いつまでに答えればよいかを伝える', () => {
    const decided = expectOk(tick(seated(), at(52)));
    expect(decided.events[0]).toMatchObject({ type: 'StillHereAsked', answerBy: at(51 + 5) });
  });

  it('1 回だけ出る', () => {
    const asked = advance(seated(), at(52));
    expect(expectOk(tick(asked, at(53))).events).toEqual([]);
  });

  it('答えが無いまま 5 分たつと、席が「確認要」になる', () => {
    const asked = advance(seated(), at(52));
    const timedOut = advance(asked, at(57));
    expect(tableOf(timedOut, 'tb-4').status).toBe('NEEDS_CHECK');
    expect(ticketOf(timedOut, 'k1').state).toBe('SEATED');
  });

  it('「まだ利用中」と答えれば、確認要にならない', () => {
    let state = advance(seated(), at(52));
    state = run(state, { type: 'STILL_HERE', ticketId: 'k1' }, at(53));
    expect(tableOf(advance(state, at(80)), 'tb-4').status).toBe('OCCUPIED');
  });

  /**
   * 上限を超えていても、居ることが確かめられた席は落とさない（7.10 の `soft` は
   * 自動で席を取り上げない）。ここが抜けていると、答えた 1 分後にまた確認要に
   * なり、2 層目の問いかけが意味を失う。
   */
  it('「まだ利用中」と答えたあと、上限の超過で落とし直さない', () => {
    const state = advance(seatedWithQueue(limitOnly('soft')), at(77));
    const answered = run(state, { type: 'STILL_HERE', ticketId: 'k1' }, at(78));
    expect(tableOf(answered, 'tb-4').status).toBe('OCCUPIED');
    expect(tableOf(advance(answered, at(79)), 'tb-4').status).toBe('OCCUPIED');
    expect(tableOf(advance(answered, at(200)), 'tb-4').status).toBe('OCCUPIED');
  });

  it('確認要に落ちたあとでも、「まだ利用中」で使用中に戻せる', () => {
    let state = advance(seated(), at(52));
    state = advance(state, at(57));
    expect(tableOf(state, 'tb-4').status).toBe('NEEDS_CHECK');

    const decided = expectOk(apply(state, { type: 'STILL_HERE', ticketId: 'k1' }, at(58)));
    expect(tableOf(decided.state, 'tb-4').status).toBe('OCCUPIED');
    expect(eventTypes(decided)).toEqual(['StillHereAnswered', 'TableOccupied']);
  });

  it('着席していない人は答えられない', () => {
    let state = venue(asking);
    state = run(
      state,
      { type: 'JOIN', ticketId: 'k1', partySize: 3, requiredTags: [], hasNotificationChannel: true },
      NOW,
    );
    expectRejected(apply(state, { type: 'STILL_HERE', ticketId: 'k1' }, at(1)), 'NOT_ALLOWED_IN_STATE');
  });

  /**
   * **退席ボタンは、席がどの状態でも押せる。** 7.11 の 1 層目が「申告を最小の
   * 手間にする」と言っている以上、押し忘れを疑われた人の退席ボタンが効かない
   * のでは本末転倒である。いちばん申告してほしい人が、いちばん押せない。
   */
  it('確認要に落ちた席でも、退席を申告できる', () => {
    const uncertain = advance(seated(), at(57));
    expect(tableOf(uncertain, 'tb-4').status).toBe('NEEDS_CHECK');

    const left = run(uncertain, { type: 'CHECK_OUT', ticketId: 'k1', by: 'user' }, at(58));
    expect(ticketOf(left, 'k1').state).toBe('DONE');
    expect(ticketOf(left, 'k1').endReason).toBe('checked_out');
    // 片付けの猶予（既定 0 分）を経て空席に戻る。「確認要」のままにしない。
    expect(tableOf(left, 'tb-4').status).toBe('FREE');
  });

  it('退席すれば、問いかけの記録も消える', () => {
    let state = advance(seated(), at(52));
    state = run(state, { type: 'CHECK_OUT', ticketId: 'k1', by: 'user' }, at(53));
    const ticket = ticketOf(state, 'k1');
    expect(ticket.state).toBe('DONE');
    expect(ticket.stillHereAskedAt).toBeNull();
  });
});

describe('時間経過による整理（7.11 の 5 層目）', () => {
  it('無断利用の席は、想定滞在時間を過ぎると「確認要」になる', () => {
    const state = venue(DEFAULT_POLICY, [table('tb-4', 4, { status: 'OCCUPIED_UNKNOWN' })]);
    // unknown_occupancy_to_check_min の既定は 40 分。
    expect(tableOf(advance(state, at(39)), 'tb-4').status).toBe('OCCUPIED_UNKNOWN');
    const aged = advance(state, at(41));
    expect(tableOf(aged, 'tb-4').status).toBe('NEEDS_CHECK');
  });

  it('「確認要」になった理由がイベントに載る', () => {
    const state = venue(DEFAULT_POLICY, [table('tb-4', 4, { status: 'OCCUPIED_UNKNOWN' })]);
    const decided = expectOk(tick(state, at(41)));
    expect(decided.events[0]).toMatchObject({ type: 'TableNeedsCheck', reason: 'unknown_aged' });
  });

  it('「確認要」の席は、放置されると自動で空席に戻る', () => {
    const state = venue(DEFAULT_POLICY, [table('tb-4', 4, { status: 'NEEDS_CHECK' })]);
    // needs_check_auto_free_min の既定は 30 分。
    expect(tableOf(advance(state, at(29)), 'tb-4').status).toBe('NEEDS_CHECK');
    const freed = advance(state, at(31));
    expect(tableOf(freed, 'tb-4').status).toBe('FREE');
    expect(tableOf(freed, 'tb-4').verifiedFreeAt).toBe(at(30));
  });

  it('自動解放を切ると、戻らない', () => {
    const manual: Policy = { ...DEFAULT_POLICY, needsCheckAutoFreeMin: null };
    const state = venue(manual, [table('tb-4', 4, { status: 'NEEDS_CHECK' })]);
    expect(tableOf(advance(state, at(600)), 'tb-4').status).toBe('NEEDS_CHECK');
  });

  /**
   * 着席中のチケットが残ったまま席が戻ると、席とチケットの対応が壊れる。
   * **申告せずに去ったものとして扱う。**
   */
  it('自動解放のとき、まだ着席中のチケットも終わる', () => {
    const state = seatedWithQueue(limitOnly('soft'));
    // 76 分で確認要、そこから 30 分で自動解放。
    const reclaimed = advance(state, at(107));
    expect(ticketOf(reclaimed, 'k1').state).toBe('DONE');
    expect(ticketOf(reclaimed, 'k1').endReason).toBe('auto_release');
    expect(ticketOf(reclaimed, 'k1').tableId).toBeNull();
    expect(tableOf(reclaimed, 'tb-4').occupantTicketId).not.toBe('k1');
  });

  it('自動解放で空いた席は、待っていた人に渡る', () => {
    const reclaimed = advance(seatedWithQueue(limitOnly('soft')), at(107));
    expect(ticketOf(reclaimed, 'k2').state).toBe('CALLED');
    expect(ticketOf(reclaimed, 'k2').tableId).toBe('tb-4');
  });

  it('無断利用から自動解放まで、ひと続きで進む', () => {
    const state = venue(DEFAULT_POLICY, [table('tb-4', 4, { status: 'OCCUPIED_UNKNOWN' })]);
    // 40 分で確認要、70 分で空席。1 回の tick でまとめて処理される。
    const settled = advance(state, at(80));
    expect(tableOf(settled, 'tb-4').status).toBe('FREE');
  });
});

describe('確認要の割当（7.11 の 3 層目）', () => {
  /**
   * 前の人の記録が残ったまま「確認要」に落ちた席と、それを待つ人。
   *
   * 退席ボタンを押さずに去った人の席がこうなる。**8.1 の申告率 60% では
   * いちばん多く起きる形**で、3 層目が主に相手にするのはこの席である。
   */
  function uncertainWithQueue(): VenueState {
    const state = advance(seatedWithQueue(limitOnly('soft')), at(77));
    expect(tableOf(state, 'tb-4').status).toBe('NEEDS_CHECK');
    expect(tableOf(state, 'tb-4').occupantTicketId).toBe('k1');
    expect(ticketOf(state, 'k1').state).toBe('SEATED');
    expect(ticketOf(state, 'k2').state).toBe('WAITING');
    return state;
  }

  /** 誰の記録も無い「確認要」の席と、それを待つ人。無断利用が時間で落ちてきた形。 */
  function uncertainUnknown(): VenueState {
    const tables = [table('tb-4', 4, { status: 'NEEDS_CHECK' }), table('tb-2', 2, { status: 'DISABLED' })];
    return run(
      venue(DEFAULT_POLICY, tables),
      { type: 'JOIN', ticketId: 'k9', partySize: 3, requiredTags: [], hasNotificationChannel: true },
      NOW,
    );
  }

  it('確実な空席があるときは、確認要の席を案内しない', () => {
    let state = venue(DEFAULT_POLICY, [table('tb-4', 4), table('tb-2', 2, { status: 'NEEDS_CHECK' })]);
    state = run(
      state,
      { type: 'JOIN', ticketId: 'k1', partySize: 2, requiredTags: [], hasNotificationChannel: true },
      NOW,
    );
    // 確実な空席（tb-4）へ案内される。
    expect(ticketOf(state, 'k1').state).toBe('CALLED');
    expect(ticketOf(state, 'k1').tableId).toBe('tb-4');
  });

  it('案内された人は、空いていればそのまま座れる', () => {
    const seated = run(uncertainWithQueue(), { type: 'CHECK_IN_EARLY', ticketId: 'k2', tableId: 'tb-4' }, at(80));
    expect(ticketOf(seated, 'k2').state).toBe('SEATED');
    expect(tableOf(seated, 'tb-4').status).toBe('OCCUPIED');
    expect(tableOf(seated, 'tb-4').occupantTicketId).toBe('k2');
  });

  /**
   * ここが 7.11 の「現状の『歩き回って探す』より悪くならない」を支えている。
   * 確かめに行った人が席を得られないなら、見に行く理由が無くなる。
   */
  it('確かめに行った人がその席を得る。ほかの人に横取りされない', () => {
    let state = uncertainWithQueue();
    // あとから来た 2 名。空席に戻せば、ロスの小さいこちらが選ばれてしまう。
    state = run(
      state,
      { type: 'JOIN', ticketId: 'k3', partySize: 4, requiredTags: [], hasNotificationChannel: true },
      at(79),
    );
    const seated = run(state, { type: 'CHECK_IN_EARLY', ticketId: 'k2', tableId: 'tb-4' }, at(80));
    expect(ticketOf(seated, 'k2').state).toBe('SEATED');
    expect(ticketOf(seated, 'k3').state).toBe('WAITING');
  });

  it('前の人の記録が残っていれば、申告せずに去ったものとして終わる', () => {
    const seated = run(uncertainWithQueue(), { type: 'CHECK_IN_EARLY', ticketId: 'k2', tableId: 'tb-4' }, at(80));
    expect(ticketOf(seated, 'k1').state).toBe('DONE');
    expect(ticketOf(seated, 'k1').endReason).toBe('auto_release');
    expect(ticketOf(seated, 'k1').tableId).toBeNull();
  });

  it('案内されていない人は、その席に座れない', () => {
    let state = uncertainWithQueue();
    // k3 は 4 名。k2 と同じくこの席に収まるが、案内されているのは k2 のほう。
    state = run(
      state,
      { type: 'JOIN', ticketId: 'k3', partySize: 4, requiredTags: [], hasNotificationChannel: true },
      at(79),
    );
    const rejected = apply(state, { type: 'CHECK_IN_EARLY', ticketId: 'k3', tableId: 'tb-4' }, at(80));
    expectRejected(rejected, 'BLOCKED_BY_GUARD');
  });

  it('案内を切っている施設では、待っている人も座れない', () => {
    const manual: Policy = { ...limitOnly('soft'), assignNeedsCheck: false };
    const state = advance(seatedWithQueue(manual), at(77));
    expectRejected(
      apply(state, { type: 'CHECK_IN_EARLY', ticketId: 'k2', tableId: 'tb-4' }, at(80)),
      'BLOCKED_BY_GUARD',
    );
  });

  it('「使用中だった」と報告すると、その人は次の席で最優先になる', () => {
    const reported = run(uncertainWithQueue(), { type: 'REPORT_IN_USE', ticketId: 'k2', tableId: 'tb-4' }, at(80));
    expect(ticketOf(reported, 'k2').state).toBe('WAITING');
    expect(ticketOf(reported, 'k2').conflictPriority).toBe(true);
  });

  it('記録が残っている席は、その人が居たと分かるので「使用中」に戻る', () => {
    const reported = run(uncertainWithQueue(), { type: 'REPORT_IN_USE', ticketId: 'k2', tableId: 'tb-4' }, at(80));
    expect(tableOf(reported, 'tb-4').status).toBe('OCCUPIED');
    expect(tableOf(reported, 'tb-4').occupantTicketId).toBe('k1');
    expect(ticketOf(reported, 'k1').state).toBe('SEATED');
  });

  it('誰の記録も無い席は、「誰かが使っている」に戻る', () => {
    const reported = run(uncertainUnknown(), { type: 'REPORT_IN_USE', ticketId: 'k9', tableId: 'tb-4' }, at(1));
    expect(tableOf(reported, 'tb-4').status).toBe('OCCUPIED_UNKNOWN');
    expect(tableOf(reported, 'tb-4').occupantTicketId).toBeNull();
  });

  /**
   * 第三者が「使われていた」と見たことは、本人の答えと同じ重みの事実である。
   * 決着をつけないと、無応答の期限が過ぎたままなので、すぐまた確認要に落ちる。
   */
  it('報告のあと、すぐにまた確認要へ落ちない', () => {
    const reported = run(uncertainWithQueue(), { type: 'REPORT_IN_USE', ticketId: 'k2', tableId: 'tb-4' }, at(80));
    expect(tableOf(advance(reported, at(81)), 'tb-4').status).toBe('OCCUPIED');
  });

  it('スタッフが「空席」と確かめれば、残っていたチケットも終わる', () => {
    const freed = run(uncertainWithQueue(), { type: 'CONFIRM_FREE', tableId: 'tb-4', by: 'staff' }, at(80));
    expect(ticketOf(freed, 'k1').state).toBe('DONE');
    expect(ticketOf(freed, 'k1').endReason).toBe('auto_release');
    // 空席に戻ったので、待っていた人が普通に呼ばれる。
    expect(ticketOf(freed, 'k2').state).toBe('CALLED');
    expect(ticketOf(freed, 'k2').tableId).toBe('tb-4');
  });
});
