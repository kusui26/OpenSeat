/**
 * 画面の枠。
 *
 * **1 つのことだけを大きく出す**（10.4）。立ったまま、片手で、屋内の明るい
 * ところで読む。
 */

import type { ReactNode } from 'react';

export function Screen({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}): React.JSX.Element {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col gap-5 p-5">
      <h1 className="text-2xl font-bold text-slate-900">{title}</h1>
      {children}
    </main>
  );
}

/** 読み込み中と、断られたときの出し方を揃える。 */
export function Notice({ children }: { readonly children: ReactNode }): React.JSX.Element {
  return (
    <p role="status" className="rounded-lg bg-slate-100 px-4 py-3 text-slate-700">
      {children}
    </p>
  );
}

export function Problem({ children }: { readonly children: ReactNode }): React.JSX.Element {
  return (
    <p role="alert" className="rounded-lg border-2 border-rose-400 bg-rose-50 px-4 py-3 text-rose-900">
      {children}
    </p>
  );
}
