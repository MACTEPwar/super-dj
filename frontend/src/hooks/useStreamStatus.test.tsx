import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactNode } from 'react';
import { useStreamStatus } from './useStreamStatus';
import { streamApi } from '../api/stream';

vi.mock('../api/stream');

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

describe('useStreamStatus', () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource as unknown as typeof EventSource);
    vi.mocked(streamApi.status).mockResolvedValue({ state: 'idle', currentTrack: null, nextTrack: null });
    vi.mocked(streamApi.eventsUrl).mockReturnValue('http://api/destinations/d1/stream/events');
  });
  afterEach(() => vi.unstubAllGlobals());

  it('fetches the initial status and opens a credentialed SSE connection', async () => {
    const { result } = renderHook(() => useStreamStatus('d1'), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual({ state: 'idle', currentTrack: null, nextTrack: null }));
    expect(FakeEventSource.instances[0].url).toBe('http://api/destinations/d1/stream/events');
    expect(FakeEventSource.instances[0].opts).toEqual({ withCredentials: true });
  });

  it('updates the query result when an SSE message arrives', async () => {
    const { result } = renderHook(() => useStreamStatus('d1'), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());

    FakeEventSource.instances[0].emit({ state: 'streaming', currentTrack: 'a', nextTrack: 'b' });

    await waitFor(() => expect(result.current.data).toEqual({ state: 'streaming', currentTrack: 'a', nextTrack: 'b' }));
  });

  it('closes the EventSource on unmount', async () => {
    const { unmount } = renderHook(() => useStreamStatus('d1'), { wrapper });
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    unmount();
    expect(FakeEventSource.instances[0].closed).toBe(true);
  });
});
