/**
 * 残り時間。
 *
 * **クライアントの時計を信じない**（9.4、CLAUDE.md 3.4）。サーバは**絶対時刻の
 * 期限**と**そのときのサーバ時刻**を返すので、その差から時計のずれを打ち消す。
 *
 * ここがしているのは表示だけである。**期限が切れたかどうかの判定は画面に書かない**
 * —— 切れたときに何が起きるかは `tick` が決める（CLAUDE.md 3.1）。
 */

import { useEffect, useState } from 'react';
import { t } from '../i18n.ts';

export interface CountdownProps {
  /** 期限（サーバが入れた絶対時刻）。 */
  readonly until: number;
  /** その返しに入っていたサーバ時刻。**端末の時計との差を打ち消すのに使う。** */
  readonly serverNow: number;
}

/** 端末の時計とサーバの時計の差。**返しを受けた瞬間に測る。** */
function skewOf(serverNow: number): number {
  return Date.now() - serverNow;
}

export function Countdown({ until, serverNow }: CountdownProps): React.JSX.Element {
  const [skew] = useState(() => skewOf(serverNow));
  const [left, setLeft] = useState(() => until - (Date.now() - skew));

  useEffect(() => {
    const timer = setInterval(() => {
      setLeft(until - (Date.now() - skew));
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, [until, skew]);

  const over: boolean = left <= 0;
  return (
    // **読み上げは控えめに。** 1 秒ごとに割り込むと、ほかが読めなくなる。
    <span aria-live="polite" aria-atomic="true" className="tabular-nums">
      {over ? t('ticket.expired', {}) : t('ticket.remaining', split(left))}
    </span>
  );
}

function split(ms: number): { readonly minutes: number; readonly seconds: number } {
  const total: number = Math.max(0, Math.ceil(ms / 1000));
  return { minutes: Math.floor(total / 60), seconds: total % 60 };
}
