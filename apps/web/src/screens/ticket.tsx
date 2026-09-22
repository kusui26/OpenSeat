/**
 * チケット（`/t/{ticketId}?k=`。10.1）。
 *
 * **7.3 の 8 状態すべてを出す。** 状態ごとに押せるものが変わるが、**何を出すかを
 * 決めるのは画面ではない** —— サーバが返した `actions` をそのまま並べる
 * （CLAUDE.md 3.1。`core` に聞いているので、「できます」と出したのに拒否される
 * ことが起きない）。
 *
 * **この画面を閉じないでください**と伝えつつ、**閉じても戻れる URL** を案内する
 * （10.4）。閉じる人は必ずいる。
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useParams, useSearchParams } from 'react-router';
import type { CommandType } from '@openseat/core';
import type { TicketActionRequest, TicketResponse, TicketView } from '@openseat/shared';
import { ApiError, act, readTicket } from '../api.ts';
import { ActionButton } from '../components/button.tsx';
import { Countdown } from '../components/countdown.tsx';
import { Notice, Problem, Screen } from '../components/layout.tsx';
import { StateLine } from '../components/state-line.tsx';
import { Stepper } from '../components/stepper.tsx';
import { STEPPER_MAX_PARTY_SIZE, STEPPER_MIN_PARTY_SIZE } from '../limits.ts';
import { t, tAction, tError } from '../i18n.ts';

/** 呼ばれている人は短く、そうでない人はゆるく取り直す。 */
function intervalFor(view: TicketView | undefined): number | false {
  if (view === undefined) return 5_000;
  if (view.state === 'CALLED') return 3_000;
  return view.endReason === null ? 8_000 : false;
}

export function TicketScreen(): React.JSX.Element {
  const ticketId: string = useParams()['ticket'] ?? '';
  const secret: string = useSearchParams()[0].get('k') ?? '';

  const shown = useQuery({
    queryKey: ['ticket', ticketId, secret],
    queryFn: () => readTicket(ticketId, secret),
    refetchInterval: (query) => intervalFor(query.state.data?.ticket),
  });

  if (shown.isPending) return <Screen title="…"><Notice>…</Notice></Screen>;
  if (shown.isError) {
    const message: string =
      shown.error instanceof ApiError ? shown.error.problem.message : tError('INTERNAL');
    return (
      <Screen title="…">
        <Problem>{message}</Problem>
      </Screen>
    );
  }
  return <TicketBody ticketId={ticketId} secret={secret} shown={shown.data} />;
}

interface BodyProps {
  readonly ticketId: string;
  readonly secret: string;
  readonly shown: TicketResponse;
}

function TicketBody({ ticketId, secret, shown }: BodyProps): React.JSX.Element {
  const cache = useQueryClient();
  const [problem, setProblem] = useState<string | null>(null);
  const view: TicketView = shown.ticket;

  const sending = useMutation({
    mutationFn: (body: TicketActionRequest) => act(ticketId, secret, body),
    onSuccess: (next) => {
      setProblem(null);
      cache.setQueryData(['ticket', ticketId, secret], next);
    },
    onError: (error: unknown) => {
      setProblem(error instanceof ApiError ? error.problem.message : tError('INTERNAL'));
    },
  });

  return (
    <Screen title={t('ticket.heading', { code: view.code })}>
      <StateLine state={view.state} />
      <Assigned view={view} serverNow={shown.serverNow} />
      <Waiting view={view} />
      {problem === null ? null : <Problem>{problem}</Problem>}
      <Actions view={view} sending={sending.isPending} onSend={sending.mutate} />
      <KeepOpen />
    </Screen>
  );
}

/**
 * 案内されている席と、その期限（7.7）。
 *
 * **期限は絶対時刻で来る。** 残りを数えるのは画面だが、**切れたときに何が
 * 起きるかは `tick` が決める**（CLAUDE.md 3.1）。
 */
interface AssignedProps {
  readonly view: TicketView;
  readonly serverNow: number;
}

function Assigned({ view, serverNow }: AssignedProps): React.JSX.Element | null {
  if (view.tableLabel === null && view.holdDeadline === null) return null;
  return (
    <>
      {view.tableLabel === null ? null : (
        <p className="text-xl font-bold">{t('ticket.table', { table: view.tableLabel })}</p>
      )}
      {view.holdDeadline === null ? null : (
        <p className="text-2xl font-bold">
          <Countdown until={view.holdDeadline} serverNow={serverNow} />
        </p>
      )}
    </>
  );
}

/**
 * いま押せるもの。
 *
 * **並べるだけである。** 何を出すかを決めるのはサーバで、画面は `actions` を
 * そのまま写す（CLAUDE.md 3.1）。**足しても引いてもいけない。**
 */
/** 操作を送る 1 本の口。**押したものが、そのまま送られる。** */
type Send = (body: TicketActionRequest) => void;

