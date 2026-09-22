/**
 * 空き状況の画面（開発プラン 10.1）と、配信（9.5）。
 *
 * > **問い: 登録していない人の画面も、取りに行かずに新しくなるか。**
 *
 * 受付 QR の下の「見るだけ」導線がここへ来る。**並ぶ前に混み具合を見て、
 * それから決める人がいる**ので、ここが古いままだと判断を誤らせる。
 */

import { BY_STREAM, expect, say, test, VENUE, withoutAsking } from './world.ts';

test('混み具合が出る', async ({ page }) => {
  await page.goto(`/v/${VENUE}/status`);

  await expect(page.getByRole('heading', { level: 1 })).toContainText('E2E フードコート');
  // **席の内訳は数だけ**（どの席が空いているかは出さない。7.11）。
  await expect(page.getByText(/^空いているお席 \d+ \/ \d+$/)).toBeVisible();
  await expect(page.getByText(/^\d+ 組がお待ちです$/)).toBeVisible();

  // 人数ごとの目安（7.13）。**1 つの数字では答えられない。**
  await expect(page.getByRole('listitem')).toHaveCount(4);
});

test('ほかの人が並ぶと、取りに行かなくても変わる（9.5）', async ({ page, context, world }) => {
  await page.goto(`/v/${VENUE}/status`);
  const free = page.getByText(/^空いているお席 \d+ \/ \d+$/);
  await expect(free).toBeVisible();
  const before: string = (await free.textContent()) ?? '';
  const asked = withoutAsking(page);

  // 別の人が、別の端末から並ぶ。
  const other = await context.newPage();
  await world.join(other);
  await expect(other.getByText(say('state.CALLED', {}))).toBeVisible();

  // **こちらの画面は触っていない。** それでも空席が 1 つ減る。
  await expect(free).not.toHaveText(before, BY_STREAM);
  expect(asked(), '取りに行かずに変わったはず').toEqual([]);
  await other.close();
});

test('見るだけの人が、そのまま並べる（10.1）', async ({ page }) => {
  await page.goto(`/v/${VENUE}/status`);
  await page.getByRole('link', { name: say('status.joinHere', {}) }).click();

  await expect(page).toHaveURL(new RegExp(`/v/${VENUE}$`));
  await expect(page.getByRole('button', { name: say('join.submit', {}) })).toBeVisible();
});
