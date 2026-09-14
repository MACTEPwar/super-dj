import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Destination } from '../api/destinations';
import { DestinationBroadcastMeta } from '../api/localStream';
import { Drawer } from './Drawer';

type Draft = Required<DestinationBroadcastMeta>;

const BLANK_DRAFT: Draft = { title: '', description: '', privacyStatus: 'private', latencyPreference: 'normal' };

export interface DestinationSettingsDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // Only the destinations that actually need asking about — the caller (Stream.tsx) has already
  // filtered out anything with no broadcast concept (custom RTMP) or with metadata supplied some
  // other way (a saved preset). Confirming fires ONE onConfirm call with every destination's own
  // draft, keyed by id, rather than a settings round-trip per destination.
  destinations: Destination[];
  onConfirm: (metaById: Record<string, DestinationBroadcastMeta>) => void;
}

/**
 * The commit-time settings step: shown only once the user has actually confirmed they want to go
 * live — pressing "Start stream", or "Apply changes" mid-stream — never on the checkbox click
 * itself, which only ever records local intent. One section per pending destination, since each
 * needs its own title/description/privacy/latency, not a session-wide default.
 */
export function DestinationSettingsDrawer({ open, onOpenChange, destinations, onConfirm }: DestinationSettingsDrawerProps) {
  const { t } = useTranslation();
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});

  // Reset to blank drafts every time the drawer opens for a (possibly new) set of destinations —
  // stale input from a previous open must never leak into a different destination's settings.
  useEffect(() => {
    if (!open) return;
    setDrafts(Object.fromEntries(destinations.map((d) => [d.id, { ...BLANK_DRAFT }])));
  }, [open, destinations]);

  function setField<K extends keyof Draft>(destinationId: string, field: K, value: Draft[K]) {
    setDrafts((current) => ({ ...current, [destinationId]: { ...current[destinationId], [field]: value } }));
  }

  function handleConfirm() {
    const metaById: Record<string, DestinationBroadcastMeta> = {};
    for (const destination of destinations) {
      const draft = drafts[destination.id] ?? BLANK_DRAFT;
      metaById[destination.id] = {
        title: draft.title || undefined,
        description: draft.description || undefined,
        privacyStatus: draft.privacyStatus,
        latencyPreference: draft.latencyPreference,
      };
    }
    onConfirm(metaById);
  }

  return (
    <Drawer open={open} onOpenChange={onOpenChange} title={t('stream.destinationSettingsTitle')}>
      <div className="space-y-4">
        <p className="text-xs text-gray-500">{t('stream.destinationSettingsHelp')}</p>
        {destinations.map((destination) => {
          const draft = drafts[destination.id] ?? BLANK_DRAFT;
          return (
            <div key={destination.id} className="space-y-2 rounded border p-3">
              <p className="text-sm font-medium">{destination.name}</p>
              <input
                className="w-full rounded border px-2 py-1 text-sm"
                placeholder={t('stream.titlePlaceholder')}
                value={draft.title}
                onChange={(e) => setField(destination.id, 'title', e.target.value)}
              />
              <textarea
                className="w-full rounded border px-2 py-1 text-sm"
                placeholder={t('stream.descriptionPlaceholder')}
                value={draft.description}
                onChange={(e) => setField(destination.id, 'description', e.target.value)}
              />
              <div>
                <label htmlFor={`privacy-${destination.id}`} className="block text-xs font-medium">{t('stream.privacyLabel')}</label>
                <select
                  id={`privacy-${destination.id}`}
                  className="mt-1 w-full rounded border px-2 py-1 text-sm"
                  value={draft.privacyStatus}
                  onChange={(e) => setField(destination.id, 'privacyStatus', e.target.value as Draft['privacyStatus'])}
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
                  onChange={(e) => setField(destination.id, 'latencyPreference', e.target.value as Draft['latencyPreference'])}
                >
                  <option value="normal">{t('stream.latencyNormal')}</option>
                  <option value="low">{t('stream.latencyLow')}</option>
                  <option value="ultraLow">{t('stream.latencyUltraLow')}</option>
                </select>
              </div>
            </div>
          );
        })}
        <button
          type="button"
          onClick={handleConfirm}
          className="w-full rounded bg-black px-4 py-2 text-white"
        >
          {t('stream.confirmAndGoLive')}
        </button>
      </div>
    </Drawer>
  );
}
