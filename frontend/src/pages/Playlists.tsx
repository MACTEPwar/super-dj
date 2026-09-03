import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { playlistsApi } from '../api/playlists';
import { ApiError } from '../api/client';
import { CreatePlaylistDrawer } from '../components/CreatePlaylistDrawer';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { usePageTitle } from '../hooks/usePageTitle';

export default function Playlists() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  usePageTitle(t('playlists.title'));
  const playlistsQuery = useQuery({ queryKey: ['playlists'], queryFn: playlistsApi.list });
  const [isDrawerOpen, setDrawerOpen] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  const deleteMutation = useMutation({
    mutationFn: (id: string) => playlistsApi.remove(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['playlists'] });
      setConfirmingId(null);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('playlists.deleteFailed')),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{t('playlists.title')}</h1>
        <button onClick={() => setDrawerOpen(true)} className="rounded bg-black px-4 py-2 text-white">{t('playlists.create')}</button>
      </div>

      {playlistsQuery.isLoading ? (
        <p className="text-sm text-gray-500">{t('playlists.loading')}</p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {playlistsQuery.data?.map((playlist) => (
            <li key={playlist.id} className="flex items-center justify-between p-3">
              <Link to={`/playlists/${playlist.id}`} className="font-medium underline">{playlist.name}</Link>
              <button onClick={() => setConfirmingId(playlist.id)} className="text-sm text-red-600">{t('playlists.delete')}</button>
            </li>
          ))}
          {playlistsQuery.data?.length === 0 && <li className="p-3 text-sm text-gray-500">{t('playlists.empty')}</li>}
        </ul>
      )}

      <CreatePlaylistDrawer
        open={isDrawerOpen}
        onOpenChange={setDrawerOpen}
        onCreated={() => queryClient.invalidateQueries({ queryKey: ['playlists'] })}
      />

      <ConfirmDialog
        open={confirmingId !== null}
        onOpenChange={(open) => !open && setConfirmingId(null)}
        title={t('playlists.deleteConfirmTitle')}
        description={t('playlists.deleteConfirmDescription')}
        confirmLabel={t('playlists.delete')}
        isPending={deleteMutation.isPending}
        onConfirm={() => confirmingId && deleteMutation.mutate(confirmingId)}
      />
    </div>
  );
}
