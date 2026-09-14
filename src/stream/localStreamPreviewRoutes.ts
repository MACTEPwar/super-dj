import { Request, Response, Router } from 'express';
import { pipeline, Readable } from 'stream';
import { ApiError } from '../errors';
import { wrapAsync } from '../api/errorHandler';
import { requireAuth, AuthenticatedRequest } from '../auth/authMiddleware';
import { AuthService } from '../auth/authService';
import { LocalStreamManager } from './localStreamManager';

// A deliberately tiny HTTP-client seam, injected rather than mocked: matches this repo's existing
// fake-injection testing style (Spawner, repositories) instead of pulling in a mocking library.
// The default implementation (createPreviewFetch in server.ts) adapts global fetch to it.
export interface PreviewFetchResponse {
  status: number;
  contentType: string | null;
  // A Node readable so the route can pipe it straight through without buffering a whole segment.
  body: NodeJS.ReadableStream | null;
}

export type PreviewFetch = (
  url: string,
  init: { headers: Record<string, string> },
) => Promise<PreviewFetchResponse>;

// Exactly the artefacts MediaMTX's HLS muxer serves: a playlist, an MPEG-TS segment, or an fMP4
// init/segment/part (kept for a future hlsVariant change). Anchored, no dots beyond the single
// extension, no path separators, no spaces — so nothing here can walk out of the stream's own
// directory or address a MediaMTX endpoint that is not part of this path's HLS output.
const ALLOWED_FILE = /^[A-Za-z0-9][A-Za-z0-9_-]*\.(m3u8|ts|mp4|m4s)$/;

const CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
  m3u8: 'application/vnd.apple.mpegurl',
  ts: 'video/mp2t',
  mp4: 'video/mp4',
  m4s: 'video/iso.segment',
};

/**
 * The preview leg of the spec's "Layer 3": the browser's only route to the stream, and the one leg
 * with no MediaMTX-native enforcement the browser could satisfy on its own.
 *
 * Two rules make it safe, and both must survive any future edit:
 *  1. The client NEVER names a MediaMTX path or token. The path is resolved from req.user.id. A
 *     variant that took a path/token parameter would be one IDOR away from cross-tenant viewing.
 *  2. The proxy still presents the session's read credential upstream, so authHTTP applies even to
 *     our own traffic — defense in depth against a misconfiguration here.
 *
 * Known limitation, documented rather than solved in this iteration: iOS Safari plays HLS with its
 * native player, which fetches the playlist itself and will not attach a cross-site cookie, so the
 * preview silently fails there. A short-lived signed query token would fix it later.
 */
export function createLocalStreamPreviewRouter(
  authService: AuthService,
  localStreamManager: Pick<LocalStreamManager, 'previewTarget'>,
  previewFetch: PreviewFetch,
): Router {
  const router = Router();
  const auth = requireAuth(authService);

  async function proxy(req: Request, res: Response, fileName: string): Promise<void> {
    if (!ALLOWED_FILE.test(fileName)) throw new ApiError(400, 'invalid preview file name');

    const userId = (req as AuthenticatedRequest).user!.id;
    const target = localStreamManager.previewTarget(userId);
    if (!target) throw new ApiError(409, 'local stream is not active');

    let upstream: PreviewFetchResponse;
    try {
      upstream = await previewFetch(`${target.hlsBaseUrl}/${fileName}`, {
        headers: { Authorization: target.authorization },
      });
    } catch (err) {
      // Never surface the upstream error verbatim: its message carries the MediaMTX host and the
      // session's path token.
      console.error('[local-stream] preview upstream request failed', err);
      throw new ApiError(502, 'preview is temporarily unavailable');
    }

    // MediaMTX muxes HLS on demand, so a 404 right after a start just means "the muxer has not
    // produced a playlist yet" — pass the status through and let the player retry rather than
    // inventing a different one.
    if (upstream.status < 200 || upstream.status > 299 || !upstream.body) {
      res.status(upstream.status).end();
      return;
    }

    const extension = fileName.slice(fileName.lastIndexOf('.') + 1);
    res.status(200);
    res.setHeader('Content-Type', upstream.contentType ?? CONTENT_TYPE_BY_EXTENSION[extension] ?? 'application/octet-stream');
    // Live playlists and segments are session-scoped and short-lived; nothing in this response may
    // ever be cached by a browser or an intermediary and replayed for a different user.
    res.setHeader('Cache-Control', 'no-store');

    // Plain `.pipe()` attaches no 'error' listener to the SOURCE — an 'error' event with no
    // listener is an uncaught exception in Node, which would crash the whole process (every
    // tenant's active stream, not just this preview request). See server.ts's own stderr-forwarder
    // comment for the same hazard already documented in this codebase. `pipeline` wires that
    // listener for us. Also destroy the upstream body on client disconnect (closing the preview
    // tab) so we don't leak a socket to MediaMTX and keep an on-demand muxer alive forever.
    const body = upstream.body;
    // NodeJS.ReadableStream (the interface PreviewFetchResponse.body is typed as, to stay
    // implementation-agnostic for callers) only extends EventEmitter and doesn't declare
    // destroy() — but every real implementation (fetch's Node body, this file's own tests) is a
    // stream.Readable, which does have one.
    res.on('close', () => { if (!res.writableEnded) (body as Readable).destroy(); });
    pipeline(body, res, (err) => {
      if (err) console.error('[local-stream] preview pipe failed', err);
    });
  }

  // The multivariant playlist, and the only URL the frontend ever constructs itself. Declared
  // before /:file so the intent is explicit; both go through the same handler.
  router.get('/index.m3u8', auth, wrapAsync(async (req, res) => proxy(req, res, 'index.m3u8')));

  // Everything the playlists reference. MediaMTX emits RELATIVE references (stream.m3u8,
  // segment0.ts), so mounting this route as a sibling of index.m3u8 makes them resolve correctly
  // with no playlist rewriting at all.
  router.get('/:file', auth, wrapAsync(async (req, res) => proxy(req, res, req.params.file)));

  return router;
}
