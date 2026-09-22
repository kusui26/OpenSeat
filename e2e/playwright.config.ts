/**
 * 通しの筋書き（開発プラン 9.12）。
 *
 * **本物のブラウザで、本物の組み上がりを、本物のサーバに当てる。** 単体でも
 * 結合でも捕まえられないのは「配線」だからである —— CSP、画面の中の道、
 * `fetch`、配信、Service Worker。どれも組み合わせたときにだけ壊れる。
 *
 * ## 1 つずつ走らせる理由
 *
 * **世界が 1 つしかない。** 施設も席も時計も、すべての筋書きで共有している。
 * とくに**時計は全体のもの**なので、期限を進める筋書きが並走すると、ほかの
 * 筋書きの人が勝手に順番を失う。分けるより、順に流すほうが速くて確かである
 * （筋書きは数秒で終わる）。
 *
 * ## やり直さない理由
 *
 * **世界が残るので、やり直しは同じ条件にならない。** たまたま通ってしまうと、
 * 壊れていることに気づけない。落ちたら、落ちたままにする。
 */

import { defineConfig, devices } from '@playwright/test';

/** 待ち受ける先。**ハーネスと合わせる。** */
const PORT = 8130;
const BASE = `http://127.0.0.1:${String(PORT)}`;

export default defineConfig({
  testDir: './specs',
  // **画面が出るまでの待ちは、既定（5 秒）では足りないことがある。** 初回は
  // Service Worker の登録と、束ねた JavaScript の読み込みが重なる。
  expect: { timeout: 10_000 },
  timeout: 60_000,

  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: process.env['CI'] !== undefined,
  reporter: process.env['CI'] === undefined ? 'list' : [['github'], ['list']],

  use: {
    baseURL: BASE,
    // **立ったまま、片手で使う画面である**（10.4）。机の上の広い画面で試しても、
    // 現場で起きることは分からない。
    ...devices['Pixel 5'],
    trace: 'retain-on-failure',
    video: 'off',
  },

  projects: [{ name: 'mobile-chromium' }],

  webServer: {
    // **テスト専用のサーバ**（`harness/main.ts` に、本番と何が違うかを書いてある）。
    command: 'node harness/main.ts',
    url: `${BASE}/healthz`,
    cwd: import.meta.dirname,
    env: { E2E_PORT: String(PORT) },
    reuseExistingServer: process.env['CI'] === undefined,
    timeout: 30_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
