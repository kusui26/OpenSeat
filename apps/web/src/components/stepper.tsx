/**
 * 人数を選ぶ（10.4）。
 *
 * **受付でも、あとから変えるときでも同じ形にする。** 同じものを 2 つ書くと、
 * 片方だけ直したときに操作感が食い違う（CLAUDE.md 4 章の DRY）。
 *
 * **大きなボタン 2 つと、大きな数字。** 立ったまま、片手で、屋内の明るいところで
 * 押す。数字は `<output>` に入れて、変わったことを読み上げに乗せる。
 */

import { useId } from 'react';
import { ActionButton } from './button.tsx';
import { t } from '../i18n.ts';

export interface StepperProps {
  readonly label: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly disabled?: boolean;
  readonly onChange: (value: number) => void;
}

export function Stepper(props: StepperProps): React.JSX.Element {
  // **画面に 2 つ出ることがある。** 番号を固定で書くと、読み上げが取り違える。
  const labelId: string = useId();
  const stuck: boolean = props.disabled ?? false;
  const step = (by: number) => () => {
    props.onChange(props.value + by);
  };
  return (
    <section className="flex flex-col gap-3">
      <p className="text-lg font-medium" id={labelId}>
        {props.label}
      </p>
      <div className="flex items-center gap-4">
        <Step sign="−" say={t('join.decrease', {})} off={stuck || props.value <= props.min} on={step(-1)} />
        <Count labelId={labelId} value={props.value} />
        <Step sign="＋" say={t('join.increase', {})} off={stuck || props.value >= props.max} on={step(1)} />
      </div>
    </section>
  );
}

/** いまの人数。**変わったら読み上げる**（10.4）。 */
function Count({ labelId, value }: { readonly labelId: string; readonly value: number }): React.JSX.Element {
  return (
    <output
      aria-labelledby={labelId}
      aria-live="polite"
      className="min-w-20 text-center text-4xl font-bold tabular-nums"
    >
      {value}
    </output>
  );
}

interface StepProps {
  readonly sign: string;
  readonly say: string;
  readonly off: boolean;
  readonly on: () => void;
}

/** 増減のボタン。**記号だけでは読み上げられない**ので、言葉の名前を必ず付ける。 */
function Step({ sign, say, off, on }: StepProps): React.JSX.Element {
  return (
    <ActionButton label={say} disabled={off} onClick={on}>
      {sign}
    </ActionButton>
  );
}
