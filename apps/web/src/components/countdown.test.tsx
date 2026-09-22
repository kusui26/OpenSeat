// @vitest-environment happy-dom
/**
 * 残り時間の表示（9.4）。
 *
 * **時刻はサーバのみを信頼する**（CLAUDE.md 3.4）。端末の時計は平気で数分ずれて
 * いるので、そのまま引き算すると**呼び出しの期限を実際より長くも短くも見せる。**
 * 短く見せれば人を走らせ、長く見せれば席を空けたまま待たせる。
 *
 * ここで確かめるのは表示だけである。**期限が切れたときに何が起きるかは `tick` が
 * 決める**（CLAUDE.md 3.1）ので、画面は「過ぎました」と言う以上のことをしない。
 */

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { t } from '../i18n.ts';
import { Countdown } from './countdown.tsx';

const SERVER_NOW = Date.UTC(2027, 2, 6, 3, 0, 0);
const MINUTE = 60_000;

/** 端末の時計が、サーバより `skewMs` だけ進んでいる状況を作る。 */
function showWith(skewMs: number, untilMs: number): void {
  vi.useFakeTimers();
  vi.setSystemTime(SERVER_NOW + skewMs);
  render(<Countdown until={SERVER_NOW + untilMs} serverNow={SERVER_NOW} />);
}

/** 秒を進める。**React の更新を取りこぼさないように `act` で包む。** */
async function pass(ms: number): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    await Promise.resolve();
  });
}

const remaining = (minutes: number, seconds: number): string =>
  t('ticket.remaining', { minutes, seconds });

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('端末の時計がずれていても', () => {
  it('進んでいる時計に引きずられない', async () => {
    // 端末が 1 分進んでいる。素直に引き算すると「あと 1 分」に見えてしまう。
    showWith(MINUTE, 2 * MINUTE);
    screen.getByText(remaining(2, 0));

    await pass(30_000);
    screen.getByText(remaining(1, 30));
  });

  it('遅れている時計にも引きずられない', () => {
    showWith(-5 * MINUTE, 2 * MINUTE);
    screen.getByText(remaining(2, 0));
  });

  it('ずれていなければ、そのまま数える', async () => {
    showWith(0, 2 * MINUTE);
    await pass(61_000);
    screen.getByText(remaining(0, 59));
  });
});

describe('期限が来たら', () => {
  it('過ぎたと伝える（負の数を出さない）', async () => {
    showWith(0, 10_000);
    await pass(20_000);
    screen.getByText(t('ticket.expired', {}));
    expect(screen.queryByText(/-/)).toBeNull();
  });
});

describe('読み上げ', () => {
  it('控えめに知らせる（1 秒ごとに割り込まない）', () => {
    showWith(0, 2 * MINUTE);
    // `assertive` だと、数字が変わるたびにほかの読み上げを遮ってしまう。
    const shown: HTMLElement = screen.getByText(remaining(2, 0));
    expect(shown.getAttribute('aria-live')).toBe('polite');
  });
});
