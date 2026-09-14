import { FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  localStreamApi, DestinationBroadcastMeta, ForwardDesiredState, LocalStreamStatus,
} from '../api/localStream';
import { streamPresetsApi } from '../api/streamPresets';
import { Destination, destinationsApi } from '../api/destinations';
import { useLocalStreamStatus, LOCAL_STREAM_STATUS_QUERY_KEY } from '../hooks/useLocalStreamStatus';
import { playlistsApi } from '../api/playlists';
import { templatesApi } from '../api/templates';
import { ApiError } from '../api/client';
import { HlsPlayer } from '../components/HlsPlayer';
import { DestinationToggles } from '../components/DestinationToggles';
import { DestinationSettingsDrawer } from '../components/DestinationSettingsDrawer';
import { usePageTitle } from '../hooks/usePageTitle';

// Providers whose broadcast has its own settings worth asking about before going live. A custom
// RTMP destination has no broadcast concept at all (CustomRtmpProvider ignores every one of these
// fields), so turning it on never needs the settings drawer.
const PROVIDERS_WITH_BROADCAST_META = new Set(['youtube']);

// Thrown when the settings drawer is dismissed without confirming — a deliberate change of mind,
// not a failure, so it must never surface as an error toast.
class CommitCancelled extends Error {}

function sameIds(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

/**
 * The one stream page. There is exactly one local stream per account, so there is no list, no id in
 * any URL and nothing to navigate between: you start it, you control it, you watch it, and you tick
 * destinations on and off underneath it without ever interrupting it.
 *
 * The checklist is deliberately TWO-STEP: ticking a box only ever records local intent — it never
 * calls the backend and never asks for that destination's settings. Settings (and the actual
 * on/off calls) are collected only once the user commits — pressing "Start stream", or "Apply
 * changes" once something is already running — via DestinationSettingsDrawer, one section per
 * newly-turned-on destination that actually has a broadcast to configure. This holds identically
 * whether the stream is idle or already running: the same local intent, the same commit step.
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
  const [isCommitting, setIsCommitting] = useState(false);

  // null = "mirrors the backend" (no local edits pending). Set the instant the user ticks a box,
  // whether idle or running — turning something on or off is ALWAYS just intent until committed.
  const [intendedOnIds, setIntendedOnIds] = useState<Set<string> | null>(null);
  // Metadata already known for a destination about to turn on WITHOUT asking again at commit time
  // — populated only by applying a saved preset (its one shared title/privacy/latency for every
  // destination it lists). A manual tick always goes through the drawer instead.
  const [presetMeta, setPresetMeta] = useState<Record<string, DestinationBroadcastMeta>>({});
  // Drives the settings drawer: which destinations it's asking about, and what to do with the
  // answer. Non-null exactly while the drawer is open. `onCancel` fires when the drawer is
  // dismissed (Escape, the ✕, an overlay click) WITHOUT confirming — without it the commit's own
  // Promise would simply hang forever and `isCommitting` would stay stuck true.
  const [pendingSettings, setPendingSettings] = useState<{
    destinations: Destination[];
    onConfirm: (metaById: Record<string, DestinationBroadcastMeta>) => void;
    onCancel: () => void;
  } | null>(null);

  const status = statusQuery.data;
  const local = status?.local;
  // Three cases, not two. 'idle' and 'error' both mean "nothing is running" and show the start
  // form; 'starting' means a start is in flight, so show neither the form (it would offer to start
  // a second one) nor the transport controls (there is nothing to control yet).
  const isStarting = local?.state === 'starting';
  const isRunning = local !== undefined && local.state !== 'idle' && local.state !== 'error' && !isStarting;

  const destinations = destinationsQuery.data ?? [];
  const backendForwards = status?.destinations ?? [];
  const backendOnIds = new Set(backendForwards.filter((f) => f.desired === 'on').map((f) => f.destinationId));
  const displayOnIds = intendedOnIds ?? backendOnIds;
  const hasPendingChanges = intendedOnIds !== null && !sameIds(intendedOnIds, backendOnIds);

  // What the checklist actually shows: real forward state (phase, error, provider info) wherever
  // the backend already has an entry, with `desired` overridden to reflect local intent; a
  // destination the user has only ticked locally (no backend entry yet) gets a synthesized
  // 'pending' row — exactly what the backend would report for it once committed.
  const byId = new Map(backendForwards.map((f) => [f.destinationId, f]));
  const displayForwards = destinations
    .map((d) => {
      const backend = byId.get(d.id);
      const desired: ForwardDesiredState = displayOnIds.has(d.id) ? 'on' : 'off';
      if (backend) return { ...backend, desired };
      if (desired === 'on') return { destinationId: d.id, name: d.name, desired: 'on' as const, state: 'pending' as const };
      return null;
    })
    .filter((f): f is NonNullable<typeof f> => f !== null);

  const applyStatus = (next: LocalStreamStatus) => queryClient.setQueryData(LOCAL_STREAM_STATUS_QUERY_KEY, next);

  function handleToggle(destinationId: string, desired: ForwardDesiredState) {
    setIntendedOnIds((current) => {
      const next = new Set(current ?? backendOnIds);
      if (desired === 'on') next.add(destinationId); else next.delete(destinationId);
      return next;
    });
    // A manual re-tick must never silently reuse a stale preset-supplied setting.
    setPresetMeta((current) => {
      if (!(destinationId in current)) return current;
      const rest = { ...current };
      delete rest[destinationId];
      return rest;
    });
  }

  // The commit step: reconciles local intent against the backend. Anything newly turned off is
  // switched off immediately (no settings to ask about); anything newly turned on with settings
  // already known (from a preset) is switched on immediately too; anything else newly turned on
  // that actually has a broadcast to configure opens the settings drawer FIRST and waits for it.
  // `after` (starting the stream itself) runs only once every toggle has landed.
  function commitDestinationChanges(after?: () => Promise<void>): Promise<void> {
    const wantOnIds = intendedOnIds ?? backendOnIds;
    const toTurnOff = [...backendOnIds].filter((id) => !wantOnIds.has(id));
    const toTurnOnDestinations = [...wantOnIds]
      .filter((id) => !backendOnIds.has(id))
      .map((id) => destinations.find((d) => d.id === id))
      .filter((d): d is Destination => d !== undefined);
    const needsSettings = toTurnOnDestinations.filter((d) => PROVIDERS_WITH_BROADCAST_META.has(d.provider) && !presetMeta[d.id]);
    const readyIds = toTurnOnDestinations.filter((d) => !needsSettings.includes(d)).map((d) => d.id);

    async function applyAll(extraMeta: Record<string, DestinationBroadcastMeta>) {
      for (const id of toTurnOff) applyStatus(await localStreamApi.setDestination(id, 'off'));
      for (const id of readyIds) applyStatus(await localStreamApi.setDestination(id, 'on', presetMeta[id]));
      for (const destination of needsSettings) {
        applyStatus(await localStreamApi.setDestination(destination.id, 'on', extraMeta[destination.id]));
      }
      setIntendedOnIds(null);
      setPresetMeta({});
      if (after) await after();
    }

    if (needsSettings.length === 0) return applyAll({});
    return new Promise<void>((resolve, reject) => {
      setPendingSettings({
        destinations: needsSettings,
        onConfirm: (metaById) => {
          setPendingSettings(null);
          applyAll(metaById).then(resolve, reject);
        },
        onCancel: () => {
          setPendingSettings(null);
          reject(new CommitCancelled());
        },
      });
    });
  }

  async function handleApply() {
    setIsCommitting(true);
    try {
      await commitDestinationChanges();
    } catch (err) {
      if (!(err instanceof CommitCancelled)) toast.error(err instanceof ApiError ? err.message : t('stream.toggleFailed'));
    } finally {
      setIsCommitting(false);
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!playlistId) return;
    setIsCommitting(true);
    try {
      await commitDestinationChanges(async () => {
        applyStatus(await localStreamApi.start({ playlistId, templateId: templateId || undefined }));
      });
    } catch (err) {
      if (!(err instanceof CommitCancelled)) toast.error(err instanceof ApiError ? err.message : t('stream.startFailed'));
    } finally {
      setIsCommitting(false);
    }
  }

  async function useSimpleCommand(fn: () => Promise<LocalStreamStatus>, failedKey: string) {
    try {
      applyStatus(await fn());
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t(failedKey));
    }
  }

  // Applying a preset never touches the network by itself — it only sets local intent (playlist,
  // template, which destinations, and their shared saved settings), exactly like a manual tick
  // does. Nothing actually happens until Start/Apply commits it, same as everywhere else here.
  function applyPreset() {
    const preset = presetsQuery.data?.find((p) => p.id === presetId);
    if (!preset) return;
    setPlaylistId(preset.playlistId);
    setTemplateId(preset.templateId ?? '');
    setIntendedOnIds(new Set(preset.destinationIds));
    const meta: DestinationBroadcastMeta = {
      title: preset.title ?? undefined,
      description: preset.description ?? undefined,
      privacyStatus: preset.privacyStatus ?? undefined,
      latencyPreference: preset.latencyPreference ?? undefined,
    };
    setPresetMeta(Object.fromEntries(preset.destinationIds.map((id) => [id, meta])));
  }

  const [isSavingPreset, setIsSavingPreset] = useState(false);
  // A saved preset can only remember ONE shared name/playlist/template/destination-list; it does
  // not attempt to capture each destination's own broadcast settings (those live and die with the
  // commit step that chose them) — so a preset saved here carries no broadcast metadata of its own.
  async function saveCurrentAsPreset() {
    setIsSavingPreset(true);
    try {
      await streamPresetsApi.create({
        name: presetName.trim(),
        playlistId,
        templateId: templateId || null,
        destinationIds: [...displayOnIds],
      });
      setPresetName('');
      queryClient.invalidateQueries({ queryKey: ['stream-presets'] });
      toast.success(t('stream.presetSaved'));
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t('stream.presetSaveFailed'));
    } finally {
      setIsSavingPreset(false);
    }
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

          <button
            type="submit"
            disabled={!playlistId || isCommitting}
            className="w-full rounded bg-black px-4 py-2 text-white disabled:opacity-50"
          >
            {isCommitting ? t('stream.starting') : t('stream.startButton')}
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
                onClick={saveCurrentAsPreset}
                disabled={!playlistId || presetName.trim().length === 0 || isSavingPreset}
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
          {backendForwards.every((forward) => forward.desired === 'off') && (
            <p className="mt-2 text-xs text-gray-500">{t('stream.noDestinationsNotice')}</p>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <button onClick={() => useSimpleCommand(localStreamApi.previous, 'stream.commandFailed')} className="rounded border px-3 py-2">{t('stream.previous')}</button>
            {local.state === 'paused'
              ? <button onClick={() => useSimpleCommand(localStreamApi.resume, 'stream.commandFailed')} className="rounded border px-3 py-2">{t('stream.resume')}</button>
              : <button onClick={() => useSimpleCommand(localStreamApi.pause, 'stream.commandFailed')} className="rounded border px-3 py-2">{t('stream.pause')}</button>}
            <button onClick={() => useSimpleCommand(localStreamApi.next, 'stream.commandFailed')} className="rounded border px-3 py-2">{t('stream.next')}</button>
            <button onClick={() => useSimpleCommand(localStreamApi.stop, 'stream.commandFailed')} className="rounded border px-3 py-2 text-red-600">{t('stream.stop')}</button>
          </div>
        </div>
      )}

      {/* Always visible: a destination can be ticked before the stream starts (it waits at
          'pending' with nothing happening on the platform) and toggled freely while it runs. Ticking
          it is only ever local intent, though — nothing reaches the backend until Start/Apply. */}
      <DestinationToggles
        destinations={destinations}
        forwards={displayForwards}
        onToggle={handleToggle}
        disabled={isStarting || isCommitting}
      />

      {/* Mid-stream commit step: only appears once local intent actually diverges from what's
          really running, since the checklist above is otherwise just showing backend truth. */}
      {isRunning && hasPendingChanges && (
        <button
          onClick={handleApply}
          disabled={isCommitting}
          className="w-full rounded bg-black px-4 py-2 text-white disabled:opacity-50"
        >
          {isCommitting ? t('stream.starting') : t('stream.applyChanges')}
        </button>
      )}

      {isRunning && local && (
        local.previewReady
          ? <HlsPlayer src={localStreamApi.previewUrl()} unsupportedMessage={t('stream.previewUnsupported')} />
          : <p className="rounded-lg border p-4 text-sm text-gray-500">{t('stream.previewStarting')}</p>
      )}

      <DestinationSettingsDrawer
        open={pendingSettings !== null}
        onOpenChange={(open) => { if (!open) pendingSettings?.onCancel(); }}
        destinations={pendingSettings?.destinations ?? []}
        onConfirm={(metaById) => pendingSettings?.onConfirm(metaById)}
      />
    </div>
  );
}
