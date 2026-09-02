import { useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useStreamSessionStatus } from '../hooks/useStreamSessionStatus';
import { streamSessionsApi, StreamSessionStatus } from '../api/streamSessions';
import { destinationsApi } from '../api/destinations';
import { playlistsApi } from '../api/playlists';
import { ApiError } from '../api/client';

const PHASE_LABELS: Record<string, string> = {
  creating: '🟡 Preparing broadcast…',
  waitingForYoutube: '🟡 Connecting to YouTube…',
  live: '🔴 Live',
  complete: '⚫ Ended',
  error: '🔴 Error',
};

export default function StreamSessionPanel() {
  const { id } = useParams<{ id: string }>();
  const sessionId = id!;
  const queryClient = useQueryClient();
  const statusQuery = useStreamSessionStatus(sessionId);
  const destinationsQuery = useQuery({ queryKey: ['destinations'], queryFn: destinationsApi.list });
  const playlistsQuery = useQuery({ queryKey: ['playlists'], queryFn: playlistsApi.list });

  function onStatusMutationSuccess(status: StreamSessionStatus) {
    queryClient.setQueryData(['stream-session-status', sessionId], status);
  }

  function useSessionCommand(label: string, fn: (id: string) => Promise<StreamSessionStatus>) {
    return useMutation({
      mutationFn: () => fn(sessionId),
      onSuccess: onStatusMutationSuccess,
      onError: (err) => toast.error(err instanceof ApiError ? err.message : `Failed to ${label}`),
    });
  }

  const pauseMutation = useSessionCommand('pause', streamSessionsApi.pause);
  const resumeMutation = useSessionCommand('resume', streamSessionsApi.resume);
  const nextMutation = useSessionCommand('skip to next track', streamSessionsApi.next);
  const previousMutation = useSessionCommand('go to previous track', streamSessionsApi.previous);
  const stopMutation = useSessionCommand('stop', streamSessionsApi.stop);

  const status = statusQuery.data;
  const destinationName = (destId: string) => destinationsQuery.data?.find((d) => d.id === destId)?.name ?? destId;
  const playlistName = status ? (playlistsQuery.data?.find((p) => p.id === status.playlistId)?.name ?? status.playlistId) : '';

  return (
    <div className="max-w-2xl space-y-4">
      <h1 className="text-2xl font-semibold">Stream: {playlistName}</h1>

      <div className="flex flex-wrap gap-2 rounded-lg border p-4">
        <button onClick={() => previousMutation.mutate()} className="rounded border px-3 py-2">⏮ Previous</button>
        <button onClick={() => pauseMutation.mutate()} className="rounded border px-3 py-2">⏸ Pause all</button>
        <button onClick={() => resumeMutation.mutate()} className="rounded border px-3 py-2">▶ Resume all</button>
        <button onClick={() => nextMutation.mutate()} className="rounded border px-3 py-2">⏭ Next</button>
        <button onClick={() => stopMutation.mutate()} className="rounded border px-3 py-2 text-red-600">⏹ Stop all</button>
      </div>

      <div className="space-y-3">
        {status?.destinations.map((d) => (
          <div key={d.destinationId} className="rounded-lg border p-4">
            <div className="flex items-center justify-between">
              <div className="font-medium">{destinationName(d.destinationId)}</div>
              <span className="text-xs text-gray-500">{d.status.state}</span>
            </div>
            {d.error && <p className="mt-1 text-sm text-red-600">{d.error}</p>}
            {d.status.provider && (
              <div className="mt-1 text-sm">
                {PHASE_LABELS[d.status.provider.phase] ?? d.status.provider.phase}
                {d.status.provider.watchUrl && (
                  <a href={d.status.provider.watchUrl} target="_blank" rel="noreferrer" className="ml-2 underline">
                    Watch on YouTube
                  </a>
                )}
              </div>
            )}
            <div className="mt-2 text-sm text-gray-600">
              Now playing: {d.status.currentTrack ?? '—'} · Next: {d.status.nextTrack ?? '—'}
            </div>
          </div>
        ))}
        {status?.destinations.length === 0 && <p className="text-sm text-gray-500">This session has no destinations.</p>}
      </div>
    </div>
  );
}
