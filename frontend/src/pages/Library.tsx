import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { tracksApi, Track, TrackOverlayOverride, updateTrackOverlayOverride } from '../api/tracks';
import { ColorValue } from '../api/templates';
import { ApiError } from '../api/client';
import { AddTrackDrawer } from '../components/AddTrackDrawer';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Drawer } from '../components/Drawer';
import { ColorValueField } from '../components/TemplateFormFields';
import { usePageTitle } from '../hooks/usePageTitle';

function TrackOverlayOverrideEditor({ track, onClose }: { track: Track; onClose: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [color, setColor] = useState<ColorValue | undefined>(track.overlayOverride?.color);
  const [backgroundColor, setBackgroundColor] = useState<ColorValue | undefined>(track.overlayOverride?.backgroundColor);

  const saveMutation = useMutation({
    mutationFn: () => {
      const override: TrackOverlayOverride | null =
        color !== undefined || backgroundColor !== undefined
          ? { ...(color !== undefined ? { color } : {}), ...(backgroundColor !== undefined ? { backgroundColor } : {}) }
          : null;
      return updateTrackOverlayOverride(track.id, override);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tracks'] });
      toast.success(t('library.overlayOverrideSaved'));
      onClose();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('library.overlayOverrideSaveFailed')),
  });

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={color !== undefined}
            onChange={(e) => setColor(e.target.checked ? { mode: 'solid', color: '#ffffff' } : undefined)}
          />
          {t('library.overlayOverrideColorToggle')}
        </label>
        {color !== undefined && (
          <ColorValueField label={t('library.overlayOverrideColorLabel')} value={color} onChange={setColor} />
        )}
      </div>
      <div className="space-y-2">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={backgroundColor !== undefined}
            onChange={(e) => setBackgroundColor(e.target.checked ? { mode: 'solid', color: '#ffffff' } : undefined)}
          />
          {t('library.overlayOverrideBackgroundToggle')}
        </label>
        {backgroundColor !== undefined && (
          <ColorValueField label={t('library.overlayOverrideBackgroundLabel')} value={backgroundColor} onChange={setBackgroundColor} />
        )}
      </div>
      <button
        onClick={() => saveMutation.mutate()}
        disabled={saveMutation.isPending}
        className="rounded bg-black px-4 py-2 text-white disabled:opacity-50"
      >
        {saveMutation.isPending ? t('library.overlayOverrideSaving') : t('library.overlayOverrideSave')}
      </button>
    </div>
  );
}

export default function Library() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  usePageTitle(t('library.title'));
  const tracksQuery = useQuery({ queryKey: ['tracks'], queryFn: tracksApi.list });
  const [isDrawerOpen, setDrawerOpen] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [overlayEditingTrack, setOverlayEditingTrack] = useState<Track | null>(null);

  const deleteMutation = useMutation({
    mutationFn: (id: string) => tracksApi.remove(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tracks'] });
      setConfirmingId(null);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('library.deleteFailed')),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{t('library.title')}</h1>
        <button onClick={() => setDrawerOpen(true)} className="rounded bg-black px-4 py-2 text-white">{t('library.addTrack')}</button>
      </div>

      {tracksQuery.isLoading ? (
        <p className="text-sm text-gray-500">{t('library.loading')}</p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {tracksQuery.data?.map((track: Track) => (
            <li key={track.id} className="flex items-center gap-3 p-3">
              {track.hasCover ? (
                <img src={tracksApi.coverUrl(track.id)} alt="" className="h-10 w-10 rounded object-cover" />
              ) : (
                <div className="h-10 w-10 rounded bg-gray-200" />
              )}
              <div className="flex-1">
                <div className="font-medium">{track.name}</div>
                <div className="text-sm text-gray-500">
                  {track.durationSeconds !== null ? t('library.durationSeconds', { seconds: Math.round(track.durationSeconds) }) : t('library.durationUnknown')}
                </div>
              </div>
              <button onClick={() => setOverlayEditingTrack(track)} className="text-sm text-gray-600">{t('library.overlayOverride')}</button>
              <button onClick={() => setConfirmingId(track.id)} className="text-sm text-red-600">{t('library.delete')}</button>
            </li>
          ))}
          {tracksQuery.data?.length === 0 && <li className="p-3 text-sm text-gray-500">{t('library.empty')}</li>}
        </ul>
      )}

      <AddTrackDrawer
        open={isDrawerOpen}
        onOpenChange={setDrawerOpen}
        onAdded={() => queryClient.invalidateQueries({ queryKey: ['tracks'] })}
      />

      <ConfirmDialog
        open={confirmingId !== null}
        onOpenChange={(open) => !open && setConfirmingId(null)}
        title={t('library.deleteConfirmTitle')}
        description={t('library.deleteConfirmDescription')}
        confirmLabel={t('library.delete')}
        isPending={deleteMutation.isPending}
        onConfirm={() => confirmingId && deleteMutation.mutate(confirmingId)}
      />

      <Drawer
        open={overlayEditingTrack !== null}
        onOpenChange={(open) => !open && setOverlayEditingTrack(null)}
        title={t('library.overlayOverrideTitle')}
      >
        {overlayEditingTrack && (
          <TrackOverlayOverrideEditor
            key={overlayEditingTrack.id}
            track={overlayEditingTrack}
            onClose={() => setOverlayEditingTrack(null)}
          />
        )}
      </Drawer>
    </div>
  );
}
