import { useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';

export interface HlsPlayerProps {
  src: string;
  className?: string;
  unsupportedMessage: string;
}

/**
 * Plays the backend's proxied HLS preview.
 *
 * Two things here are load-bearing and must not be "simplified" away:
 *  - `xhrSetup` sets `withCredentials`. The playlist and every segment are cross-origin requests to
 *    the API, and the backend resolves WHICH stream to serve from the session cookie — without
 *    this, every request 401s and the player just shows an error with no obvious cause.
 *  - A fatal network error calls `startLoad()` again rather than surfacing a failure. The relay
 *    muxes HLS on demand, so the first playlist request after a start legitimately 404s for a
 *    moment.
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
      const hls = new Hls({
        xhrSetup: (xhr: XMLHttpRequest) => { xhr.withCredentials = true; },
        // The relay keeps 7 short segments; there is no long back-buffer worth holding on to for a
        // live monitor view.
        backBufferLength: 30,
      });
      hls.on(Hls.Events.ERROR, (_event: unknown, data: { type: string; fatal: boolean }) => {
        if (!data.fatal) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          hls.startLoad();
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          hls.recoverMediaError();
        }
      });
      hls.attachMedia(video);
      hls.loadSource(src);
      return () => hls.destroy();
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
