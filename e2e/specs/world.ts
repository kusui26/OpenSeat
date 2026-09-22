/**
 * 筋書きから世界を動かすための道具。
 *
 * **世界は 1 つしかない。** 施設も席も時計も、すべての筋書きで共有している
 * （だから 1 つずつ走らせる。`playwright.config.ts`）。使った席は
 * **筋書きが終わるたびに返す** —— 返さないと、筋書きが増えたあるとき突然、
 * 席が足りなくなって落ちる。
 *
 * **文言は鍵で引く**（`packages/shared`）。日本語を直書きすると、文言を直した
 * ときに「壊れた」のか「変えた」のか分からなくなる。
 */

import {
  bundleFor,
  STREAM_FALLBACK_POLL_MS,
  translate,
  type MessageKey,
  type ParamsOf,
} from '@openseat/shared';
import { expect, test as base, type APIRequestContext, type Page } from '@playwright/test';

/** 施設の名前と待ち受け先。**ハーネスと合わせる。** */
export const VENUE = 'e2e';
const BASE = 'http://127.0.0.1:8130';

const BUNDLE = bundleFor('ja');

/** 画面に出るはずの文言。 */
export function say<K extends MessageKey>(key: K, params: ParamsOf<K>): string {
  return translate(BUNDLE, key, params);
}

/** 1 枚のチケット。**秘密は URL に乗っている。** */
export interface Ticket {
  readonly id: string;
  readonly secret: string;
}

/** 卓の上の QR。 */
export interface Seat {
  readonly label: string;
  readonly token: string;
}

export interface World {
  /** 受付して、チケットの画面まで進む。**片づけは自動でする。** */
  readonly join: (page: Page) => Promise<Ticket>;
  /**
   * 時間を進める（9.12）。
   *
   * **戻ったときには、期限が片づいている。** 進めるだけでは何も起きない
   * （期限を見るのは刻みである）ので、ハーネスが 1 回まわしてから返す。
   */
  readonly advance: (ms: number) => Promise<void>;
  /** その席番号の QR に書いてあるトークン。**現実では卓上の紙を見る。** */
  readonly tokenOf: (label: string) => Promise<string>;
  /**
   * その席の QR を読み取って、着席を知らせる。
   *
   * **画面からは押せない。** 着席は「その席にいる証拠」を求める操作で、座席 QR の
   * 画面から出る（7.8）。その画面は PR 10 で入るので、**それまでは QR を読んだのと
   * 同じことを、契約どおりの呼び出しで起こす。**
   */
  readonly checkIn: (ticket: Ticket, tableToken: string) => Promise<void>;
}

export const test = base.extend<{ world: World }>({
  world: async ({ request }, use) => {
    const opened: Ticket[] = [];
    await use(build(request, opened));
    // **使った席を返す。** 断られたら（もう終わっているなら）そのままでよい。
    for (const ticket of opened) await release(request, ticket);
  },
});

export { expect } from '@playwright/test';

/**
 * 配信で届いたことを確かめる待ち時間（9.5）。
 *
 * 退避のポーリングは 5 秒ごとなので（`STREAM_FALLBACK_POLL_MS`）、半分に切って
 * ある。**ただし、これだけでは足りない** —— ポーリングの刻みがたまたま窓に
 * 入れば、配信が死んでいても通ってしまう。`withoutAsking` と組で使うこと。
 */
export const BY_STREAM = { timeout: STREAM_FALLBACK_POLL_MS / 2 } as const;

/**
 * **取りに行かずに変わったことを確かめる。**
 *
 * 待ち時間だけでは足りない（上記）。**そのあいだ 1 度も問い合わせていない**こと
 * まで見て、はじめて「配信が運んできた」と言える。
 *
 * 実際、これが無いと**配信を止める改変が素通りした。** ポーリングの刻みが窓に
 * 入るかどうかは運なので、検査が運に左右されていた。
 *
 *     const asked = withoutAsking(page);
 *     …何かを起こす…
 *     await expect(…).toBeVisible(BY_STREAM);
 *     expect(asked(), '取りに行かずに変わったはず').toEqual([]);
 */
