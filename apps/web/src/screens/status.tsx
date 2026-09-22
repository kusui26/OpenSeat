/**
 * 空き状況（`/v/{venue}/status`。10.1）。
 *
 * **登録せずに、いまどれくらい待つかだけを見る。** 受付 QR の下に置く「見るだけ」
 * の導線がここへ来る。
 */

import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router';
import { STREAM_FALLBACK_POLL_MS, VenueStatusResponse } from '@openseat/shared';
import { venueStatus } from '../api.ts';
import { Notice, Problem, Screen } from '../components/layout.tsx';
import { t, tError } from '../i18n.ts';
import { LIVE_QUERY, useLive } from '../use-live.ts';

export function StatusScreen(): React.JSX.Element {
  const venue: string = useParams()['venue'] ?? '';
  const key: readonly unknown[] = ['status', venue];

  const live: boolean = useLive({
    url: `/api/v/${encodeURIComponent(venue)}/stream`,
    event: 'venue',
    checks: VenueStatusResponse,
    queryKey: key,
  });

  const shown = useQuery({
    ...LIVE_QUERY,
    queryKey: key,
    queryFn: () => venueStatus(venue),
    refetchInterval: live ? false : STREAM_FALLBACK_POLL_MS,
  });

  return (
    <Screen title={t('status.heading', { venue: shown.data?.venue.name ?? '' })}>
      {shown.isPending ? <Notice>…</Notice> : null}
      {shown.isError ? <Problem>{tError('INTERNAL')}</Problem> : null}
      {shown.data === undefined ? null : <Body status={shown.data} venue={venue} />}
    </Screen>
  );
}

interface BodyProps {
  readonly status: VenueStatusResponse;
  readonly venue: string;
}

function Body({ status, venue }: BodyProps): React.JSX.Element {
  // **運用していないなら、それだけを言う。** 数字を並べても意味が無い（7.14）。
  if (!status.venue.operating) return <Notice>{t('status.notOperating', {})}</Notice>;
  return (
    <>
      <p className="text-2xl font-bold">{t('status.waiting', { count: status.waiting })}</p>
      <p className="text-lg">
        {t('status.free', { free: status.freeTables, managed: status.managedTables })}
      </p>
      <Estimates rows={status.estimates} />
      {status.venue.joinOpen ? <JoinHere venue={venue} /> : <Notice>{t('venue.joinClosed', {})}</Notice>}
    </>
  );
}

/**
 * 人数ごとの目安（7.13）。
 *
 * **1 つの数字では答えられない。** 4 名で入れる席は少ないので、2 名と 4 名で
 * 待ち時間がまるで違う。
 */
function Estimates({ rows }: { readonly rows: VenueStatusResponse['estimates'] }): React.JSX.Element {
  return (
    <ul className="flex flex-col gap-2">
      {rows.map((row) => (
        <li key={row.partySize} className="rounded-lg bg-slate-100 px-4 py-3">
          <span className="font-bold">{t('status.forParty', { partySize: row.partySize })}</span>
          {': '}
          {row.eta.kind === 'estimate'
            ? t('join.eta', { fromMin: row.eta.fromMin, toMin: row.eta.toMin })
            : t('join.noSeat', {})}
        </li>
      ))}
    </ul>
  );
}

/** 見るだけで来た人が、そのまま並べる導線（10.1）。 */
function JoinHere({ venue }: { readonly venue: string }): React.JSX.Element {
  return (
    <a
      className="rounded-xl bg-slate-900 px-5 py-3 text-center text-lg font-medium text-white"
      href={`/v/${encodeURIComponent(venue)}`}
    >
      {t('status.joinHere', {})}
    </a>
  );
}
