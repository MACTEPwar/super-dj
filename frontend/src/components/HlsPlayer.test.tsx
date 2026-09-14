import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { HlsPlayer } from './HlsPlayer';

type ErrorPayload = { type: string; fatal: boolean };

interface FakeInstance {
  config: { xhrSetup: (xhr: XMLHttpRequest) => void };
  attachMedia: ReturnType<typeof vi.fn>;
  loadSource: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  recoverMediaError: ReturnType<typeof vi.fn>;
  emitError: (data: ErrorPayload) => void;
  emitManifestParsed: () => void;
  emitMediaAttached: () => void;
}

const { instances } = vi.hoisted(() => ({ instances: [] as FakeInstance[] }));

vi.mock('hls.js', () => {
  class FakeHls {
    static Events = { ERROR: 'hlsError', MANIFEST_PARSED: 'hlsManifestParsed', MEDIA_ATTACHED: 'hlsMediaAttached' };
    static ErrorTypes = { NETWORK_ERROR: 'networkError', MEDIA_ERROR: 'mediaError' };
    static isSupported = vi.fn(() => true);

    config: unknown;
    handlers: Record<string, (event: string, data: unknown) => void> = {};
    attachMedia = vi.fn();
    loadSource = vi.fn();
    destroy = vi.fn();
    recoverMediaError = vi.fn();
    on = vi.fn((event: string, cb: (event: string, data: unknown) => void) => { this.handlers[event] = cb; });

    constructor(config: unknown) {
      this.config = config;
      instances.push(this as unknown as FakeInstance);
    }

    emitError(data: ErrorPayload) { this.handlers.hlsError?.('hlsError', data); }
    emitManifestParsed() { this.handlers.hlsManifestParsed?.('hlsManifestParsed', {}); }
    emitMediaAttached() { this.handlers.hlsMediaAttached?.('hlsMediaAttached', {}); }
  }
  return { default: FakeHls };
});

import Hls from 'hls.js';

const FATAL_NETWORK: ErrorPayload = { type: 'networkError', fatal: true };

// The first entry of REBUILD_DELAYS_MS in HlsPlayer.tsx; anything >= it flushes a pending rebuild.
const FIRST_DELAY = 500;
const LONGEST_DELAY = 8000;

function advance(ms: number) {
  act(() => { vi.advanceTimersByTime(ms); });
}

// jsdom's document.hidden is a non-configurable getter on the prototype, so override it on the
// instance. `setHidden(false)` alone models Chrome's own behaviour (the flag flips before the
// event); `showPage()` also delivers the event the component listens for.
let hiddenValue = false;

function setHidden(value: boolean) {
  hiddenValue = value;
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hiddenValue });
}

function showPage() {
  setHidden(false);
  act(() => { document.dispatchEvent(new Event('visibilitychange')); });
}

