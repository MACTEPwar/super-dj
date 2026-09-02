import { FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { playlistsApi } from '../api/playlists';
import { destinationsApi } from '../api/destinations';
import { streamSessionsApi } from '../api/streamSessions';
import { ApiError } from '../api/client';
import { Drawer } from './Drawer';

interface StartStreamDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function StartStreamDrawer({ open, onOpenChange }: StartStreamDrawerProps) {
  const navigate = useNavigate();
  const playlistsQuery = useQuery({ queryKey: ['playlists'], queryFn: playlistsApi.list });
  const destinationsQuery = useQuery({ queryKey: ['destinations'], queryFn: destinationsApi.list });

  const [playlistId, setPlaylistId] = useState('');
  const [destinationIds, setDestinationIds] = useState<string[]>([]);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [privacyStatus, setPrivacyStatus] = useState<'public' | 'unlisted' | 'private'>('private');
  const [formError, setFormError] = useState<string | null>(null);

  const selectedDestinations = (destinationsQuery.data ?? []).filter((d) => destinationIds.includes(d.id));
  const hasYoutubeDestination = selectedDestinations.some((d) => d.provider === 'youtube');

  const createMutation = useMutation({
    mutationFn: () => streamSessionsApi.create({
      playlistId,
      destinationIds,
      title: title || undefined,
      description: description || undefined,
      privacyStatus: hasYoutubeDestination ? privacyStatus : undefined,
    }),
    onSuccess: (session) => {
      onOpenChange(false);
      navigate(`/streams/${session.id}`);
    },
    onError: (err) => setFormError(err instanceof ApiError ? err.message : 'Failed to start stream'),
  });

  function toggleDestination(id: string) {
    setDestinationIds((current) => (current.includes(id) ? current.filter((x) => x !== id) : [...current, id]));
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (!playlistId || destinationIds.length === 0) return;
    createMutation.mutate();
  }

  return (
    <Drawer open={open} onOpenChange={onOpenChange} title="Start Stream">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor="stream-playlist" className="block text-sm font-medium">Playlist</label>
          <select
            id="stream-playlist"
            className="mt-1 w-full rounded border px-3 py-2"
            value={playlistId}
            onChange={(e) => setPlaylistId(e.target.value)}
            required
          >
            <option value="">Select a playlist…</option>
            {playlistsQuery.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>

        <div>
          <div className="block text-sm font-medium">Destinations</div>
          <p className="text-xs text-gray-500">Selected destinations all start together, from the same playlist.</p>
          <ul className="mt-1 divide-y rounded border">
            {destinationsQuery.data?.map((destination) => (
              <li key={destination.id} className="flex items-center gap-2 p-2">
                <input
                  type="checkbox"
                  id={`stream-dest-${destination.id}`}
                  checked={destinationIds.includes(destination.id)}
                  onChange={() => toggleDestination(destination.id)}
                />
                <label htmlFor={`stream-dest-${destination.id}`} className="flex-1 text-sm">
                  {destination.name} <span className="text-xs text-gray-500">({destination.provider})</span>
                </label>
              </li>
            ))}
            {destinationsQuery.data?.length === 0 && <li className="p-2 text-sm text-gray-500">No destinations yet.</li>}
          </ul>
        </div>

        {hasYoutubeDestination && (
          <div className="space-y-3 rounded border p-3">
            <p className="text-xs text-gray-500">Broadcast metadata for the YouTube destination(s) in this stream.</p>
            <input className="w-full rounded border px-3 py-2" placeholder="Title (optional — defaults to playlist name)" value={title} onChange={(e) => setTitle(e.target.value)} />
            <textarea className="w-full rounded border px-3 py-2" placeholder="Description (optional)" value={description} onChange={(e) => setDescription(e.target.value)} />
            <div>
              <label htmlFor="stream-privacy" className="block text-sm font-medium">Privacy</label>
              <select
                id="stream-privacy"
                className="mt-1 w-full rounded border px-3 py-2"
                value={privacyStatus}
                onChange={(e) => setPrivacyStatus(e.target.value as 'public' | 'unlisted' | 'private')}
              >
                <option value="private">Private</option>
                <option value="unlisted">Unlisted</option>
                <option value="public">Public</option>
              </select>
            </div>
          </div>
        )}

        {formError && <p className="text-sm text-red-600">{formError}</p>}
        <button
          type="submit"
          disabled={!playlistId || destinationIds.length === 0 || createMutation.isPending}
          className="w-full rounded bg-black px-4 py-2 text-white disabled:opacity-50"
        >
          {createMutation.isPending ? 'Starting…' : `Start stream on ${destinationIds.length || ''} destination${destinationIds.length === 1 ? '' : 's'}`}
        </button>
      </form>
    </Drawer>
  );
}
