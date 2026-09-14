import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Destination } from '../api/destinations';
import {
  DestinationBroadcastMeta, DestinationForwardStatus, ForwardActualState, ForwardDesiredState,
} from '../api/localStream';

const STATE_BADGE: Record<ForwardActualState, string> = {
  off: 'bg-gray-100 text-gray-600',
  pending: 'bg-blue-100 text-blue-700',
  preparing: 'bg-yellow-100 text-yellow-700',
  connecting: 'bg-yellow-100 text-yellow-700',
  live: 'bg-green-100 text-green-700',
  stopping: 'bg-orange-100 text-orange-700',
  error: 'bg-red-100 text-red-700',
};

// Providers whose broadcast has its own settings worth asking about before going live. A custom
// RTMP destination has no broadcast concept at all (CustomRtmpProvider ignores every one of these
// fields), so ticking it on skips the panel and toggles immediately.
const PROVIDERS_WITH_BROADCAST_META = new Set(['youtube']);

export interface DestinationTogglesProps {
  // Every destination the user owns — the checklist is over these, not over the forwards. A
  // destination with no forward entry is simply off: the backend prunes forwards that want nothing
  // and hold nothing, so absence IS the representation of "not forwarded".
  destinations: Destination[];
  forwards: DestinationForwardStatus[];
  // `meta` is only ever passed on a desired:'on' toggle that went through the settings panel below
  // — it is this ONE destination's own broadcast title/description/privacy/latency, applied right
  // at the moment it goes live (whether that "live" is immediate, because a stream is already
  // running, or deferred, because it isn't yet and the intent just waits at 'pending').
  onToggle: (destinationId: string, desired: ForwardDesiredState, meta?: DestinationBroadcastMeta) => void;
  disabled?: boolean;
}

