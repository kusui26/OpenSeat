/**
 * 期限が来たとき（開発プラン 7.7、9.12）。
 *
 * > **問い: 時間が経ったことが、画面に届くか。**
 *
 * **ここは画面が自分で判断してはならないところである**（CLAUDE.md 3.1）。
 * 期限を過ぎたかを決めるのはサーバの刻みで、画面は届いた姿を描くだけである。
 * だから「時間を進めたら、取りに行かなくても画面が変わる」ことを見る。
 *
 * 時間はハーネスが進める（`harness/control.ts`）。**その口は本番に無い。**
 */

import { BY_STREAM, expect, say, test, withoutAsking } from './world.ts';

const MINUTE = 60_000;

/** ホールドの期限（7.16 の `hold_min` は 7 分）。**超えるところまで進める。** */
const PAST_HOLD = 8 * MINUTE;

/** 保留の期限（`pause_step_min` は 10 分）。 */
const PAST_PAUSE = 11 * MINUTE;

/** 保留を重ねられる上限（`pause_max_total_min` は 45 分）。 */
const PAST_PAUSE_LIMIT = 46 * MINUTE;

test('呼ばれたまま動かないと、順番は残したまま保留になる（7.7 の 6）', async ({ page, world }) => {
  await world.join(page);
  await expect(page.getByText(say('state.CALLED', {}))).toBeVisible();

  const asked = withoutAsking(page);
  await world.advance(PAST_HOLD);

  // **順番を失わせない**（CLAUDE.md 2 の 5）。1 回目のノーショーは保留にするだけで、
  // 「準備OK」を押せば待ちに戻れる。
  await expect(page.getByText(say('state.PAUSED', {}))).toBeVisible(BY_STREAM);
  expect(asked(), '取りに行かずに届いたはず').toEqual([]);
  await expect(page.getByRole('button', { name: say('action.READY', {}) })).toBeVisible();
});

test('保留のまま上限を過ぎると、順番待ちが終わる（7.7 の 7）', async ({ page, world }) => {
  await world.join(page);
  await world.advance(PAST_HOLD);
  await expect(page.getByText(say('state.PAUSED', {}))).toBeVisible();

  await world.advance(PAST_PAUSE_LIMIT);

  await expect(page.getByText(say('state.EXPIRED', {}))).toBeVisible(BY_STREAM);
  // 終わったら、押せる操作は残らない（残るのは URL のコピーだけ）。
  await expect(page.getByRole('button')).toHaveCount(1);
});

test('保留から「準備OK」を押すと、待ちに戻れる（7.7 の 6）', async ({ page, world }) => {
  await world.join(page);
  await world.advance(PAST_HOLD);
  await expect(page.getByText(say('state.PAUSED', {}))).toBeVisible();

  await page.getByRole('button', { name: say('action.READY', {}) }).click();

  // 席が空いていれば、その場でまた呼ばれる。
  await expect(page.getByText(say('state.CALLED', {}))).toBeVisible();
});

test('「向かっています」を押すと、期限が延びる（7.7 の 4）', async ({ page, world }) => {
  await world.join(page);
  await expect(page.getByText(say('state.CALLED', {}))).toBeVisible();

  await page.getByRole('button', { name: say('action.EXTEND', {}) }).click();
  // 延ばせるのは既定で 1 回だけ（`max_extensions`）。押したら消える。
  await expect(page.getByRole('button', { name: say('action.EXTEND', {}) })).toBeHidden();

  // 元の期限（7 分）を過ぎても、延ばしたぶん（3 分）はまだ呼ばれたまま。
  await world.advance(PAST_HOLD);
  await expect(page.getByText(say('state.CALLED', {}))).toBeVisible();

  await world.advance(PAST_PAUSE);
  await expect(page.getByText(say('state.PAUSED', {}))).toBeVisible(BY_STREAM);
});
