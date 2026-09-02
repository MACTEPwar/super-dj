import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { tracksApi, Track } from '../api/tracks';
import { ApiError } from '../api/client';
import { AddTrackDrawer } from '../components/AddTrackDrawer';

export default function Library() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const tracksQuery = useQuery({ queryKey: ['tracks'], queryFn: tracksApi.list });
  const [isDrawerOpen, setDrawerOpen] = useState(false);

  const deleteMutation = useMutation({
    mutationFn: (id: string) => tracksApi.remove(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['tracks'] }),
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('library.deleteFailed')),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{t('library.title')}</h1>
        <button onClick={() => setDrawerOpen(true)} className="rounded bg-black px-4 py-2 text-white">{t('library.addTrack')}</button>
      </div>

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
            <button onClick={() => deleteMutation.mutate(track.id)} className="text-sm text-red-600">{t('library.delete')}</button>
          </li>
        ))}
        {tracksQuery.data?.length === 0 && <li className="p-3 text-sm text-gray-500">{t('library.empty')}</li>}
      </ul>

      <AddTrackDrawer
        open={isDrawerOpen}
        onOpenChange={setDrawerOpen}
        onUploaded={() => queryClient.invalidateQueries({ queryKey: ['tracks'] })}
      />
    </div>
  );
}
