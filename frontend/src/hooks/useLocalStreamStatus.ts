import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { localStreamApi, LocalStreamStatus } from '../api/localStream';

// Exported so pages can seed this cache from a mutation response instead of refetching.
export const LOCAL_STREAM_STATUS_QUERY_KEY = ['local-stream-status'] as const;

export function useLocalStreamStatus() {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: LOCAL_STREAM_STATUS_QUERY_KEY,
    queryFn: () => localStreamApi.status(),
  });

  useEffect(() => {
    const source = new EventSource(localStreamApi.eventsUrl(), { withCredentials: true });
    source.onmessage = (event) => {
      const status: LocalStreamStatus = JSON.parse(event.data);
      queryClient.setQueryData(LOCAL_STREAM_STATUS_QUERY_KEY, status);
    };
    return () => source.close();
  }, [queryClient]);

  return query;
}
