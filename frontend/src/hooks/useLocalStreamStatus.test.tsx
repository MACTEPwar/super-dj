import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactNode } from 'react';
import { useLocalStreamStatus } from './useLocalStreamStatus';
import { localStreamApi } from '../api/localStream';

vi.mock('../api/localStream');

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onmessage: ((event: { data: string }) => void) | null = null;
  closed = false;
  constructor(public url: string, public opts?: EventSourceInit) { FakeEventSource.instances.push(this); }
  close() { this.closed = true; }
  emit(data: unknown) { this.onmessage?.({ data: JSON.stringify(data) }); }
}

const IDLE = {
  state: 'idle', currentTrack: null, nextTrack: null,
  previewReady: false, playlistId: null, templateId: null, startedAt: null,
};

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe('useLocalStreamStatus', () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource as unknown as typeof EventSource);
    vi.mocked(localStreamApi.status).mockResolvedValue(IDLE as never);
    vi.mocked(localStreamApi.eventsUrl).mockReturnValue('http://api/local-stream/events');
  });
  afterEach(() => vi.unstubAllGlobals());

  it('fetches the initial status and opens a credentialed SSE connection', async () => {
    const { result } = renderHook(() => useLocalStreamStatus(), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual(IDLE));
    expect(FakeEventSource.instances[0].url).toBe('http://api/local-stream/events');
    expect(FakeEventSource.instances[0].opts).toEqual({ withCredentials: true });
  });

  it('replaces the cached status when an SSE frame arrives', async () => {
    const { result } = renderHook(() => useLocalStreamStatus(), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());
    FakeEventSource.instances[0].emit({ ...IDLE, state: 'streaming', currentTrack: 'a', previewReady: true });
    await waitFor(() => expect(result.current.data?.state).toBe('streaming'));
    expect(result.current.data?.previewReady).toBe(true);
  });

  it('closes the EventSource on unmount', async () => {
    const { unmount } = renderHook(() => useLocalStreamStatus(), { wrapper });
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    unmount();
    expect(FakeEventSource.instances[0].closed).toBe(true);
  });
});
