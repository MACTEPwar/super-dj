import { FormEvent, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { playlistsApi } from '../api/playlists';
import { ApiError } from '../api/client';
import { Drawer } from './Drawer';

interface CreatePlaylistDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}

export function CreatePlaylistDrawer({ open, onOpenChange, onCreated }: CreatePlaylistDrawerProps) {
  const [name, setName] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);

  const createMutation = useMutation({
    mutationFn: (name: string) => playlistsApi.create(name),
    onSuccess: () => {
      onCreated();
      onOpenChange(false);
      setName('');
    },
    onError: (err) => setCreateError(err instanceof ApiError ? err.message : 'Failed to create playlist'),
  });

  function handleCreate(e: FormEvent) {
    e.preventDefault();
    setCreateError(null);
    if (name.trim()) createMutation.mutate(name.trim());
  }

  return (
    <Drawer open={open} onOpenChange={onOpenChange} title="Create Playlist">
      <form onSubmit={handleCreate} className="space-y-3">
        <input className="w-full rounded border px-3 py-2" placeholder="Playlist name" value={name} onChange={(e) => setName(e.target.value)} required />
        {createError && <p className="text-sm text-red-600">{createError}</p>}
        <button type="submit" disabled={createMutation.isPending} className="w-full rounded bg-black px-4 py-2 text-white disabled:opacity-50">
          {createMutation.isPending ? 'Creating…' : 'Create'}
        </button>
      </form>
    </Drawer>
  );
}
