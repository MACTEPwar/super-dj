import { FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { playlistsApi } from '../api/playlists';
import { ApiError } from '../api/client';

export default function Playlists() {
  const queryClient = useQueryClient();
  const playlistsQuery = useQuery({ queryKey: ['playlists'], queryFn: playlistsApi.list });
  const [name, setName] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);

  const createMutation = useMutation({
    mutationFn: (name: string) => playlistsApi.create(name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['playlists'] });
      setName('');
    },
    onError: (err) => setCreateError(err instanceof ApiError ? err.message : 'Failed to create playlist'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => playlistsApi.remove(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['playlists'] }),
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Failed to delete playlist'),
  });

  function handleCreate(e: FormEvent) {
    e.preventDefault();
    setCreateError(null);
    if (name.trim()) createMutation.mutate(name.trim());
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Playlists</h1>

      <form onSubmit={handleCreate} className="flex gap-2">
        <input className="flex-1 rounded border px-3 py-2" placeholder="New playlist name" value={name} onChange={(e) => setName(e.target.value)} />
        <button type="submit" className="rounded bg-black px-4 py-2 text-white">Create</button>
      </form>
      {createError && <p className="text-sm text-red-600">{createError}</p>}

      <ul className="divide-y rounded-lg border">
        {playlistsQuery.data?.map((playlist) => (
          <li key={playlist.id} className="flex items-center justify-between p-3">
            <Link to={`/playlists/${playlist.id}`} className="font-medium underline">{playlist.name}</Link>
            <button onClick={() => deleteMutation.mutate(playlist.id)} className="text-sm text-red-600">Delete</button>
          </li>
        ))}
        {playlistsQuery.data?.length === 0 && <li className="p-3 text-sm text-gray-500">No playlists yet.</li>}
      </ul>
    </div>
  );
}