export function withoutAsking(page: Page): () => string[] {
  const asked: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    // 配信そのものは「取りに行った」に数えない（開きっぱなしの 1 本である）。
    if (url.pathname.startsWith('/api/') && !url.pathname.endsWith('/stream')) {
      asked.push(`${request.method()} ${url.pathname}`);
    }
  });
  return () => [...asked];
}

function build(request: APIRequestContext, opened: Ticket[]): World {
  return {
    join: async (page) => {
      const ticket: Ticket = await register(page);
      opened.push(ticket);
      return ticket;
    },
    advance: async (ms) => {
      const response = await request.post('/__test/clock', { data: { advanceMs: ms } });
      expect(response.ok(), '時間を進められません').toBe(true);
    },
    tokenOf: (label) => tokenOf(request, label),
    checkIn: async (ticket, tableToken) => {
      const response = await act(request, ticket, { action: 'check_in', tableToken });
      expect(response.ok(), `着席できません: ${await response.text()}`).toBe(true);
    },
  };
}

// ---- 画面を操る ----

/** 受付する。**入力は人数だけ**（7.5）。既定の 2 名でよければ、押すだけ。 */
async function register(page: Page): Promise<Ticket> {
  await page.goto(`/v/${VENUE}`);
  await page.getByRole('button', { name: say('join.submit', {}) }).click();
  await page.waitForURL(/\/t\/[^/?]+\?k=/);

  const url = new URL(page.url());
  const id: string | undefined = url.pathname.split('/').at(-1);
  const secret: string | null = url.searchParams.get('k');
  if (id === undefined || secret === null) throw new Error(`チケットの道ではありません: ${url.href}`);
  return { id, secret };
}

// ---- 契約どおりに呼ぶ ----

let keySeq = 0;

function act(request: APIRequestContext, ticket: Ticket, body: unknown): Promise<APIResponse> {
  keySeq += 1;
  return request.post(`/api/t/${ticket.id}/actions?k=${ticket.secret}`, {
    headers: {
      'idempotency-key': `e2e-key-${String(keySeq).padStart(8, '0')}`,
      // 書き込みは `Origin` を照合される（CSRF。`routes/origin.ts`）。
      origin: BASE,
    },
    data: body,
  });
}

type APIResponse = Awaited<ReturnType<APIRequestContext['post']>>;

/** 席を返す。**もう終わっているなら、何もしなくてよい。** */
async function release(request: APIRequestContext, ticket: Ticket): Promise<void> {
  await act(request, ticket, { action: 'cancel', reason: null });
}

async function tokenOf(request: APIRequestContext, label: string): Promise<string> {
  const response = await request.get('/__test/tables');
  const payload: unknown = await response.json();
  const seat: Seat | undefined = seatsIn(payload).find((row) => row.label === label);
  if (seat === undefined) throw new Error(`席 ${label} がありません`);
  return seat.token;
}

/** ハーネスの返しを確かめてから使う。**形が違えば、そこで落とす。** */
function seatsIn(payload: unknown): readonly Seat[] {
  if (typeof payload !== 'object' || payload === null || !('tables' in payload)) {
    throw new Error(`席の一覧が読めません: ${JSON.stringify(payload)}`);
  }
  const rows: unknown = payload.tables;
  if (!Array.isArray(rows) || !rows.every(isSeat)) {
    throw new Error(`席の一覧の形が違います: ${JSON.stringify(rows)}`);
  }
  return rows;
}

function isSeat(value: unknown): value is Seat {
  if (typeof value !== 'object' || value === null) return false;
  if (!('label' in value) || !('token' in value)) return false;
  return typeof value.label === 'string' && typeof value.token === 'string';
}
