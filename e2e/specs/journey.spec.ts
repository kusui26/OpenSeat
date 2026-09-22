/**
 * 受付から退席まで（開発プラン 9.12、10.1）。
 *
 * > **問い: 人が実際のブラウザで、受付から退席まで通せるか。**
 *
 * **これが「人に見せられる」ことの定義である。** ここが通らなければ、ほかの
 * どれが緑でも現場には出せない。
 *
 * 途中で**一度も画面を読み込み直さない。** 状態が変わったことは配信で届く
 * （9.5、[ADR-0018](../../docs/adr/0018-server-sent-events.md)）ので、それが
 * 効いていることも同時に確かめている。
 */

import { BY_STREAM, expect, say, test, withoutAsking, type Ticket } from './world.ts';

test('受付 → 呼び出し → 着席 → 退席', async ({ page, world }) => {
  // ---- 受付（7.5） ----
  //
  // **入力は人数だけ。** アプリも要らず、アカウントも要らない。
  const ticket: Ticket = await world.join(page);

  // ---- 呼び出し（7.7） ----
  //
  // 席が空いているので、その場で決まる。**待たずに呼ばれる。**
  await expect(page.getByText(say('state.CALLED', {}))).toBeVisible();
  const table = page.getByText(/^お席は T-\d+ です$/);
  await expect(table).toBeVisible();

  const label: string = (await table.textContent())?.replace(/^お席は | です$/g, '') ?? '';
  expect(label).toMatch(/^T-\d+$/);

  // 残り時間が出ている（9.4。**期限はサーバの絶対時刻から数える**）。
  await expect(page.getByText(/^あと \d+ 分 \d+ 秒$/)).toBeVisible();

  // ---- 着席（7.8） ----
  //
  // 卓上の QR を読み取る。**画面を読み込み直さずに**、状態が変わるはずである。
  const asked = withoutAsking(page);
  await world.checkIn(ticket, await world.tokenOf(label));
  await expect(page.getByText(say('state.SEATED', {}))).toBeVisible(BY_STREAM);
  expect(asked(), '取りに行かずに変わったはず').toEqual([]);

  // ---- 退席 ----
  await page.getByRole('button', { name: say('action.CHECK_OUT', {}) }).click();
  await expect(page.getByText(say('state.DONE', {}))).toBeVisible();

  // 終わったら、押せる操作は 1 つも残らない（残るのは URL のコピーだけ）。
  const buttons = page.getByRole('button');
  await expect(buttons).toHaveCount(1);
  await expect(buttons).toHaveText(say('ticket.copyLink', {}));
});

test('画面を閉じても、同じ URL から戻れる（10.4）', async ({ page, context, world }) => {
  // **閉じる人は必ずいる。** 電話が来ただけでも切り替わる。
  await world.join(page);
  const url: string = page.url();
  await expect(page.getByText(say('ticket.keepOpen', {}))).toBeVisible();

  const heading = page.getByRole('heading', { level: 1 });
  const code: string = (await heading.textContent()) ?? '';
  expect(code).toMatch(/^[A-Z]-\d{2} 番$/);

  const reopened = await context.newPage();
  await reopened.goto(url);
  // **同じ番号が出る。** 別のチケットを作り直したりしない。
  await expect(reopened.getByRole('heading', { level: 1 })).toHaveText(code);
  await reopened.close();
});

test('秘密パラメータが合わなければ、他人のチケットは見えない（9.8）', async ({ page, world }) => {
  await world.join(page);
  const wrong: string = page.url().replace(/k=[^&]*/, 'k=wrong-secret-0123456789');

  await page.goto(wrong);
  // **「無い」とも「合っていない」とも言い分けない**（`tickets.ts`）。
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByText(say('state.CALLED', {}))).toBeHidden();
});
