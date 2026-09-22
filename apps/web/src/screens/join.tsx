/**
 * 受付（`/v/{venue}`。10.1）。
 *
 * **入力は人数だけ**（7.5）。アプリも要らず、アカウントも要らない。
 *
 * ここで作るものが 3 つある（9.8、[ADR-0015](../../../../docs/adr/0015-idempotency-key.md)）。
 * **端末の匿名トークン・チケットの秘密・送り直しの鍵。** どれもサーバは作らない。
 */

import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import type { VenueStatusResponse, WaitEstimate } from '@openseat/shared';
import { ApiError, join, venueStatus } from '../api.ts';
import { ActionButton } from '../components/button.tsx';
import { Notice, Problem, Screen } from '../components/layout.tsx';
import { Stepper } from '../components/stepper.tsx';
import { newSecret, rememberTicket } from '../device.ts';
import { STEPPER_MAX_PARTY_SIZE, STEPPER_MIN_PARTY_SIZE } from '../limits.ts';
import { t, tError } from '../i18n.ts';

export function JoinScreen(): React.JSX.Element {
  const venue: string = useParams()['venue'] ?? '';
  const [size, setSize] = useState(2);
  const status = useQuery({
    queryKey: ['status', venue, size],
    queryFn: () => venueStatus(venue, size),
    refetchInterval: 15_000,
  });
  return (
    <Screen title={t('join.heading', { venue: status.data?.venue.name ?? '' })}>
      {status.isPending ? <Notice>…</Notice> : null}
      {status.isError ? <Problem>{tError('INTERNAL')}</Problem> : null}
      {status.data === undefined ? null : (
        <JoinForm venue={venue} status={status.data} size={size} onSize={setSize} />
      )}
    </Screen>
  );
}

interface FormProps {
  readonly venue: string;
  readonly status: VenueStatusResponse;
  readonly size: number;
  readonly onSize: (size: number) => void;
}

function JoinForm({ venue, status, size, onSize }: FormProps): React.JSX.Element {
  const { sending, problem, submit } = useJoin(venue, size);
  const eta: WaitEstimate | undefined = status.estimates[0]?.eta;
  return (
    <>
      {status.venue.joinOpen ? null : <Problem>{t('venue.joinClosed', {})}</Problem>}
      <Estimate eta={eta} />
      <Stepper
        label={t('join.partySize', {})}
        value={size}
        min={STEPPER_MIN_PARTY_SIZE}
        max={STEPPER_MAX_PARTY_SIZE}
        onChange={onSize}
      />
      {problem === null ? null : <Problem>{problem}</Problem>}
      <Submit can={status.venue.joinOpen} sending={sending} onSubmit={submit} />
      <a className="text-center underline" href={`/v/${encodeURIComponent(venue)}/status`}>
        {t('join.watchOnly', {})}
      </a>
    </>
  );
}

/**
 * 順番待ちに入る。
 *
 * **秘密はここで 1 度だけ作る**（ADR-0015）。送り直しても同じ秘密でなければ、
 * 冪等キーが効いたときに**自分のチケットを開けなくなる。**
 *
 * 入れたら、そのままチケットの画面へ移る。**URL を先に覚えておく** ——
 * 移る前に画面を閉じられても、次に開いたときに戻せる（10.4）。
 */
function useJoin(
  venue: string,
  size: number,
): { readonly sending: boolean; readonly problem: string | null; readonly submit: () => void } {
  const navigate = useNavigate();
  const [secret] = useState(newSecret);
  const [problem, setProblem] = useState<string | null>(null);

  const sending = useMutation({
    mutationFn: () => join(venue, { partySize: size, requiredTags: [], secret }),
    onSuccess: (result) => {
      const url = `/t/${result.ticket.id}?k=${encodeURIComponent(secret)}`;
      rememberTicket(url);
      void navigate(url);
    },
    onError: (error: unknown) => {
      setProblem(error instanceof ApiError ? error.problem.message : tError('INTERNAL'));
    },
  });

  return {
    sending: sending.isPending,
    problem,
    submit: () => {
      sending.mutate();
    },
  };
}

/** 登録の 1 手。**押せないときは、押せないと分かる形にする**（10.4）。 */
interface SubmitProps {
  readonly can: boolean;
  readonly sending: boolean;
  readonly onSubmit: () => void;
}

function Submit({ can, sending, onSubmit }: SubmitProps): React.JSX.Element {
  return (
    <ActionButton tone="primary" disabled={!can || sending} onClick={onSubmit}>
      {sending ? t('join.sending', {}) : t('join.submit', {})}
    </ActionButton>
  );
}

/** 目安（7.13）。**幅で見せる。** 分単位の数字をそのまま出すと、正確に見えすぎる。 */
function Estimate({ eta }: { readonly eta: WaitEstimate | undefined }): React.JSX.Element | null {
  if (eta === undefined) return null;
  if (eta.kind === 'no_seat') return <Problem>{t('join.noSeat', {})}</Problem>;
  if (eta.kind !== 'estimate') return null;
  return (
    <Notice>
      {t('join.eta', { fromMin: eta.fromMin, toMin: eta.toMin })}
      {eta.ahead > 0 ? ` / ${t('ticket.ahead', { ahead: eta.ahead })}` : ''}
    </Notice>
  );
}

