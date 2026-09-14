import { FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  localStreamApi, DestinationBroadcastMeta, ForwardDesiredState, LocalStreamStatus,
} from '../api/localStream';
import { streamPresetsApi } from '../api/streamPresets';
import { useLocalStreamStatus, LOCAL_STREAM_STATUS_QUERY_KEY } from '../hooks/useLocalStreamStatus';
import { playlistsApi } from '../api/playlists';
import { templatesApi } from '../api/templates';
import { destinationsApi } from '../api/destinations';
import { ApiError } from '../api/client';
import { HlsPlayer } from '../components/HlsPlayer';
import { DestinationToggles } from '../components/DestinationToggles';
import { usePageTitle } from '../hooks/usePageTitle';

/**
 * The one stream page. There is exactly one local stream per account, so there is no list, no id in
 * any URL and nothing to navigate between: you start it, you control it, you watch it, and you tick
 * destinations on and off underneath it without ever interrupting it.
 *
 * The destination checklist is ALWAYS driven by the real backend forward statuses, whether the
 * stream is running or not — a toggle is valid in every state (it parks at 'pending' while idle),
 * so there is no separate local-only "what I've ticked so far" state to keep in sync with it. Each
 * destination's own broadcast settings (title/privacy/latency) are collected by
 * DestinationToggles' own panel right at the moment of ticking it on — see that component — not on
 * this page, and not once for the whole session: start() itself takes only playlistId/templateId.
 */
