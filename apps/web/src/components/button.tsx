/**
 * 押せるもの。
 *
 * **素の `<button>` にしてある。** 部品の一式を入れるほどの数が無いのと、
 * 支援技術との相性は素の要素がいちばんよいためである（10.4）。
 *
 * **指で押せる大きさ**にする。立ったまま、片手で押す（10.4）。
 */

import type { ReactNode } from 'react';

export interface ActionButtonProps {
  readonly onClick: () => void;
  readonly children: ReactNode;
  readonly tone?: 'primary' | 'plain';
  readonly disabled?: boolean;
  readonly label?: string;
}

const TONES = {
  primary: 'bg-slate-900 text-white hover:bg-slate-700',
  plain: 'border-2 border-slate-400 bg-white text-slate-900 hover:bg-slate-100',
} as const;

export function ActionButton(props: ActionButtonProps): React.JSX.Element {
  const tone = TONES[props.tone ?? 'plain'];
  return (
    <button
      type="button"
      onClick={props.onClick}
      disabled={props.disabled ?? false}
      aria-label={props.label}
      // 44px 四方は、指で押せる大きさの目安である。
      className={`min-h-[3rem] w-full rounded-xl px-5 py-3 text-lg font-medium disabled:opacity-40 ${tone}`}
    >
      {props.children}
    </button>
  );
}
