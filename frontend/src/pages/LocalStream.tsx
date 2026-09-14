import { FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { localStreamApi, LocalStreamStatus } from '../api/localStream';
import { useLocalStreamStatus, LOCAL_STREAM_STATUS_QUERY_KEY } from '../hooks/useLocalStreamStatus';
import { playlistsApi } from '../api/playlists';
import { templatesApi } from '../api/templates';
import { ApiError } from '../api/client';
import { HlsPlayer } from '../components/HlsPlayer';
import { usePageTitle } from '../hooks/usePageTitle';

export default function LocalStream() {
  const { t } = useTranslation();
  usePageTitle(t('localStream.title'));
  const queryClient = useQueryClient();
  const statusQuery = useLocalStreamStatus();
  const playlistsQuery = useQuery({ queryKey: ['playlists'], queryFn: playlistsApi.list });
  const templatesQuery = useQuery({ queryKey: ['templates'], queryFn: templatesApi.list });

  const [playlistId, setPlaylistId] = useState('');
  const [templateId, setTemplateId] = useState('');

  // Every command returns the fresh status, so seed the cache from it directly rather than
  // refetching — the SSE stream will keep it current from there.
  const applyStatus = (status: LocalStreamStatus) => queryClient.setQueryData(LOCAL_STREAM_STATUS_QUERY_KEY, status);

  const startMutation = useMutation({
    mutationFn: () => localStreamApi.start({ playlistId, templateId: templateId || undefined }),
    onSuccess: applyStatus,
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('localStream.startFailed')),
  });

  function useCommand(fn: () => Promise<LocalStreamStatus>) {
    return useMutation({
      mutationFn: fn,
      onSuccess: applyStatus,
      onError: (err) => toast.error(err instanceof ApiError ? err.message : t('localStream.commandFailed')),
    });
  }

  const previousMutation = useCommand(localStreamApi.previous);
  const pauseMutation = useCommand(localStreamApi.pause);
  const resumeMutation = useCommand(localStreamApi.resume);
  const nextMutation = useCommand(localStreamApi.next);
  const stopMutation = useCommand(localStreamApi.stop);

  const status = statusQuery.data;
  // 'idle' and 'error' both mean "nothing is running" from the user's point of view — both should
  // show the start form rather than dead transport controls.
  const isRunning = status !== undefined && status.state !== 'idle' && status.state !== 'error';

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!playlistId) return;
    startMutation.mutate();
  }

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{t('localStream.title')}</h1>
        <p className="mt-1 text-sm text-gray-500">{t('localStream.subtitle')}</p>
      </div>

      {!isRunning && (
        <form onSubmit={handleSubmit} className="space-y-4 rounded-lg border p-4">
          <div>
            <label htmlFor="local-playlist" className="block text-sm font-medium">{t('localStream.playlistLabel')}</label>
            <select
              id="local-playlist"
              className="mt-1 w-full rounded border px-3 py-2"
              value={playlistId}
              onChange={(e) => setPlaylistId(e.target.value)}
              required
            >
              <option value="">{t('localStream.selectPlaylist')}</option>
              {playlistsQuery.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>

          <div>
            <label htmlFor="local-template" className="block text-sm font-medium">{t('localStream.templateLabel')}</label>
            <select
              id="local-template"
              className="mt-1 w-full rounded border px-3 py-2"
              value={templateId}
              onChange={(e) => setTemplateId(e.target.value)}
            >
              <option value="">{t('localStream.noTemplate')}</option>
              {templatesQuery.data?.map((tpl) => <option key={tpl.id} value={tpl.id}>{tpl.name}</option>)}
            </select>
            <p className="mt-1 text-xs text-gray-500">
              <Link to="/templates" className="underline">{t('startStreamDrawer.manageTemplates')}</Link>
            </p>
          </div>

          <button
            type="submit"
            disabled={!playlistId || startMutation.isPending}
            className="w-full rounded bg-black px-4 py-2 text-white disabled:opacity-50"
          >
            {startMutation.isPending ? t('localStream.starting') : t('localStream.startButton')}
          </button>
        </form>
      )}

      {isRunning && status && (
        <>
          <div className="rounded-lg border p-4">
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-600">
                {t('localStream.nowPlayingNext', { track: status.currentTrack ?? '—', next: status.nextTrack ?? '—' })}
              </span>
              <span className="text-xs text-gray-500">{t(`streamState.${status.state}`)}</span>
            </div>
            {/* Zero destinations is a normal, fully valid running state in this model — say so
                rather than letting the page read as if something failed to connect. */}
            <p className="mt-2 text-xs text-gray-500">{t('localStream.localOnlyNotice')}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button onClick={() => previousMutation.mutate()} className="rounded border px-3 py-2">{t('localStream.previous')}</button>
              {status.state === 'paused'
                ? <button onClick={() => resumeMutation.mutate()} className="rounded border px-3 py-2">{t('localStream.resume')}</button>
                : <button onClick={() => pauseMutation.mutate()} className="rounded border px-3 py-2">{t('localStream.pause')}</button>}
              <button onClick={() => nextMutation.mutate()} className="rounded border px-3 py-2">{t('localStream.next')}</button>
              <button onClick={() => stopMutation.mutate()} className="rounded border px-3 py-2 text-red-600">{t('localStream.stop')}</button>
            </div>
          </div>

          {/* previewReady only means the encoder has started (see localStreamManager.ts's
              previewTarget()) — MediaMTX's on-demand HLS muxer still takes a few seconds to cut a
              first segment after that, and HlsPlayer's own network-error retry (not this gate) is what
              carries the player through that window. Mounting only once previewReady is true just
              avoids rendering <HlsPlayer> with no active stream to point it at. */}
          {status.previewReady
            ? <HlsPlayer src={localStreamApi.previewUrl()} unsupportedMessage={t('localStream.previewUnsupported')} />
            : <p className="rounded-lg border p-4 text-sm text-gray-500">{t('localStream.previewStarting')}</p>}
        </>
      )}
    </div>
  );
}
