import { FormEvent, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  localStreamApi, DestinationForwardStatus, ForwardDesiredState, LocalStreamStatus,
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
  // While nothing is running the checklist is LOCAL state — ticking a box then has no backend
  // meaning yet and must not cost a round-trip. Once the stream is running the same checklist is
  // driven by the real forward statuses instead (see `forwards` below).
  const [selectedDestinationIds, setSelectedDestinationIds] = useState<string[]>([]);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [privacyStatus, setPrivacyStatus] = useState<'public' | 'unlisted' | 'private'>('private');
  const [latencyPreference, setLatencyPreference] = useState<'normal' | 'low' | 'ultraLow'>('normal');

  const status = statusQuery.data;
  const local = status?.local;
  // Three cases, not two. 'idle' and 'error' both mean "nothing is running" and show the start
  // form; 'starting' means a start is in flight, so show neither the form (it would offer to start
  // a second one) nor the transport controls (there is nothing to control yet).
  const isStarting = local?.state === 'starting';
  const isRunning = local !== undefined && local.state !== 'idle' && local.state !== 'error' && !isStarting;
  // Once anything is happening server-side, the checklist reflects real forward statuses; before
  // that it is local form state.
  const usesBackendForwards = isRunning || isStarting;

  const destinations = destinationsQuery.data ?? [];
  // Before the stream runs, synthesise the same shape DestinationToggles reads from real forwards:
  // ticked destinations are exactly "pending" — wanted, with nothing having happened on any
  // platform yet, which is precisely what the backend would report for them.
  const forwards: DestinationForwardStatus[] = usesBackendForwards
    ? status!.destinations
    : selectedDestinationIds.map((destinationId) => ({
      destinationId,
      name: destinations.find((d) => d.id === destinationId)?.name ?? destinationId,
      desired: 'on',
      state: 'pending',
    }));

  const selectedIds = usesBackendForwards
    ? forwards.filter((forward) => forward.desired === 'on').map((forward) => forward.destinationId)
    : selectedDestinationIds;
  const hasYoutubeSelected = destinations.some((d) => d.provider === 'youtube' && selectedIds.includes(d.id));

  // `selectedDestinationIds` only matters while idle (see its own comment above), but nothing kept
  // it in sync with destinations toggled ON mid-stream — a user who checked a box while running
  // would see it silently vanish from the checklist the moment the stream stopped, since the local
  // state variable was never written to during the run at all. `lastBackendSelectedIds` mirrors the
  // backend-derived `selectedIds` on every render WHILE running — captured in a ref, not read at
  // the moment of the transition, because by the render where `usesBackendForwards` has already
  // flipped to false, `selectedIds` has ALREADY switched its own source back to the (still-stale)
  // `selectedDestinationIds`; there is no later point at which the backend-derived value is still
  // reachable through `selectedIds` itself.
  const lastBackendSelectedIds = useRef<string[]>([]);
  if (usesBackendForwards) lastBackendSelectedIds.current = selectedIds;
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !usesBackendForwards) setSelectedDestinationIds(lastBackendSelectedIds.current);
    wasRunning.current = usesBackendForwards;
  }, [usesBackendForwards]);

  const applyStatus = (next: LocalStreamStatus) => queryClient.setQueryData(LOCAL_STREAM_STATUS_QUERY_KEY, next);

  const startMutation = useMutation({
    mutationFn: () => localStreamApi.start({
      playlistId,
      templateId: templateId || undefined,
      destinationIds: selectedDestinationIds,
      title: title || undefined,
      description: description || undefined,
      privacyStatus: hasYoutubeSelected ? privacyStatus : undefined,
      latencyPreference: hasYoutubeSelected ? latencyPreference : undefined,
    }),
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
    mutationFn: ({ destinationId, desired }: { destinationId: string; desired: ForwardDesiredState }) =>
      localStreamApi.setDestination(destinationId, desired),
    onSuccess: applyStatus,
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('stream.toggleFailed')),
  });

  const savePresetMutation = useMutation({
    mutationFn: () => streamPresetsApi.create({
      name: presetName.trim(),
      playlistId,
      templateId: templateId || null,
      destinationIds: selectedDestinationIds,
      title: title || null,
      description: description || null,
      privacyStatus: hasYoutubeSelected ? privacyStatus : null,
      latencyPreference: hasYoutubeSelected ? latencyPreference : null,
    }),
    onSuccess: () => {
      setPresetName('');
      queryClient.invalidateQueries({ queryKey: ['stream-presets'] });
      toast.success(t('stream.presetSaved'));
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('stream.presetSaveFailed')),
  });

  function handleToggle(destinationId: string, desired: ForwardDesiredState) {
    if (usesBackendForwards) {
      toggleMutation.mutate({ destinationId, desired });
      return;
    }
    setSelectedDestinationIds((current) => (desired === 'on'
      ? [...current, destinationId]
      : current.filter((id) => id !== destinationId)));
  }

  function applyPreset() {
    const preset = presetsQuery.data?.find((p) => p.id === presetId);
    if (!preset) return;
    setPlaylistId(preset.playlistId);
    setTemplateId(preset.templateId ?? '');
    setSelectedDestinationIds(preset.destinationIds);
    setTitle(preset.title ?? '');
    setDescription(preset.description ?? '');
    setPrivacyStatus(preset.privacyStatus ?? 'private');
    setLatencyPreference(preset.latencyPreference ?? 'normal');
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
              <button type="button" onClick={applyPreset} disabled={!presetId} className="rounded border px-3 py-2 disabled:opacity-50">
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

          {hasYoutubeSelected && (
            <div className="space-y-3 rounded border p-3">
              <p className="text-xs text-gray-500">{t('stream.youtubeHelp')}</p>
              <input className="w-full rounded border px-3 py-2" placeholder={t('stream.titlePlaceholder')} value={title} onChange={(e) => setTitle(e.target.value)} />
              <textarea className="w-full rounded border px-3 py-2" placeholder={t('stream.descriptionPlaceholder')} value={description} onChange={(e) => setDescription(e.target.value)} />
              <div>
                <label htmlFor="stream-privacy" className="block text-sm font-medium">{t('stream.privacyLabel')}</label>
                <select
                  id="stream-privacy"
                  className="mt-1 w-full rounded border px-3 py-2"
                  value={privacyStatus}
                  onChange={(e) => setPrivacyStatus(e.target.value as 'public' | 'unlisted' | 'private')}
                >
                  <option value="private">{t('stream.private')}</option>
                  <option value="unlisted">{t('stream.unlisted')}</option>
                  <option value="public">{t('stream.public')}</option>
                </select>
              </div>
              <div>
                <label htmlFor="stream-latency" className="block text-sm font-medium">{t('stream.latencyLabel')}</label>
                <select
                  id="stream-latency"
                  className="mt-1 w-full rounded border px-3 py-2"
                  value={latencyPreference}
                  onChange={(e) => setLatencyPreference(e.target.value as 'normal' | 'low' | 'ultraLow')}
                >
                  <option value="normal">{t('stream.latencyNormal')}</option>
                  <option value="low">{t('stream.latencyLow')}</option>
                  <option value="ultraLow">{t('stream.latencyUltraLow')}</option>
                </select>
                <p className="mt-1 text-xs text-gray-500">{t('stream.latencyHelp')}</p>
              </div>
            </div>
          )}

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
          {status!.destinations.every((forward) => forward.desired === 'off') && (
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
        // Also disabled mid-toggle, not just mid-start: the backend now correctly reuses a
        // settling forward (see DestinationForward.isInactive()'s comment) rather than racing a
        // second prepareSession(), but a user firing several toggles on the SAME destination
        // before any of them round-trip still has no reason to — one toggle in flight per
        // checklist render is plenty.
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
