import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DndContext, DragEndEvent, closestCenter } from '@dnd-kit/core';
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { toast } from 'sonner';
import { playlistsApi, PlaylistTrack } from '../api/playlists';
import { tracksApi } from '../api/tracks';
import { ApiError } from '../api/client';

function SortableRow({ track, onRemove }: { track: PlaylistTrack; onRemove: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: track.id });
  const style = { transform: CSS.Transform.toString(transform), transition };
  return (
    <li ref={setNodeRef} style={style} className="flex items-center gap-3 border-b bg-white p-3">
      <span {...attributes} {...listeners} className="cursor-grab text-gray-400">⠿</span>
      <span className="flex-1">{track.name}</span>
      <button onClick={onRemove} className="text-sm text-red-600">Remove</button>
    </li>
  );
}

export default function PlaylistEditor() {
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const playlistQuery = useQuery({ queryKey: ['playlists', id], queryFn: () => playlistsApi.get(id!), enabled: !!id });
  const allTracksQuery = useQuery({ queryKey: ['tracks'], queryFn: tracksApi.list });
  const [orderedTracks, setOrderedTracks] = useState<PlaylistTrack[]>([]);

  useEffect(() => {
    if (playlistQuery.data) setOrderedTracks(playlistQuery.data.tracks);
  }, [playlistQuery.data]);

  const saveMutation = useMutation({
    mutationFn: () => playlistsApi.replaceTracks(id!, orderedTracks.map((t) => t.id)),
    onSuccess: () => {
      toast.success('Playlist saved');
      queryClient.invalidateQueries({ queryKey: ['playlists', id] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Failed to save playlist'),
  });

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setOrderedTracks((tracks) => {
      const oldIndex = tracks.findIndex((t) => t.id === active.id);
      const newIndex = tracks.findIndex((t) => t.id === over.id);
      return arrayMove(tracks, oldIndex, newIndex);
    });
  }

  function removeTrack(trackId: string) {
    setOrderedTracks((tracks) => tracks.filter((t) => t.id !== trackId));
  }

  function addTrack(track: { id: string; name: string }) {
    if (orderedTracks.some((t) => t.id === track.id)) return;
    setOrderedTracks((tracks) => [...tracks, { id: track.id, name: track.name, audioPath: '', coverPath: null }]);
  }

  const availableTracks = allTracksQuery.data?.filter((t) => !orderedTracks.some((ot) => ot.id === t.id)) ?? [];

  if (playlistQuery.isLoading) return <div>Loading…</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{playlistQuery.data?.name}</h1>
        <button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending} className="rounded bg-black px-4 py-2 text-white disabled:opacity-50">
          {saveMutation.isPending ? 'Saving…' : 'Save changes'}
        </button>
      </div>

      <DndContext collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={orderedTracks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
          <ul className="rounded-lg border">
            {orderedTracks.map((track) => (
              <SortableRow key={track.id} track={track} onRemove={() => removeTrack(track.id)} />
            ))}
            {orderedTracks.length === 0 && <li className="p-3 text-sm text-gray-500">No tracks in this playlist yet — add some below.</li>}
          </ul>
        </SortableContext>
      </DndContext>

      <div>
        <h2 className="mb-2 font-medium">Add tracks</h2>
        <ul className="divide-y rounded-lg border">
          {availableTracks.map((track) => (
            <li key={track.id} className="flex items-center justify-between p-3">
              <span>{track.name}</span>
              <button onClick={() => addTrack(track)} className="text-sm underline">Add</button>
            </li>
          ))}
          {availableTracks.length === 0 && <li className="p-3 text-sm text-gray-500">All tracks are already in this playlist.</li>}
        </ul>
      </div>
    </div>
  );
}