interface ActionsProps {
  readonly view: TicketView;
  readonly sending: boolean;
  readonly onSend: Send;
}

function Actions({ view, sending, onSend }: ActionsProps): React.JSX.Element {
  return (
    <section className="flex flex-col gap-3">
      {view.actions.map((action) => (
        <OneTap key={action} action={action} sending={sending} onSend={onSend} />
      ))}
      {view.actions.includes('CHANGE_PARTY_SIZE') ? (
        <ChangeSize
          current={view.partySize}
          disabled={sending}
          onChange={(partySize) => {
            onSend({ action: 'change_party_size', partySize });
          }}
        />
      ) : null}
    </section>
  );
}

/** **目立たせるのは、急ぐものだけ**（10.4）。呼ばれている人が迷わないように。 */
const URGENT: readonly CommandType[] = ['READY', 'EXTEND'];

/** 押すだけで送れる操作。引数の要るものはボタンを出さない（`SENDABLE`）。 */
interface OneTapProps {
  readonly action: CommandType;
  readonly sending: boolean;
  readonly onSend: Send;
}

function OneTap({ action, sending, onSend }: OneTapProps): React.JSX.Element | null {
  const body: TicketActionRequest | null = requestFor(action);
  if (body === null) return null;
  return (
    <ActionButton
      tone={URGENT.includes(action) ? 'primary' : 'plain'}
      disabled={sending}
      onClick={() => {
        onSend(body);
      }}
    >
      {tAction(action)}
    </ActionButton>
  );
}

/** 待っているあいだの目安（7.13）。 */
function Waiting({ view }: { readonly view: TicketView }): React.JSX.Element | null {
  if (view.eta.kind !== 'estimate') return null;
  return (
    <Notice>
      {t('join.eta', { fromMin: view.eta.fromMin, toMin: view.eta.toMin })}
      {view.eta.ahead > 0 ? ` / ${t('ticket.ahead', { ahead: view.eta.ahead })}` : ''}
    </Notice>
  );
}

/**
 * 閉じても戻れることを伝える（10.4）。
 *
 * **「閉じないでください」だけでは足りない。** 閉じる人は必ずいるし、電話が
 * 来ただけでも切り替わる。
 */
function KeepOpen(): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  return (
    <section className="mt-4 flex flex-col gap-2 border-t-2 border-slate-200 pt-4 text-slate-700">
      <p className="font-bold">{t('ticket.keepOpen', {})}</p>
      <p className="text-base leading-relaxed">{t('ticket.comeBack', {})}</p>
      <ActionButton
        onClick={() => {
          void navigator.clipboard?.writeText(location.href).then(() => {
            setCopied(true);
          });
        }}
      >
        {copied ? t('ticket.copied', {}) : t('ticket.copyLink', {})}
      </ActionButton>
    </section>
  );
}

/**
 * 押すだけで送れる操作。
 *
 * **引数の要る操作はここに入れない。** 人数の変更は下の `ChangeSize` が受け持つ。
 * 席を指す操作（着席・席の変更）は座席 QR の画面から出る（7.8）。
 *
 * **並びに無いものは、ボタンを出さない。** 別の操作に読み替えてしまうと、
 * 「人数を変える」を押したのに取り消される、という壊れ方をする。
 */
const SENDABLE = {
  CANCEL: { action: 'cancel', reason: null },
  PAUSE: { action: 'pause' },
  READY: { action: 'ready' },
  EXTEND: { action: 'extend' },
  PASS: { action: 'pass' },
  CHECK_OUT: { action: 'check_out' },
  STILL_HERE: { action: 'still_here' },
} as const satisfies Partial<Record<CommandType, TicketActionRequest>>;

function requestFor(action: CommandType): TicketActionRequest | null {
  const known: Partial<Record<CommandType, TicketActionRequest>> = SENDABLE;
  return known[action] ?? null;
}

/** 人数の変更（7.6 のエッジケース）。**待っているあいだだけ出る。** */
interface ChangeSizeProps {
  readonly current: number;
  readonly disabled: boolean;
  readonly onChange: (partySize: number) => void;
}

function ChangeSize({ current, disabled, onChange }: ChangeSizeProps): React.JSX.Element {
  const [size, setSize] = useState(current);
  return (
    <div className="flex flex-col gap-3 rounded-xl border-2 border-slate-300 p-3">
      <Stepper
        label={tAction('CHANGE_PARTY_SIZE')}
        value={size}
        min={STEPPER_MIN_PARTY_SIZE}
        max={STEPPER_MAX_PARTY_SIZE}
        onChange={setSize}
      />
      <ActionButton disabled={disabled || size === current} onClick={() => { onChange(size); }}>
        {tAction('CHANGE_PARTY_SIZE')}
      </ActionButton>
    </div>
  );
}
