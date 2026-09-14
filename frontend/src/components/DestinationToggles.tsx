import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Destination } from '../api/destinations';
import { DestinationForwardStatus, ForwardActualState, ForwardDesiredState } from '../api/localStream';

const STATE_BADGE: Record<ForwardActualState, string> = {
  off: 'bg-gray-100 text-gray-600',
  pending: 'bg-blue-100 text-blue-700',
  preparing: 'bg-yellow-100 text-yellow-700',
  connecting: 'bg-yellow-100 text-yellow-700',
  live: 'bg-green-100 text-green-700',
  stopping: 'bg-orange-100 text-orange-700',
  error: 'bg-red-100 text-red-700',
};

export interface DestinationTogglesProps {
  // Every destination the user owns — the checklist is over these, not over the forwards. A
  // destination with no forward entry is simply off: the backend prunes forwards that want nothing
  // and hold nothing, so absence IS the representation of "not forwarded".
  destinations: Destination[];
  // Purely a DISPLAY of desired/actual state — the caller decides what that state means (real
  // backend truth, or the user's own not-yet-committed local intent while editing the checklist).
  forwards: DestinationForwardStatus[];
  // Ticking a box only ever records intent here — this component never decides whether that intent
  // is applied immediately or held for a later commit (see Stream.tsx and
  // DestinationSettingsDrawer, where a destination's own broadcast settings are actually collected,
  // right when the user commits to going live — never on this click).
  onToggle: (destinationId: string, desired: ForwardDesiredState) => void;
  disabled?: boolean;
}

export function DestinationToggles({ destinations, forwards, onToggle, disabled }: DestinationTogglesProps) {
  const { t } = useTranslation();
  const byId = new Map(forwards.map((forward) => [forward.destinationId, forward]));

  const phaseLabels: Record<string, string> = {
    creating: t('streamPhase.creating'),
    waitingForYoutube: t('streamPhase.waitingForYoutube'),
    live: t('streamPhase.live'),
    complete: t('streamPhase.complete'),
    error: t('streamPhase.error'),
  };

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
                    onChange={() => onToggle(destination.id, checked ? 'off' : 'on')}
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
