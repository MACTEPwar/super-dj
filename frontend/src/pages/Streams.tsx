import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { streamSessionsApi } from '../api/streamSessions';
import { playlistsApi } from '../api/playlists';
import { destinationsApi } from '../api/destinations';
import { ApiError } from '../api/client';
import { StartStreamDrawer } from '../components/StartStreamDrawer';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { usePageTitle } from '../hooks/usePageTitle';

const STATE_BADGE: Record<string, string> = {
  idle: 'bg-gray-100 text-gray-600',
  streaming: 'bg-green-100 text-green-700',
  paused: 'bg-yellow-100 text-yellow-700',
  error: 'bg-red-100 text-red-700',
};

export default function Streams() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  usePageTitle(t('streams.title'));
  const sessionsQuery = useQuery({ queryKey: ['stream-sessions'], queryFn: streamSessionsApi.list });
  const playlistsQuery = useQuery({ queryKey: ['playlists'], queryFn: playlistsApi.list });
  const destinationsQuery = useQuery({ queryKey: ['destinations'], queryFn: destinationsApi.list });
  const [isDrawerOpen, setDrawerOpen] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  const playlistName = (id: string) => playlistsQuery.data?.find((p) => p.id === id)?.name ?? id;
  const destinationName = (id: string) => destinationsQuery.data?.find((d) => d.id === id)?.name ?? id;

  const deleteMutation = useMutation({
    mutationFn: (id: string) => streamSessionsApi.remove(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['stream-sessions'] });
      setConfirmingId(null);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('streams.stopFailed')),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{t('streams.title')}</h1>
        <button onClick={() => setDrawerOpen(true)} className="rounded bg-black px-4 py-2 text-white">{t('streams.start')}</button>
      </div>

      {sessionsQuery.isLoading ? (
        <p className="text-sm text-gray-500">{t('streams.loading')}</p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {sessionsQuery.data?.map((session) => (
            <li key={session.id} className="flex items-center justify-between gap-3 p-3">
              <Link to={`/streams/${session.id}`} className="flex-1">
                <div className="font-medium underline">{playlistName(session.playlistId)}</div>
                <div className="mt-1 flex flex-wrap gap-1">
                  {session.destinations.map((d) => (
                    <span key={d.destinationId} className={`rounded px-2 py-0.5 text-xs ${STATE_BADGE[d.status.state] ?? 'bg-gray-100 text-gray-600'}`}>
                      {destinationName(d.destinationId)}: {t(`streamState.${d.status.state}`)}
                    </span>
                  ))}
                </div>
              </Link>
              <button onClick={() => setConfirmingId(session.id)} className="text-sm text-red-600">{t('streams.stopAndRemove')}</button>
            </li>
          ))}
          {sessionsQuery.data?.length === 0 && <li className="p-3 text-sm text-gray-500">{t('streams.empty')}</li>}
        </ul>
      )}

      <StartStreamDrawer open={isDrawerOpen} onOpenChange={setDrawerOpen} />

      <ConfirmDialog
        open={confirmingId !== null}
        onOpenChange={(open) => !open && setConfirmingId(null)}
        title={t('streams.stopConfirmTitle')}
        description={t('streams.stopConfirmDescription')}
        confirmLabel={t('streams.stopAndRemove')}
        isPending={deleteMutation.isPending}
        onConfirm={() => confirmingId && deleteMutation.mutate(confirmingId)}
      />
    </div>
  );
}
