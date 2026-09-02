import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactNode } from 'react';
import { useStreamSessionStatus } from './useStreamSessionStatus';
import { streamSessionsApi } from '../api/streamSessions';

vi.mock('../api/streamSessions');

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onmessage: ((event: { data: string }) => void) | null = null;
  closed = false;
  constructor(public url: string, public opts?: EventSourceInit) {
    FakeEventSource.instances.push(this);
  }
  close() { this.closed = true; }
  emit(data: unknown) { this.onmessage?.({ data: JSON.stringify(data) }); }
}

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe('useStreamSessionStatus', () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource as unknown as typeof EventSource);
    vi.mocked(streamSessionsApi.status).mockResolvedValue({ id: 's1', playlistId: 'p1', destinations: [] });
    vi.mocked(streamSessionsApi.eventsUrl).mockReturnValue('http://api/stream-sessions/s1/events');
  });
  afterEach(() => vi.unstubAllGlobals());

  it('fetches the initial status and opens a credentialed SSE connection', async () => {
    const { result } = renderHook(() => useStreamSessionStatus('s1'), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual({ id: 's1', playlistId: 'p1', destinations: [] }));
    expect(FakeEventSource.instances[0].url).toBe('http://api/stream-sessions/s1/events');
    expect(FakeEventSource.instances[0].opts).toEqual({ withCredentials: true });
  });

  it('updates the query result when an SSE message arrives', async () => {
    const { result } = renderHook(() => useStreamSessionStatus('s1'), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());

    FakeEventSource.instances[0].emit({
      id: 's1', playlistId: 'p1',
      destinations: [{ destinationId: 'd1', status: { state: 'streaming', currentTrack: 'a', nextTrack: 'b' } }],
    });

    await waitFor(() => expect(result.current.data?.destinations).toHaveLength(1));
  });

  it('closes the EventSource on unmount', async () => {
    const { unmount } = renderHook(() => useStreamSessionStatus('s1'), { wrapper });
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    unmount();
    expect(FakeEventSource.instances[0].closed).toBe(true);
  });
});
