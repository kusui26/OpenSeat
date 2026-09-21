import { describe, expect, it } from 'vitest';
import {
  DEFAULT_POLICY,
  NO_SHOW_POLICIES,
  TABLE_ORDER_KEYS,
  TIME_LIMIT_MODES,
  validatePolicy,
  type Policy,
} from './policy.js';

/**
 * 全体プラン 7.16「パラメータ一覧（既定値と根拠）」の転記。
 *
 * **この表が仕様との照合点である。** 7.16 の表は 26 行あり、そのうち 3 行が
 * 2 つのキーを定義するため、キーは全部で 29 個になる。
 *
 * `row` は 7.16 の表に書かれているキー名（スネークケース）、`key` は
 * TypeScript 側のキー名。名前を変えたものには `renamedBecause` を書く。
 */
interface SpecRow {
  /** 7.16 の表に現れるキー名。 */
  readonly row: string;
  /** `Policy` のキー名。 */
  readonly key: keyof Policy;
  /** 7.16 が定める既定値。 */
  readonly expected: Policy[keyof Policy];
  /** 名前を変えた場合の理由。 */
  readonly renamedBecause?: string;
}

const SPEC_7_16: readonly SpecRow[] = [
  { row: 'max_party_size', key: 'maxPartySize', expected: null },
  { row: 'hold_min', key: 'holdMin', expected: 7 },
  { row: 'hold_reminder_before_min', key: 'holdReminderBeforeMin', expected: 2 },
  { row: 'hold_extension_min', key: 'holdExtensionMin', expected: 3 },
  { row: 'max_extensions', key: 'maxExtensions', expected: 1 },
  { row: 'no_show_policy', key: 'noShowPolicy', expected: 'requeue_once' },
  { row: 'pause_step_min', key: 'pauseStepMin', expected: 10 },
  { row: 'pause_max_total_min', key: 'pauseMaxTotalMin', expected: 45 },
  { row: 'ticket_max_age_min', key: 'ticketMaxAgeMin', expected: 90 },
  { row: 'abandon_timeout_min', key: 'abandonTimeoutMin', expected: 10 },
  { row: 'fairness_override_min', key: 'fairnessOverrideMin', expected: 10 },
  {
    row: 'table_order',
    key: 'tableOrder',
    expected: ['capacity_asc', 'verified_free_desc', 'admin_rank', 'label'],
  },
  { row: 'allow_table_swap', key: 'allowTableSwap', expected: true },
  { row: 'turnover_min', key: 'turnoverMin', expected: 0 },
  { row: 'time_limit_mode', key: 'timeLimitMode', expected: 'soft' },
  { row: 'time_limit_min', key: 'timeLimitMin', expected: 60 },
  { row: 'limit_only_when_waiting', key: 'limitOnlyWhenWaiting', expected: true },
  { row: 'overstay_grace_min', key: 'overstayGraceMin', expected: 15 },
  {
    row: 'still_here_prompt_at',
    key: 'stillHerePromptMin',
    expected: 50,
    renamedBecause: '時刻ではなく滞在時間の分数なので、単位を名前に入れた（CLAUDE.md 4 章）',
  },
  { row: 'still_here_timeout_min', key: 'stillHereTimeoutMin', expected: 5 },
  { row: 'assign_needs_check', key: 'assignNeedsCheck', expected: true },
  { row: 'unknown_occupancy_to_check_min', key: 'unknownOccupancyToCheckMin', expected: 40 },
  { row: 'needs_check_auto_free_min', key: 'needsCheckAutoFreeMin', expected: 30 },
  { row: 'long_wait_confirm_min', key: 'longWaitConfirmMin', expected: 40 },
  { row: 'max_queue_length', key: 'maxQueueLength', expected: 100 },
  {
    row: 'join_rate_limit',
    key: 'joinRateLimitPerHour',
    expected: 5,
    renamedBecause: '「5 回/時/端末」のうち、時間あたりの回数であることを名前で示した',
  },
  { row: 'join_cutoff_before_close_min', key: 'joinCutoffBeforeCloseMin', expected: 15 },
  { row: 'assumed_stay_min', key: 'assumedStayMin', expected: 35 },
  {
    row: 'eta_display',
    key: 'etaBucketMin',
    expected: 5,
    renamedBecause: '「5 分刻みの幅表示」のうち、刻みの分数を表す値なので名前を具体化した',
  },
];

