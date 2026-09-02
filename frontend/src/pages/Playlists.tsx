import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { playlistsApi } from '../api/playlists';
import { ApiError } from '../api/client';
import { CreatePlaylistDrawer } from '../components/CreatePlaylistDrawer';

export default function Playlists() {
  const queryClient = useQueryClient();
  const playlistsQuery = useQuery({ queryKey: ['playlists'], queryFn: playlistsApi.list });
  const [isDrawerOpen, setDrawerOpen] = useState(false);

  const deleteMutation = useMutation({
    mutationFn: (id: string) => playlistsApi.remove(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['playlists'] }),
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Failed to delete playlist'),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Playlists</h1>
        <button onClick={() => setDrawerOpen(true)} className="rounded bg-black px-4 py-2 text-white">+ Create Playlist</button>
      </div>

      <ul className="divide-y rounded-lg border">
        {playlistsQuery.data?.map((playlist) => (
          <li key={playlist.id} className="flex items-center justify-between p-3">
            <Link to={`/playlists/${playlist.id}`} className="font-medium underline">{playlist.name}</Link>
            <button onClick={() => deleteMutation.mutate(playlist.id)} className="text-sm text-red-600">Delete</button>
          </li>
        ))}
        {playlistsQuery.data?.length === 0 && <li className="p-3 text-sm text-gray-500">No playlists yet.</li>}
      </ul>

      <CreatePlaylistDrawer
        open={isDrawerOpen}
        onOpenChange={setDrawerOpen}
        onCreated={() => queryClient.invalidateQueries({ queryKey: ['playlists'] })}
      />
    </div>
  );
}
