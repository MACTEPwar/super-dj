import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { streamSessionsApi, StreamSessionStatus } from '../api/streamSessions';

export function useStreamSessionStatus(sessionId: string) {
  const queryClient = useQueryClient();
  const queryKey = ['stream-session-status', sessionId];

  const query = useQuery({
    queryKey,
    queryFn: () => streamSessionsApi.status(sessionId),
  });

  useEffect(() => {
    const source = new EventSource(streamSessionsApi.eventsUrl(sessionId), { withCredentials: true });
    source.onmessage = (event) => {
      const status: StreamSessionStatus = JSON.parse(event.data);
      queryClient.setQueryData(queryKey, status);
    };
    return () => source.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- queryKey is a fresh array each
    // render but is derived solely from sessionId, which is already a dependency.
  }, [sessionId, queryClient]);

  return query;
}