export default function Stream() {
  const { t } = useTranslation();
  usePageTitle(t('stream.title'));
  const queryClient = useQueryClient();
  const statusQuery = useLocalStreamStatus();
  const playlistsQuery = useQuery({ queryKey: ['playlists'], queryFn: playlistsApi.list });
  const templatesQuery = useQuery({ queryKey: ['templates'], queryFn: templatesApi.list });
  const destinationsQuery = useQuery({ queryKey: ['destinations'], queryFn: destinationsApi.list });
  const presetsQuery = useQuery({ queryKey: ['stream-presets'], queryFn: streamPresetsApi.list });

  const [presetId, setPresetId] = useState('');
  const [presetName, setPresetName] = useState('');
  const [playlistId, setPlaylistId] = useState('');
  const [templateId, setTemplateId] = useState('');

  const status = statusQuery.data;
  const local = status?.local;
  // Three cases, not two. 'idle' and 'error' both mean "nothing is running" and show the start
  // form; 'starting' means a start is in flight, so show neither the form (it would offer to start
  // a second one) nor the transport controls (there is nothing to control yet).
  const isStarting = local?.state === 'starting';
  const isRunning = local !== undefined && local.state !== 'idle' && local.state !== 'error' && !isStarting;

  const destinations = destinationsQuery.data ?? [];
  const forwards = status?.destinations ?? [];

  const applyStatus = (next: LocalStreamStatus) => queryClient.setQueryData(LOCAL_STREAM_STATUS_QUERY_KEY, next);

  const startMutation = useMutation({
    mutationFn: () => localStreamApi.start({ playlistId, templateId: templateId || undefined }),
    onSuccess: applyStatus,
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('stream.startFailed')),
  });

  function useCommand(fn: () => Promise<LocalStreamStatus>) {
    return useMutation({
      mutationFn: fn,
      onSuccess: applyStatus,
      onError: (err) => toast.error(err instanceof ApiError ? err.message : t('stream.commandFailed')),
    });
  }

  const previousMutation = useCommand(localStreamApi.previous);
  const pauseMutation = useCommand(localStreamApi.pause);
  const resumeMutation = useCommand(localStreamApi.resume);
  const nextMutation = useCommand(localStreamApi.next);
  const stopMutation = useCommand(localStreamApi.stop);

  const toggleMutation = useMutation({
    mutationFn: ({ destinationId, desired, meta }: { destinationId: string; desired: ForwardDesiredState; meta?: DestinationBroadcastMeta }) =>
      localStreamApi.setDestination(destinationId, desired, meta),
    onSuccess: applyStatus,
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('stream.toggleFailed')),
  });

  // Applying a preset ticks every one of its saved destinations on, each with that SAME preset's
  // saved broadcast metadata (a preset only ever holds one shared copy, not a per-destination one —
  // unlike a manual toggle's own settings panel) — valid whether the stream is running or idle, for
  // the same reason a manual toggle is.
  const applyPresetMutation = useMutation({
    mutationFn: async (): Promise<LocalStreamStatus | undefined> => {
      const preset = presetsQuery.data?.find((p) => p.id === presetId);
      if (!preset) return undefined;
      setPlaylistId(preset.playlistId);
      setTemplateId(preset.templateId ?? '');
      const meta: DestinationBroadcastMeta = {
        title: preset.title ?? undefined,
        description: preset.description ?? undefined,
        privacyStatus: preset.privacyStatus ?? undefined,
        latencyPreference: preset.latencyPreference ?? undefined,
      };
      let result: LocalStreamStatus | undefined;
      for (const destinationId of preset.destinationIds) {
        result = await localStreamApi.setDestination(destinationId, 'on', meta);
      }
      return result;
    },
    onSuccess: (result) => { if (result) applyStatus(result); },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('stream.startFailed')),
  });

  // A saved preset can only remember ONE shared name/playlist/template/destination-list; it does
  // not attempt to capture each destination's own broadcast settings (those live on the toggle
  // panel, in the moment, and are gone once that moment passes) — so a preset saved here carries no
  // broadcast metadata of its own, only the currently-selected destinations to re-tick next time.
  const savePresetMutation = useMutation({
    mutationFn: () => streamPresetsApi.create({
      name: presetName.trim(),
      playlistId,
      templateId: templateId || null,
      destinationIds: forwards.filter((f) => f.desired === 'on').map((f) => f.destinationId),
    }),
    onSuccess: () => {
      setPresetName('');
      queryClient.invalidateQueries({ queryKey: ['stream-presets'] });
      toast.success(t('stream.presetSaved'));
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('stream.presetSaveFailed')),
  });

  function handleToggle(destinationId: string, desired: ForwardDesiredState, meta?: DestinationBroadcastMeta) {
    toggleMutation.mutate({ destinationId, desired, meta });
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!playlistId) return;
    startMutation.mutate();
  }

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{t('stream.title')}</h1>
        <p className="mt-1 text-sm text-gray-500">{t('stream.subtitle')}</p>
      </div>

      {/* Gated on !isStarting too, not just !isRunning: isRunning already excludes 'starting'
          (see its own comment above), but that only keeps the transport controls from rendering
          during a start — it does nothing to stop THIS form from also rendering and offering to
          start a second stream while the first one is still coming up. */}
      {!isRunning && !isStarting && (
        <form onSubmit={handleSubmit} className="space-y-4 rounded-lg border p-4">
          <div>
            <label htmlFor="stream-preset" className="block text-sm font-medium">{t('stream.presetLabel')}</label>
            <div className="mt-1 flex gap-2">
              <select
                id="stream-preset"
                className="flex-1 rounded border px-3 py-2"
                value={presetId}
                onChange={(e) => setPresetId(e.target.value)}
              >
                <option value="">{t('stream.noPreset')}</option>
                {presetsQuery.data?.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
              </select>
              <button
                type="button"
                onClick={() => applyPresetMutation.mutate()}
                disabled={!presetId || applyPresetMutation.isPending}
                className="rounded border px-3 py-2 disabled:opacity-50"
              >
                {t('stream.applyPreset')}
              </button>
            </div>
          </div>

          <div>
            <label htmlFor="stream-playlist" className="block text-sm font-medium">{t('stream.playlistLabel')}</label>
            <select
              id="stream-playlist"
              className="mt-1 w-full rounded border px-3 py-2"
              value={playlistId}
              onChange={(e) => setPlaylistId(e.target.value)}
              required
            >
              <option value="">{t('stream.selectPlaylist')}</option>
              {playlistsQuery.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>

          <div>
            <label htmlFor="stream-template" className="block text-sm font-medium">{t('stream.templateLabel')}</label>
            <select
              id="stream-template"
              className="mt-1 w-full rounded border px-3 py-2"
              value={templateId}
              onChange={(e) => setTemplateId(e.target.value)}
            >
              <option value="">{t('stream.noTemplate')}</option>
              {templatesQuery.data?.map((tpl) => <option key={tpl.id} value={tpl.id}>{tpl.name}</option>)}
            </select>
            <p className="mt-1 text-xs text-gray-500">
              <Link to="/templates" className="underline">{t('stream.manageTemplates')}</Link>
            </p>
          </div>

          <button
            type="submit"
            disabled={!playlistId || startMutation.isPending}
            className="w-full rounded bg-black px-4 py-2 text-white disabled:opacity-50"
          >
            {startMutation.isPending ? t('stream.starting') : t('stream.startButton')}
          </button>

          <div className="border-t pt-3">
            <div className="text-sm font-medium">{t('stream.savePresetTitle')}</div>
            <div className="mt-1 flex gap-2">
              <input
                className="flex-1 rounded border px-3 py-2"
                placeholder={t('stream.presetNamePlaceholder')}
                value={presetName}
                onChange={(e) => setPresetName(e.target.value)}
              />
              <button
                type="button"
                onClick={() => savePresetMutation.mutate()}
                disabled={!playlistId || presetName.trim().length === 0 || savePresetMutation.isPending}
                className="rounded border px-3 py-2 disabled:opacity-50"
              >
                {t('stream.savePreset')}
              </button>
            </div>
          </div>
        </form>
      )}

      {/* A start is in flight: neither a form that would start a second one, nor controls for
          something that is not running yet. */}
      {isStarting && (
        <p className="rounded-lg border p-4 text-sm text-gray-500">{t('streamState.starting')}</p>
      )}

      {isRunning && local && (
        <div className="rounded-lg border p-4">
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-600">
              {t('stream.nowPlayingNext', { track: local.currentTrack ?? '—', next: local.nextTrack ?? '—' })}
            </span>
            <span className="text-xs text-gray-500">{t(`streamState.${local.state}`)}</span>
          </div>
          {forwards.every((forward) => forward.desired === 'off') && (
            <p className="mt-2 text-xs text-gray-500">{t('stream.noDestinationsNotice')}</p>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <button onClick={() => previousMutation.mutate()} className="rounded border px-3 py-2">{t('stream.previous')}</button>
            {local.state === 'paused'
              ? <button onClick={() => resumeMutation.mutate()} className="rounded border px-3 py-2">{t('stream.resume')}</button>
              : <button onClick={() => pauseMutation.mutate()} className="rounded border px-3 py-2">{t('stream.pause')}</button>}
            <button onClick={() => nextMutation.mutate()} className="rounded border px-3 py-2">{t('stream.next')}</button>
            <button onClick={() => stopMutation.mutate()} className="rounded border px-3 py-2 text-red-600">{t('stream.stop')}</button>
          </div>
        </div>
      )}

      {/* Always visible: a destination can be ticked before the stream starts (it waits at
          'pending' with nothing happening on the platform) and toggled freely while it runs. */}
      <DestinationToggles
        destinations={destinations}
        forwards={forwards}
        onToggle={handleToggle}
        disabled={isStarting || toggleMutation.isPending}
      />

      {isRunning && local && (
        local.previewReady
          ? <HlsPlayer src={localStreamApi.previewUrl()} unsupportedMessage={t('stream.previewUnsupported')} />
          : <p className="rounded-lg border p-4 text-sm text-gray-500">{t('stream.previewStarting')}</p>
      )}
    </div>
  );
}
