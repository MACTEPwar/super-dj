import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { buildRequestCommand, fetchPublicRequestPage, PublicTrack } from '../api/requestPage';
import { formatSeconds } from './requestPageFormat';

// PUBLIC page (no auth, no AppShell): a donor opens it from the streamer's shared link. Loaded
// once — no polling/SSE by design; a manual Refresh only.
export default function RequestPage() {
  const { t } = useTranslation();
  const { token = '' } = useParams();
  // Load-time only (spec): no refetch on window focus/reconnect, only the manual Refresh button.
  const query = useQuery({
    queryKey: ['public-request-page', token],
    queryFn: () => fetchPublicRequestPage(token),
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  useEffect(() => {
    // Never leak the token through Referer (spec A16).
    const meta = document.createElement('meta');
    meta.name = 'referrer';
    meta.content = 'no-referrer';
    document.head.appendChild(meta);
    document.title = t('requestPage.title');
    return () => { meta.remove(); };
  }, [t]);

  const data = query.data;

  return (
    <main className="mx-auto max-w-2xl space-y-4 p-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{t('requestPage.title')}</h1>
        <button onClick={() => query.refetch()} className="text-sm underline">{t('requestPage.refresh')}</button>
      </div>
      {query.isLoading && <p>{t('requestPage.loading')}</p>}
      {query.isError && <p className="text-red-600">{t('requestPage.error')}</p>}
      {data?.kind === 'notFound' && <p>{t('requestPage.notFound')}</p>}
      {data?.kind === 'offline' && <p>{t('requestPage.offline')}</p>}
      {data?.kind === 'live' && (
        <>
          <h2 className="text-lg">{data.playlistName}</h2>
          {data.request
            ? <p className="text-sm text-gray-600">{t('requestPage.howTo', { amount: data.request.minAmount })}</p>
            : <p className="text-sm text-gray-600">{t('requestPage.requestsDisabled')}</p>}
          <ul className="divide-y rounded-lg border">
            {data.tracks.map((track) => (
              <TrackRow key={track.id} track={track} keyword={data.request?.keyword ?? null} />
            ))}
          </ul>
        </>
      )}
    </main>
  );
}

function TrackRow({ track, keyword }: { track: PublicTrack; keyword: string | null }) {
  const { t } = useTranslation();
  const [state, setState] = useState<'idle' | 'copied' | 'manual'>('idle');
  const command = keyword ? buildRequestCommand(keyword, track.name, track.id) : null;

  const copy = async () => {
    if (!command) return;
    try {
      if (!navigator.clipboard) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(command);
      setState('copied');
    } catch {
      setState('manual'); // non-secure context or permission denied (spec A13)
    }
  };

  return (
    <li className="p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate">{track.name}</div>
          {track.durationSeconds !== null && <div className="text-xs text-gray-500">{formatSeconds(track.durationSeconds)}</div>}
        </div>
        {command && (
          <button onClick={copy} className="shrink-0 rounded bg-black px-3 py-1 text-sm text-white">
            {state === 'copied' ? t('requestPage.copied') : t('requestPage.copy')}
          </button>
        )}
      </div>
      {state === 'manual' && command && (
        <label className="mt-2 block text-xs text-gray-500">
          {t('requestPage.copyManually')}
          <input readOnly value={command} onFocus={(e) => e.currentTarget.select()} autoFocus className="mt-1 w-full rounded border p-2 font-mono text-sm" />
        </label>
      )}
    </li>
  );
}
