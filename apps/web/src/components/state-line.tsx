/**
 * いまどうなっているか（7.3 の 8 状態）。
 *
 * **色と文字の両方で示す**（10.4）。色覚多様性のため、色だけに意味を持たせない ——
 * 状態の名前は必ず文字で出し、色は添えるだけにする。
 */

import type { TicketState } from '@openseat/core';
import { tState } from '../i18n.ts';

/**
 * 状態ごとの見た目。
 *
 * **全 8 状態を並べる。** 状態が増えたら、ここも埋めないと型が通らない。
 */
const TONE = {
  WAITING: 'border-slate-400 bg-slate-50 text-slate-900',
  PAUSED: 'border-amber-500 bg-amber-50 text-amber-900',
  CALLED: 'border-emerald-600 bg-emerald-50 text-emerald-900',
  SEATED: 'border-sky-600 bg-sky-50 text-sky-900',
  DONE: 'border-slate-300 bg-white text-slate-700',
  CANCELLED: 'border-slate-300 bg-white text-slate-700',
  NO_SHOW: 'border-rose-400 bg-rose-50 text-rose-900',
  EXPIRED: 'border-rose-400 bg-rose-50 text-rose-900',
} as const satisfies Readonly<Record<TicketState, string>>;

export function StateLine({ state }: { readonly state: TicketState }): React.JSX.Element {
  return (
    <p
      // **状態が変わったら読み上げる。** 呼び出しに気づかないのがいちばん困る（6.6）。
      aria-live="polite"
      className={`rounded-lg border-2 px-4 py-3 text-lg leading-relaxed ${TONE[state]}`}
    >
      {tState(state)}
    </p>
  );
}