describe('HlsPlayer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    instances.length = 0;
    vi.useFakeTimers();
    setHidden(false);
    (Hls.isSupported as unknown as ReturnType<typeof vi.fn>).mockReturnValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
    setHidden(false);
  });

  it('attaches hls.js to the video element and loads the source', () => {
    render(<HlsPlayer src="http://api/local-stream/preview/index.m3u8" unsupportedMessage="no hls" />);
    expect(instances[0].attachMedia).toHaveBeenCalledWith(screen.getByTestId('hls-video'));
    expect(instances[0].loadSource).toHaveBeenCalledWith('http://api/local-stream/preview/index.m3u8');
  });

  // Without this the session cookie is never sent and every playlist/segment request 401s. This is
  // the single most load-bearing line in the component.
  it('configures hls.js to send credentials on every playlist and segment request', () => {
    render(<HlsPlayer src="http://api/x.m3u8" unsupportedMessage="no hls" />);
    const xhr = { withCredentials: false } as XMLHttpRequest;
    instances[0].config.xhrSetup(xhr);
    expect(xhr.withCredentials).toBe(true);
  });

  // THE regression test for the "preview spins forever" bug. hls.js never retries a 4xx, so
  // MediaMTX's normal on-demand 404 during the startup window goes straight to a fatal
  // MANIFEST_LOAD_ERROR — and hls.startLoad() cannot recover from that (no level was ever parsed,
  // so it never re-requests index.m3u8). Only a brand-new Hls instance re-fetches index.m3u8, which
  // is what makes MediaMTX mint a usable session.
  it('rebuilds the whole player after a fatal network error so index.m3u8 is fetched afresh', () => {
    render(<HlsPlayer src="http://api/index.m3u8" unsupportedMessage="no hls" />);
    instances[0].emitError(FATAL_NETWORK);

    // The rebuild is scheduled, not immediate — it must not hammer the relay.
    expect(instances).toHaveLength(1);

    advance(FIRST_DELAY);
    expect(instances).toHaveLength(2);
    expect(instances[0].destroy).toHaveBeenCalled();
    expect(instances[1].loadSource).toHaveBeenCalledWith('http://api/index.m3u8');
  });

  // The old handler called hls.startLoad(), which re-requests the SAME session-scoped level URL.
  // MediaMTX destroys a session with its muxer, and a destroyed session's URL 401s forever, so that
  // recovery could never work. Guard the property directly.
  it('never re-uses the dead instance: every recovery goes through a fresh instance', () => {
    render(<HlsPlayer src="http://api/index.m3u8" unsupportedMessage="no hls" />);
    instances[0].emitError(FATAL_NETWORK);
    advance(FIRST_DELAY);
    expect(instances[1]).not.toBe(instances[0]);
    expect(instances[1].loadSource).toHaveBeenCalledTimes(1);
  });

  // The other half of the bug: hls.js gave up permanently after a handful of attempts, so a stream
  // that became readable 30 seconds later needed a manual page reload.
  it('keeps retrying indefinitely instead of giving up after a few attempts', () => {
    render(<HlsPlayer src="http://api/index.m3u8" unsupportedMessage="no hls" />);
    for (let i = 0; i < 12; i += 1) {
      instances[instances.length - 1].emitError(FATAL_NETWORK);
      advance(LONGEST_DELAY);
    }
    expect(instances).toHaveLength(13);
    expect(instances[12].loadSource).toHaveBeenCalledWith('http://api/index.m3u8');
  });

  it('backs off between rebuilds and resets the backoff once a manifest parses', () => {
    render(<HlsPlayer src="http://api/index.m3u8" unsupportedMessage="no hls" />);

    instances[0].emitError(FATAL_NETWORK);
    advance(FIRST_DELAY);
    expect(instances).toHaveLength(2);

    // Second consecutive failure waits longer than the first did.
    instances[1].emitError(FATAL_NETWORK);
    advance(FIRST_DELAY);
    expect(instances).toHaveLength(2);
    advance(LONGEST_DELAY);
    expect(instances).toHaveLength(3);

    // A successful load clears the accumulated penalty, so the next failure recovers fast again.
    instances[2].emitManifestParsed();
    instances[2].emitError(FATAL_NETWORK);
    advance(FIRST_DELAY);
    expect(instances).toHaveLength(4);
  });

  it('ignores non-fatal errors', () => {
    render(<HlsPlayer src="http://api/index.m3u8" unsupportedMessage="no hls" />);
    instances[0].emitError({ type: 'networkError', fatal: false });
    advance(LONGEST_DELAY * 2);
    expect(instances).toHaveLength(1);
    expect(instances[0].destroy).not.toHaveBeenCalled();
  });

  it('repairs a fatal media error in place once, then rebuilds if it happens again', () => {
    render(<HlsPlayer src="http://api/index.m3u8" unsupportedMessage="no hls" />);
    instances[0].emitError({ type: 'mediaError', fatal: true });
    expect(instances[0].recoverMediaError).toHaveBeenCalledTimes(1);
    advance(LONGEST_DELAY);
    expect(instances).toHaveLength(1);

    instances[0].emitError({ type: 'mediaError', fatal: true });
    expect(instances[0].recoverMediaError).toHaveBeenCalledTimes(1);
    advance(FIRST_DELAY);
    expect(instances).toHaveLength(2);
  });

  it('destroys the hls instance on unmount so a hidden player stops fetching segments', () => {
    const { unmount } = render(<HlsPlayer src="http://api/x.m3u8" unsupportedMessage="no hls" />);
    unmount();
    expect(instances[0].destroy).toHaveBeenCalled();
  });

  it('cancels a pending rebuild on unmount rather than resurrecting the player', () => {
    const { unmount } = render(<HlsPlayer src="http://api/x.m3u8" unsupportedMessage="no hls" />);
    instances[0].emitError(FATAL_NETWORK);
    unmount();
    advance(LONGEST_DELAY * 2);
    expect(instances).toHaveLength(1);
  });

  it('rebuilds the player when the source changes', () => {
    const { rerender } = render(<HlsPlayer src="http://api/a.m3u8" unsupportedMessage="no hls" />);
    rerender(<HlsPlayer src="http://api/b.m3u8" unsupportedMessage="no hls" />);
    expect(instances[0].destroy).toHaveBeenCalledTimes(1);
    expect(instances).toHaveLength(2);
    expect(instances[1].loadSource).toHaveBeenCalledWith('http://api/b.m3u8');
  });

  // THE regression test for the second "preview never plays" bug. Chrome defers a media element's
  // load while the document is hidden, so the MediaSource handed to attachMedia() never opens and
  // hls.js never fires MEDIA_ATTACHED — after which StreamController silently refuses to pick a
  // fragment on every tick, with no ERROR event to recover from. Reproduced against real binaries:
  // 0 fragment requests while hidden, playback the instant the page was brought to the front.
  it('does not build a player while the page is hidden', () => {
    setHidden(true);
    render(<HlsPlayer src="http://api/index.m3u8" unsupportedMessage="no hls" />);
    expect(instances).toHaveLength(0);
  });

  it('builds the player as soon as the page becomes visible', () => {
    setHidden(true);
    render(<HlsPlayer src="http://api/index.m3u8" unsupportedMessage="no hls" />);
    showPage();
    expect(instances).toHaveLength(1);
    expect(instances[0].loadSource).toHaveBeenCalledWith('http://api/index.m3u8');
  });

  // The page went hidden between attachMedia() and the MediaSource opening, so this instance is the
  // zombie described above: alive, polling, and permanently unable to load a fragment.
  it('rebuilds a player whose media never attached once the page becomes visible', () => {
    render(<HlsPlayer src="http://api/index.m3u8" unsupportedMessage="no hls" />);
    setHidden(true);
    showPage();
    expect(instances).toHaveLength(2);
    expect(instances[0].destroy).toHaveBeenCalled();
    expect(instances[1].loadSource).toHaveBeenCalledWith('http://api/index.m3u8');
  });

  // A player that IS attached keeps buffering in a background tab; tabbing back must not cost the
  // viewer a fresh MediaMTX session and several seconds of re-buffering.
  it('leaves an already-attached player alone when the page becomes visible again', () => {
    render(<HlsPlayer src="http://api/index.m3u8" unsupportedMessage="no hls" />);
    instances[0].emitMediaAttached();
    setHidden(true);
    showPage();
    expect(instances).toHaveLength(1);
    expect(instances[0].destroy).not.toHaveBeenCalled();
  });

  it('defers a scheduled rebuild that comes due while the page is hidden until it is visible', () => {
    render(<HlsPlayer src="http://api/index.m3u8" unsupportedMessage="no hls" />);
    instances[0].emitError(FATAL_NETWORK);
    setHidden(true);
    advance(FIRST_DELAY);
    expect(instances).toHaveLength(1);

    showPage();
    expect(instances).toHaveLength(2);
    expect(instances[1].loadSource).toHaveBeenCalledWith('http://api/index.m3u8');
  });

  it('stops reacting to visibility changes after unmount', () => {
    setHidden(true);
    const { unmount } = render(<HlsPlayer src="http://api/index.m3u8" unsupportedMessage="no hls" />);
    unmount();
    showPage();
    expect(instances).toHaveLength(0);
  });

  it('falls back to the browser\'s native player when MSE-based hls.js is unsupported', () => {
    (Hls.isSupported as unknown as ReturnType<typeof vi.fn>).mockReturnValue(false);
    const canPlayType = vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue('maybe');
    render(<HlsPlayer src="http://api/native.m3u8" unsupportedMessage="no hls" />);
    expect(screen.getByTestId('hls-video')).toHaveAttribute('src', 'http://api/native.m3u8');
    expect(instances).toHaveLength(0);
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