export function DestinationToggles({ destinations, forwards, onToggle, disabled }: DestinationTogglesProps) {
  const { t } = useTranslation();
  const byId = new Map(forwards.map((forward) => [forward.destinationId, forward]));
  // Which destination's settings panel is open, if any — at most one at a time. Ticking a second
  // destination's box while a panel is open just switches the panel; nothing is lost, since nothing
  // is sent to the backend until that destination's own Confirm is pressed.
  const [openSettingsFor, setOpenSettingsFor] = useState<string | null>(null);
  const [draft, setDraft] = useState<Required<DestinationBroadcastMeta>>({
    title: '', description: '', privacyStatus: 'private', latencyPreference: 'normal',
  });

  const phaseLabels: Record<string, string> = {
    creating: t('streamPhase.creating'),
    waitingForYoutube: t('streamPhase.waitingForYoutube'),
    live: t('streamPhase.live'),
    complete: t('streamPhase.complete'),
    error: t('streamPhase.error'),
  };

  function handleCheckboxChange(destination: Destination, checked: boolean) {
    if (checked) {
      // Turning off never needs settings — just toggle.
      onToggle(destination.id, 'off');
      return;
    }
    if (!PROVIDERS_WITH_BROADCAST_META.has(destination.provider)) {
      onToggle(destination.id, 'on');
      return;
    }
    setDraft({ title: '', description: '', privacyStatus: 'private', latencyPreference: 'normal' });
    setOpenSettingsFor(destination.id);
  }

  function confirmSettings(destinationId: string) {
    onToggle(destinationId, 'on', {
      title: draft.title || undefined,
      description: draft.description || undefined,
      privacyStatus: draft.privacyStatus,
      latencyPreference: draft.latencyPreference,
    });
    setOpenSettingsFor(null);
  }

  return (
    <div className="rounded-lg border p-4">
      <div className="flex items-center justify-between">
        <h2 className="font-medium">{t('stream.destinationsTitle')}</h2>
        <Link to="/destinations" className="text-xs underline">{t('sidebar.destinations')}</Link>
      </div>
      <p className="mt-1 text-xs text-gray-500">{t('stream.destinationsHelp')}</p>

      {destinations.length === 0 ? (
        <p className="mt-3 text-sm text-gray-500">{t('stream.noDestinations')}</p>
      ) : (
        <ul className="mt-3 divide-y rounded border">
          {destinations.map((destination) => {
            const forward = byId.get(destination.id);
            const state: ForwardActualState = forward?.state ?? 'off';
            const checked = forward?.desired === 'on';
            return (
              <li key={destination.id} className="p-3">
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id={`forward-${destination.id}`}
                    checked={checked}
                    disabled={disabled}
                    onChange={() => handleCheckboxChange(destination, checked)}
                  />
                  {/* The provider name is deliberately OUTSIDE the <label>: it would otherwise be
                      part of the checkbox's accessible name ("My channel (youtube)"), which is both
                      noisier for a screen reader and a needless coupling for every test that finds
                      a destination by name. */}
                  <label htmlFor={`forward-${destination.id}`} className="flex-1 text-sm">{destination.name}</label>
                  <span className="text-xs text-gray-500">({destination.provider})</span>
                  <span className={`rounded px-2 py-0.5 text-xs ${STATE_BADGE[state]}`}>
                    {t(`forwardState.${state}`)}
                  </span>
                </div>

                {/* The settings panel: opened by handleCheckboxChange instead of toggling straight
                    away, for any provider with a broadcast concept (YouTube). Nothing is sent to the
                    backend until Confirm — Cancel (or ticking a different destination) discards the
                    draft and leaves this checkbox exactly as it was. */}
                {openSettingsFor === destination.id && (
                  <div className="mt-2 space-y-2 rounded border bg-gray-50 p-3">
                    <p className="text-xs text-gray-500">{t('stream.youtubeHelp')}</p>
                    <input
                      className="w-full rounded border px-2 py-1 text-sm"
                      placeholder={t('stream.titlePlaceholder')}
                      value={draft.title}
                      onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
                    />
                    <textarea
                      className="w-full rounded border px-2 py-1 text-sm"
                      placeholder={t('stream.descriptionPlaceholder')}
                      value={draft.description}
                      onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
                    />
                    <div>
                      <label htmlFor={`privacy-${destination.id}`} className="block text-xs font-medium">{t('stream.privacyLabel')}</label>
                      <select
                        id={`privacy-${destination.id}`}
                        className="mt-1 w-full rounded border px-2 py-1 text-sm"
                        value={draft.privacyStatus}
                        onChange={(e) => setDraft((d) => ({ ...d, privacyStatus: e.target.value as 'public' | 'unlisted' | 'private' }))}
                      >
                        <option value="private">{t('stream.private')}</option>
                        <option value="unlisted">{t('stream.unlisted')}</option>
                        <option value="public">{t('stream.public')}</option>
                      </select>
                    </div>
                    <div>
                      <label htmlFor={`latency-${destination.id}`} className="block text-xs font-medium">{t('stream.latencyLabel')}</label>
                      <select
                        id={`latency-${destination.id}`}
                        className="mt-1 w-full rounded border px-2 py-1 text-sm"
                        value={draft.latencyPreference}
                        onChange={(e) => setDraft((d) => ({ ...d, latencyPreference: e.target.value as 'normal' | 'low' | 'ultraLow' }))}
                      >
                        <option value="normal">{t('stream.latencyNormal')}</option>
                        <option value="low">{t('stream.latencyLow')}</option>
                        <option value="ultraLow">{t('stream.latencyUltraLow')}</option>
                      </select>
                      <p className="mt-1 text-xs text-gray-500">{t('stream.latencyHelp')}</p>
                    </div>
                    <div className="flex gap-2 pt-1">
                      <button
                        type="button"
                        onClick={() => confirmSettings(destination.id)}
                        className="rounded bg-black px-3 py-1 text-xs text-white"
                      >
                        {t('stream.confirmAndGoLive')}
                      </button>
                      <button
                        type="button"
                        onClick={() => setOpenSettingsFor(null)}
                        className="rounded border px-3 py-1 text-xs"
                      >
                        {t('stream.cancel')}
                      </button>
                    </div>
                  </div>
                )}

                {/* Toggling on is not instant: a platform needs 10-40s to create the broadcast,
                    detect the ingest and transition to live. Saying so is what stops people
                    double-toggling and burning ~330 API quota units per cycle. */}
                {(state === 'preparing' || state === 'connecting') && (
                  <p className="mt-1 text-xs text-gray-500">{t('stream.connectingHelp')}</p>
                )}

                {/* The spec requires the YouTube consequences to be visible in the UI copy, not just
                    in a design doc: each toggle-on is a brand-new broadcast, so the chat, the
                    concurrent-viewer count and the likes all reset, and each toggle-off leaves
                    another archived VOD on the channel. */}
                {destination.provider === 'youtube' && checked && (
                  <p className="mt-1 text-xs text-gray-500">{t('stream.youtubeToggleWarning')}</p>
                )}

                {forward?.provider && (
                  <div className="mt-1 text-xs text-gray-600">
                    {phaseLabels[forward.provider.phase] ?? forward.provider.phase}
                    {forward.provider.watchUrl && (
                      <a href={forward.provider.watchUrl} target="_blank" rel="noreferrer" className="ml-2 underline">
                        {t('stream.watchLink')}
                      </a>
                    )}
                  </div>
                )}

                {forward?.error && <p className="mt-1 text-xs text-red-600">{forward.error.message}</p>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
