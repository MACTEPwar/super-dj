import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { streamApi, StreamStatus } from '../api/stream';

export function useStreamStatus(destinationId: string) {
  const queryClient = useQueryClient();
  const queryKey = ['stream-status', destinationId];

  const query = useQuery({
    queryKey,
    queryFn: () => streamApi.status(destinationId),
  });

  useEffect(() => {
    const source = new EventSource(streamApi.eventsUrl(destinationId), { withCredentials: true });
    source.onmessage = (event) => {
      const status: StreamStatus = JSON.parse(event.data);
      queryClient.setQueryData(queryKey, status);
    };
    return () => source.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- queryKey is a fresh array each
    // render but is derived solely from destinationId, which is already a dependency.
  }, [destinationId, queryClient]);

  return query;
}
