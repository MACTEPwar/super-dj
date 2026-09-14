import { useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';

export interface HlsPlayerProps {
  src: string;
  className?: string;
  unsupportedMessage: string;
}

/**
 * Rebuild cadence after a fatal error. The first few entries are tight because the overwhelmingly
 * common case is the documented startup window — MediaMTX muxes HLS on demand and answers
 * `index.m3u8` with 404 for a measured 2.4-6.4s after a fresh publish. The tail (the last value,
 * which repeats forever) is what turns "the stream became readable a minute later" from "reload the
 * page" into "it just starts". Attempts therefore land at roughly t+0.5, 1.5, 3, 5, 8, 13, 21, 29,
 * 37... seconds, and never stop while the player is mounted.
 */
const REBUILD_DELAYS_MS = [500, 1000, 1500, 2000, 3000, 5000, 8000];

/**
 * Plays the backend's proxied HLS preview.
 *
 * Four things here are load-bearing and must not be "simplified" away:
 *  - `xhrSetup` sets `withCredentials`. The playlist and every segment are cross-origin requests to
 *    the API, and the backend resolves WHICH stream to serve from the session cookie — without
 *    this, every request 401s and the player just shows an error with no obvious cause.
 *  - A fatal error DESTROYS AND REBUILDS the whole `Hls` instance rather than calling
 *    `hls.startLoad()`. This is a real, reproduced bug, not a stylistic preference — see the long
 *    comment on `scheduleRebuild` below.
 *  - The rebuild loop never gives up while the component is mounted.
 *  - No `Hls` instance is built while `document.hidden` is true, and one that never reached
 *    `MEDIA_ATTACHED` is rebuilt when the page becomes visible — see `buildDeferredWhileHidden`.
 *
 * Known limitation (documented in the design spec, not solved here): on iOS Safari `Hls.isSupported()`
 * is false and the native fallback below fetches the playlist itself, which will not attach a
 * cross-site cookie — the preview silently fails there.
 */
export function HlsPlayer({ src, className, unsupportedMessage }: HlsPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [supported, setSupported] = useState(true);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;

    if (Hls.isSupported()) {
      setSupported(true);

      let current: Hls | null = null;
      let rebuildTimer: ReturnType<typeof setTimeout> | undefined;
      let failures = 0;
      let mediaRecoveries = 0;
      let disposed = false;
      // Whether `current` ever reached MEDIA_ATTACHED (i.e. its MediaSource actually opened).
      // Reset by every build(); see buildDeferredWhileHidden below for why this is tracked.
      let attached = false;

      /**
       * Why a full rebuild and not `hls.startLoad()` (which is what this component used to do, and
       * what left the preview spinning forever until a manual page reload):
       *
       *  - hls.js never retries a 4xx at all (`retryForHttpStatus` in hls.js 1.7.3 excludes
       *    400-499), and the playlist loader marks a failed MANIFEST load `fatal`. So MediaMTX's
       *    perfectly normal on-demand 404 during the startup window goes straight to a fatal
       *    `MANIFEST_LOAD_ERROR` — no amount of `manifestLoadPolicy` tuning changes that.
       *  - `startLoad()` cannot recover from it: with no manifest ever parsed there is no level, so
       *    `LevelController.startLoad()` -> `loadPlaylist()` -> `shouldLoadPlaylist(undefined)` is
       *    a no-op. It never re-requests `index.m3u8`, so the player is dead permanently.
       *  - Even once a manifest HAS parsed, `startLoad()` reloads the SAME level URI — and MediaMTX
       *    bakes a `?session=<uuid>` into every child reference. That session id is the credential
       *    for child requests, and MediaMTX destroys it with its muxer (verified: 60s idle, or a
       *    source drop). Re-requesting a destroyed session's URL returns 401 forever; only a fresh
       *    `index.m3u8` mints a session that works.
       *
       * Destroying and recreating is therefore the only recovery that actually re-mints a session.
       */
      const scheduleRebuild = () => {
        if (disposed || rebuildTimer !== undefined) return;
        const delay = REBUILD_DELAYS_MS[Math.min(failures, REBUILD_DELAYS_MS.length - 1)];
        failures += 1;
        rebuildTimer = setTimeout(() => {
          rebuildTimer = undefined;
          build();
        }, delay);
      };

      /**
       * Chrome DEFERS a media element's load entirely while the document is hidden. The element
       * goes to `networkState === NETWORK_LOADING` and stops there: the MediaSource `attachMedia()`
       * handed it never leaves `readyState === 'closed'`, so `sourceopen` — and therefore hls.js's
       * `MEDIA_ATTACHED` — never fires. hls.js has no error path for that; `StreamController`'s
       * 100ms tick returns at its very FIRST gate (`!media && (startFragRequested ||
       * !config.startFragPrefetch)` in `doTickIdle`) on every single tick, silently. The visible
       * result is a player that loads `index.m3u8` and then refreshes the media playlist every
       * ~2s forever, with `readyState === 0`, no `FRAG_LOADING`, and no `ERROR` event to hang a
       * recovery off — which is exactly how this looked when it was reported.
       *
       * Reproduced and confirmed against the real stack (real MediaMTX 1.21.0 + the real persistent
       * encoder + real hls.js + real headless Chrome): with the page hidden, 0 fragment requests in
       * 15s; `bringToFront()` on the SAME instance opened the MediaSource and produced
       * FRAG_LOADING/FRAG_LOADED immediately. See CLAUDE.md's "Local relay (MediaMTX)" section.
       *
       * So: don't build a player that physically cannot load. Wait for the page to be visible.
       * That also stops a hidden tab from polling the media playlist every 2s forever, which is
       * what keeps MediaMTX's on-demand HLS muxer alive (and its CPU spent) for nobody.
       */
      const buildDeferredWhileHidden = () =>
        typeof document !== 'undefined' && document.hidden;

      const build = () => {
        if (disposed) return;
        // Destroyed here rather than inside the ERROR handler, so hls.js is never torn down from
        // inside its own event dispatch.
        current?.destroy();
        current = null;
        mediaRecoveries = 0;
        attached = false;

        // onVisible() below picks this up again the moment the page is shown.
        if (buildDeferredWhileHidden()) return;

        const hls = new Hls({
          xhrSetup: (xhr: XMLHttpRequest) => { xhr.withCredentials = true; },
          // The relay keeps 7 short segments; there is no long back-buffer worth holding on to for a
          // live monitor view.
          backBufferLength: 30,
        });
        current = hls;

        // A parsed manifest means this rebuild reached a live muxer: forget the accumulated backoff
        // so a LATER failure recovers just as fast as the first one did.
        hls.on(Hls.Events.MANIFEST_PARSED, () => { failures = 0; });

        // The MediaSource actually opened, so this instance can load fragments. Without this,
        // onVisible() below cannot tell a healthy player from one Chrome never started.
        hls.on(Hls.Events.MEDIA_ATTACHED, () => { attached = true; });

        hls.on(Hls.Events.ERROR, (_event: unknown, data: { type: string; fatal: boolean }) => {
          if (!data.fatal) return;
          // A media error is the one class hls.js can genuinely repair in place. Give it one
          // attempt; a second fatal media error on the same instance means in-place recovery is not
          // working, so fall through to a rebuild rather than looping on it.
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRecoveries === 0) {
            mediaRecoveries += 1;
            hls.recoverMediaError();
            return;
          }
          scheduleRebuild();
        });

        hls.attachMedia(video);
        hls.loadSource(src);
      };

      /**
       * Deliberately one-directional: becoming visible can START a player, but becoming hidden
       * never STOPS one. A player that already attached keeps buffering in a background tab, which
       * is what a viewer who tabs away mid-preview expects; tearing it down would cost them a
       * fresh MediaMTX session and several seconds of re-buffering every time.
       *
       * `!attached` covers both halves: the build() that was deferred above (current === null), and
       * an instance that WAS built while visible but went hidden before its MediaSource opened.
       */
      const onVisible = () => {
        if (disposed || buildDeferredWhileHidden() || attached) return;
        if (rebuildTimer !== undefined) {
          clearTimeout(rebuildTimer);
          rebuildTimer = undefined;
        }
        build();
      };
      document.addEventListener('visibilitychange', onVisible);

      build();

      return () => {
        disposed = true;
        document.removeEventListener('visibilitychange', onVisible);
        if (rebuildTimer !== undefined) clearTimeout(rebuildTimer);
        current?.destroy();
        current = null;
      };
    }

    // Safari and other native-HLS browsers: no MSE needed, the element plays the playlist itself.
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      setSupported(true);
      video.src = src;
      return undefined;
    }

    setSupported(false);
    return undefined;
  }, [src]);

  return (
    <div className={className}>
      <video
        ref={videoRef}
        data-testid="hls-video"
        controls
        muted
        playsInline
        autoPlay
        className="w-full rounded bg-black"
      />
      {!supported && <p className="mt-2 text-sm text-red-600">{unsupportedMessage}</p>}
    </div>
  );
}