describe('Policy と全体プラン 7.16 の対応', () => {
  it('7.16 の表は 26 行で、29 個のキーを定義する', () => {
    const rows = new Set(SPEC_7_16.map((entry) => entry.row));
    expect(SPEC_7_16).toHaveLength(29);
    // hold_extension_min / max_extensions のように 1 行が 2 キーを定義する行が 3 つある
    expect(rows.size).toBe(29);
  });

  it('Policy のすべてのキーが 7.16 の表に現れる（実装に余分なキーが無い）', () => {
    const inPolicy = Object.keys(DEFAULT_POLICY).sort();
    const inSpec = SPEC_7_16.map((entry) => entry.key).sort();
    expect(inPolicy).toEqual(inSpec);
  });

  it('7.16 のすべての項目が Policy に存在する（実装に漏れが無い）', () => {
    const missing = SPEC_7_16.filter((entry) => !(entry.key in DEFAULT_POLICY));
    expect(missing.map((entry) => entry.row)).toEqual([]);
  });

  it('名前を変えたキーには理由が書かれている', () => {
    const renamed = SPEC_7_16.filter((entry) => entry.row.replace(/_/g, '') !== entry.key.toLowerCase());
    expect(renamed.length).toBeGreaterThan(0);
    for (const entry of renamed) {
      expect(entry.renamedBecause, `${entry.row} の改名理由`).toBeTruthy();
    }
  });

  it.each(SPEC_7_16)('$row の既定値は 7.16 のとおり', ({ key, expected }) => {
    expect(DEFAULT_POLICY[key]).toEqual(expected);
  });
});

describe('列挙の値', () => {
  it('ノーショー方針は 7.7 の 3 種類', () => {
    expect(NO_SHOW_POLICIES).toEqual(['cancel', 'requeue_once', 'requeue_back']);
  });

  it('着席時間の上限は 7.10 の 3 モード', () => {
    expect(TIME_LIMIT_MODES).toEqual(['off', 'soft', 'hard']);
  });

  it('席の並び順の鍵は 7.6 の 4 種類', () => {
    expect(TABLE_ORDER_KEYS).toEqual([
      'capacity_asc',
      'verified_free_desc',
      'admin_rank',
      'label',
    ]);
  });
});

