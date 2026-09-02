import { FormEvent, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useStreamStatus } from '../hooks/useStreamStatus';
import { streamApi } from '../api/stream';
import { playlistsApi } from '../api/playlists';
import { ApiError } from '../api/client';

export default function DestinationPanel() {
  const { id } = useParams<{ id: string }>();
  const destinationId = id!;
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const statusQuery = useStreamStatus(destinationId);
  const playlistsQuery = useQuery({ queryKey: ['playlists'], queryFn: playlistsApi.list });
  const [selectedPlaylistId, setSelectedPlaylistId] = useState('');
  const [playName, setPlayName] = useState('');

  const phaseLabels: Record<string, string> = {
    creating: t('streamPhase.creating'),
    waitingForYoutube: t('streamPhase.waitingForYoutube'),
    live: t('streamPhase.live'),
    complete: t('streamPhase.complete'),
    error: t('streamPhase.error'),
  };

  function onStatusMutationSuccess(status: unknown) {
    queryClient.setQueryData(['stream-status', destinationId], status);
  }

  const startMutation = useMutation({
    mutationFn: () => streamApi.start(destinationId, { playlistId: selectedPlaylistId }),
    onSuccess: onStatusMutationSuccess,
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('destinationPanel.startFailed')),
  });
  const stopMutation = useMutation({
    mutationFn: () => streamApi.stop(destinationId),
    onSuccess: onStatusMutationSuccess,
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('destinationPanel.stopFailed')),
  });
  const pauseMutation = useMutation({
    mutationFn: () => streamApi.pause(destinationId),
    onSuccess: onStatusMutationSuccess,
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('destinationPanel.pauseFailed')),
  });
  const resumeMutation = useMutation({
    mutationFn: () => streamApi.resume(destinationId),
    onSuccess: onStatusMutationSuccess,
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('destinationPanel.resumeFailed')),
  });
  const nextMutation = useMutation({
    mutationFn: () => streamApi.next(destinationId),
    onSuccess: onStatusMutationSuccess,
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('destinationPanel.nextFailed')),
  });
  const previousMutation = useMutation({
    mutationFn: () => streamApi.previous(destinationId),
    onSuccess: onStatusMutationSuccess,
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('destinationPanel.previousFailed')),
  });
  const playMutation = useMutation({
    mutationFn: () => streamApi.playByName(destinationId, playName),
    onSuccess: (status) => { onStatusMutationSuccess(status); setPlayName(''); },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('destinationPanel.trackNotFound')),
  });

  function handlePlaySubmit(e: FormEvent) {
    e.preventDefault();
    if (playName.trim()) playMutation.mutate();
  }

  const status = statusQuery.data;
  const isIdle = !status || status.state === 'idle';

  return (
    <div className="max-w-xl space-y-4">
      <h1 className="text-2xl font-semibold">{t('destinationPanel.title')}</h1>

      {status?.provider && (
        <div className="rounded border bg-yellow-50 p-3 text-sm">
          {phaseLabels[status.provider.phase] ?? status.provider.phase}
          {status.provider.watchUrl && (
            <a href={status.provider.watchUrl} target="_blank" rel="noreferrer" className="ml-2 underline">
              {t('destinationPanel.watchOnYoutube')}
            </a>
          )}
        </div>
      )}

      <div className="rounded-lg border p-4">
        {isIdle ? (
          <div className="space-y-3">
            <select className="w-full rounded border px-3 py-2" value={selectedPlaylistId} onChange={(e) => setSelectedPlaylistId(e.target.value)}>
              <option value="">{t('destinationPanel.selectPlaylist')}</option>
              {playlistsQuery.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <button
              onClick={() => startMutation.mutate()}
              disabled={!selectedPlaylistId || startMutation.isPending}
              className="w-full rounded bg-black px-4 py-2 text-white disabled:opacity-50"
            >
              {startMutation.isPending ? t('destinationPanel.starting') : t('destinationPanel.start')}
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="text-xs text-gray-500">{t('destinationPanel.state', { state: status.state })}</div>
            <div className="font-medium">{t('destinationPanel.nowPlaying', { track: status.currentTrack ?? '—' })}</div>
            <div className="text-sm text-gray-500">{t('destinationPanel.next', { track: status.nextTrack ?? '—' })}</div>
            <div className="flex flex-wrap gap-2">
              <button onClick={() => previousMutation.mutate()} className="rounded border px-3 py-2">{t('destinationPanel.previous')}</button>
              {status.state === 'paused' ? (
                <button onClick={() => resumeMutation.mutate()} className="rounded border px-3 py-2">{t('destinationPanel.resume')}</button>
              ) : (
                <button onClick={() => pauseMutation.mutate()} className="rounded border px-3 py-2">{t('destinationPanel.pause')}</button>
              )}
              <button onClick={() => nextMutation.mutate()} className="rounded border px-3 py-2">{t('destinationPanel.nextTrack')}</button>
              <button onClick={() => stopMutation.mutate()} className="rounded border px-3 py-2 text-red-600">{t('destinationPanel.stop')}</button>
            </div>
            <form onSubmit={handlePlaySubmit} className="flex gap-2 pt-2">
              <input className="flex-1 rounded border px-3 py-2 text-sm" placeholder={t('destinationPanel.playPlaceholder')} value={playName} onChange={(e) => setPlayName(e.target.value)} />
              <button type="submit" className="rounded border px-3 py-2 text-sm">{t('destinationPanel.queue')}</button>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}
