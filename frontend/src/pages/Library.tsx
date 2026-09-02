import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { tracksApi, Track } from '../api/tracks';
import { ApiError } from '../api/client';
import { AddTrackDrawer } from '../components/AddTrackDrawer';

export default function Library() {
  const queryClient = useQueryClient();
  const tracksQuery = useQuery({ queryKey: ['tracks'], queryFn: tracksApi.list });
  const [isDrawerOpen, setDrawerOpen] = useState(false);

  const deleteMutation = useMutation({
    mutationFn: (id: string) => tracksApi.remove(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['tracks'] }),
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Failed to delete track'),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Library</h1>
        <button onClick={() => setDrawerOpen(true)} className="rounded bg-black px-4 py-2 text-white">+ Add Track</button>
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
                {track.durationSeconds !== null ? `${Math.round(track.durationSeconds)}s` : 'duration unknown'}
              </div>
            </div>
            <button onClick={() => deleteMutation.mutate(track.id)} className="text-sm text-red-600">Delete</button>
          </li>
        ))}
        {tracksQuery.data?.length === 0 && <li className="p-3 text-sm text-gray-500">No tracks yet.</li>}
      </ul>

      <AddTrackDrawer
        open={isDrawerOpen}
        onOpenChange={setDrawerOpen}
        onUploaded={() => queryClient.invalidateQueries({ queryKey: ['tracks'] })}
      />
    </div>
  );
}
