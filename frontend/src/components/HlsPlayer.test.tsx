import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { HlsPlayer } from './HlsPlayer';

const attachMedia = vi.fn();
const loadSource = vi.fn();
const destroy = vi.fn();
const on = vi.fn();
const startLoad = vi.fn();
const constructorSpy = vi.fn();

vi.mock('hls.js', () => {
  class FakeHls {
    static Events = { ERROR: 'hlsError' };
    static ErrorTypes = { NETWORK_ERROR: 'networkError', MEDIA_ERROR: 'mediaError' };
    static isSupported = vi.fn(() => true);
    constructor(config: unknown) { constructorSpy(config); }
    attachMedia = attachMedia;
    loadSource = loadSource;
    destroy = destroy;
    on = on;
    startLoad = startLoad;
    recoverMediaError = vi.fn();
  }
  return { default: FakeHls };
});

import Hls from 'hls.js';

describe('HlsPlayer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (Hls.isSupported as unknown as ReturnType<typeof vi.fn>).mockReturnValue(true);
  });

  it('attaches hls.js to the video element and loads the source', () => {
    render(<HlsPlayer src="http://api/local-stream/preview/index.m3u8" unsupportedMessage="no hls" />);
    expect(attachMedia).toHaveBeenCalledWith(screen.getByTestId('hls-video'));
    expect(loadSource).toHaveBeenCalledWith('http://api/local-stream/preview/index.m3u8');
  });

  // Without this the session cookie is never sent and every playlist/segment request 401s. This is
  // the single most load-bearing line in the component.
  it('configures hls.js to send credentials on every playlist and segment request', () => {
    render(<HlsPlayer src="http://api/x.m3u8" unsupportedMessage="no hls" />);
    const config = constructorSpy.mock.calls[0][0];
    const xhr = { withCredentials: false } as XMLHttpRequest;
    config.xhrSetup(xhr, 'http://api/x.m3u8');
    expect(xhr.withCredentials).toBe(true);
  });

  // MediaMTX muxes HLS on demand, so the first request after a start can legitimately 404.
  it('retries loading on a fatal network error instead of giving up', () => {
    render(<HlsPlayer src="http://api/x.m3u8" unsupportedMessage="no hls" />);
    const handler = on.mock.calls.find(([event]) => event === 'hlsError')![1];
    handler('hlsError', { type: 'networkError', fatal: true });
    expect(startLoad).toHaveBeenCalled();
  });

  it('destroys the hls instance on unmount so a hidden player stops fetching segments', () => {
    const { unmount } = render(<HlsPlayer src="http://api/x.m3u8" unsupportedMessage="no hls" />);
    unmount();
    expect(destroy).toHaveBeenCalled();
  });

  it('rebuilds the player when the source changes', () => {
    const { rerender } = render(<HlsPlayer src="http://api/a.m3u8" unsupportedMessage="no hls" />);
    rerender(<HlsPlayer src="http://api/b.m3u8" unsupportedMessage="no hls" />);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(loadSource).toHaveBeenLastCalledWith('http://api/b.m3u8');
  });

  it('falls back to the browser\'s native player when MSE-based hls.js is unsupported', () => {
    (Hls.isSupported as unknown as ReturnType<typeof vi.fn>).mockReturnValue(false);
    const canPlayType = vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue('maybe');
    render(<HlsPlayer src="http://api/native.m3u8" unsupportedMessage="no hls" />);
    expect(screen.getByTestId('hls-video')).toHaveAttribute('src', 'http://api/native.m3u8');
    expect(attachMedia).not.toHaveBeenCalled();
    canPlayType.mockRestore();
  });

  it('shows the unsupported message when neither path is available', () => {
    (Hls.isSupported as unknown as ReturnType<typeof vi.fn>).mockReturnValue(false);
    const canPlayType = vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue('');
    render(<HlsPlayer src="http://api/x.m3u8" unsupportedMessage="Your browser cannot play this preview." />);
    expect(screen.getByText('Your browser cannot play this preview.')).toBeInTheDocument();
    canPlayType.mockRestore();
  });
});