describe('validatePolicy', () => {
  function withOverride(override: Partial<Policy>): Policy {
    return { ...DEFAULT_POLICY, ...override };
  }

  function keysOfProblems(policy: Policy): readonly string[] {
    return validatePolicy(policy).map((problem) => problem.key);
  }

  it('既定値は問題なし', () => {
    expect(validatePolicy(DEFAULT_POLICY)).toEqual([]);
  });

  describe('関係の検査', () => {
    it('リマインドはホールドの期限より前でなければならない', () => {
      expect(keysOfProblems(withOverride({ holdReminderBeforeMin: 7 }))).toContain(
        'holdReminderBeforeMin',
      );
    });

    it('リマインドが期限より 1 分でも前なら問題なし', () => {
      expect(keysOfProblems(withOverride({ holdMin: 7, holdReminderBeforeMin: 6 }))).toEqual([]);
    });

    it('保留の合計上限は 1 回分の延長以上でなければならない', () => {
      expect(keysOfProblems(withOverride({ pauseStepMin: 50, pauseMaxTotalMin: 45 }))).toContain(
        'pauseMaxTotalMin',
      );
    });

    it('上限モードが off 以外なら上限の分数が必要', () => {
      expect(keysOfProblems(withOverride({ timeLimitMode: 'soft', timeLimitMin: 0 }))).toContain(
        'timeLimitMin',
      );
    });

    it('上限モードが off なら上限の分数が 0 でも問題にしない', () => {
      expect(keysOfProblems(withOverride({ timeLimitMode: 'off', timeLimitMin: 0 }))).toEqual([]);
    });
  });

  describe('値の範囲', () => {
    it('負の分数を拒否する', () => {
      expect(keysOfProblems(withOverride({ holdMin: -1 }))).toContain('holdMin');
    });

    it('NaN を拒否する', () => {
      expect(keysOfProblems(withOverride({ turnoverMin: Number.NaN }))).toContain('turnoverMin');
    });

    it('fairnessOverrideMin は Infinity を許す（純粋な best fit を表すため）', () => {
      expect(validatePolicy(withOverride({ fairnessOverrideMin: Number.POSITIVE_INFINITY }))).toEqual(
        [],
      );
    });

    it('fairnessOverrideMin は 0 を許す（厳密な先着順を表すため）', () => {
      expect(validatePolicy(withOverride({ fairnessOverrideMin: 0 }))).toEqual([]);
    });

    it('fairnessOverrideMin 以外の分数は Infinity を拒否する', () => {
      expect(keysOfProblems(withOverride({ holdMin: Number.POSITIVE_INFINITY }))).toContain(
        'holdMin',
      );
    });

    it('待ち行列の上限は 1 以上', () => {
      expect(keysOfProblems(withOverride({ maxQueueLength: 0 }))).toContain('maxQueueLength');
    });

    it('maxPartySize は null を許す（対象席から導くため）', () => {
      expect(validatePolicy(withOverride({ maxPartySize: null }))).toEqual([]);
    });

    it('maxPartySize が 0 以下なら拒否する', () => {
      expect(keysOfProblems(withOverride({ maxPartySize: 0 }))).toContain('maxPartySize');
    });

    it('needsCheckAutoFreeMin は null を許す（自動解放しない設定）', () => {
      expect(validatePolicy(withOverride({ needsCheckAutoFreeMin: null }))).toEqual([]);
    });

    it('needsCheckAutoFreeMin が 0 なら拒否する（0 分は自動解放ではなく即時解放になる）', () => {
      expect(keysOfProblems(withOverride({ needsCheckAutoFreeMin: 0 }))).toContain(
        'needsCheckAutoFreeMin',
      );
    });

    it('ETA の刻みは 1 分以上', () => {
      expect(keysOfProblems(withOverride({ etaBucketMin: 0 }))).toContain('etaBucketMin');
    });
  });

  describe('席の並び順', () => {
    it('空の並び順を拒否する', () => {
      expect(keysOfProblems(withOverride({ tableOrder: [] }))).toContain('tableOrder');
    });

    it('同じ鍵の重複を拒否する', () => {
      expect(
        keysOfProblems(withOverride({ tableOrder: ['capacity_asc', 'capacity_asc'] })),
      ).toContain('tableOrder');
    });

    it('鍵が 1 つだけでも問題なし（8.2 の比較項目 5 のため）', () => {
      expect(validatePolicy(withOverride({ tableOrder: ['capacity_asc'] }))).toEqual([]);
    });
  });

  it('複数の誤りをすべて報告する（最初の 1 件で止まらない）', () => {
    const problems = validatePolicy(
      withOverride({ maxQueueLength: 0, tableOrder: [], etaBucketMin: 0 }),
    );
    expect(problems.map((problem) => problem.key).sort()).toEqual([
      'etaBucketMin',
      'maxQueueLength',
      'tableOrder',
    ]);
  });

  it('1 つの誤りが関係の検査も連鎖して破ることがある', () => {
    // holdMin を負にすると、既定の holdReminderBeforeMin = 2 が
    // 「holdMin より小さいこと」を満たせなくなる。両方が報告される。
    expect([...keysOfProblems(withOverride({ holdMin: -1 }))].sort()).toEqual([
      'holdMin',
      'holdReminderBeforeMin',
    ]);
  });
});
