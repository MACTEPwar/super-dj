import express, { Express, NextFunction, Request, Response } from 'express';
import { timingSafeEqual } from 'crypto';
import { LocalRelaySession, LOCAL_RELAY_PUBLISH_USER, LOCAL_RELAY_READ_USER } from './localRelayTarget';

// The JSON body MediaMTX POSTs for every publish/read attempt. Field names copied from
// internal/auth/manager.go in the pinned v1.21.0 source. Everything is `unknown` because this is
// the untrusted edge of the system: MediaMTX is the only expected caller, but the endpoint must
// behave correctly for any body at all.
export interface MediaMtxAuthRequestBody {
  user?: unknown;
  password?: unknown;
  token?: unknown;
  ip?: unknown;
  action?: unknown;
  path?: unknown;
  protocol?: unknown;
  id?: unknown;
  query?: unknown;
  userAgent?: unknown;
}

interface RegisteredPath {
  userId: string;
  publishSecret: string;
  readSecret: string;
}

// Constant-time compare that never throws and never leaks length through an early return path
// other than the unavoidable length check itself (secrets here are fixed-length hex, so a length
// mismatch already means "not our secret").
function secretEquals(candidate: string, expected: string): boolean {
  const a = Buffer.from(candidate, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * The policy half of the spec's "Layer 2". MediaMTX has no idea this app has users; this map is
 * the entire trust decision, held in memory so that stopping a stream revokes its credentials
 * instantly (unlike a JWT, which stays valid until it expires) and so that adding or removing a
 * session never requires a MediaMTX config reload.
 *
 * Fail-closed by construction: an unregistered path, an unknown action, or a body that isn't the
 * shape we expect all return false.
 */
export class MediaMtxAuthRegistry {
  private readonly paths = new Map<string, RegisteredPath>();

  register(session: LocalRelaySession): void {
    this.paths.set(session.path, {
      userId: session.userId,
      publishSecret: session.publishSecret,
      readSecret: session.readSecret,
    });
  }

  unregister(path: string): void {
    this.paths.delete(path);
  }

  authorize(body: MediaMtxAuthRequestBody): boolean {
    const path = asString(body.path);
    if (path === null) return false;
    const entry = this.paths.get(path);
    if (!entry) return false;

    const user = asString(body.user);
    const password = asString(body.password);
    if (user === null || password === null) return false;

    // Only these two actions exist for this app. 'playback', 'api', 'metrics' and 'pprof' are
    // denied here as well as being disabled in docker/mediamtx.yml — two independent locks.
    if (body.action === 'publish') {
      return user === LOCAL_RELAY_PUBLISH_USER && secretEquals(password, entry.publishSecret);
    }
    if (body.action === 'read') {
      return user === LOCAL_RELAY_READ_USER && secretEquals(password, entry.readSecret);
    }
    return false;
  }
}

/**
 * The HTTP half of Layer 2, deliberately a SEPARATE Express app from the public API: it listens on
 * its own unpublished port (see docker-compose.yml — MediaMTX reaches it by service name only) and
 * has no cookie/session middleware, because MediaMTX is not a browser and cannot use requireAuth.
 *
 * The shared secret travels as a PATH SEGMENT rather than a header: MediaMTX sets no custom
 * headers on its auth POST and substitutes no placeholders in authHTTPAddress (verified in
 * internal/auth/manager.go), so a header-borne secret is not possible. It is supplied via
 * MTX_AUTHHTTPADDRESS so it never lands in a committed config file.
 */
export function createMediaMtxAuthApp(
  registry: Pick<MediaMtxAuthRegistry, 'authorize'>,
  sharedSecret: string,
): Express {
  const app = express();
  app.use(express.json());

  app.post('/internal/mediamtx-auth/:secret', (req: Request, res: Response) => {
    if (!secretEquals(req.params.secret, sharedSecret)) {
      res.status(401).end();
      return;
    }
    res.status(registry.authorize((req.body ?? {}) as MediaMtxAuthRequestBody) ? 200 : 401).end();
  });

  app.use((_req: Request, res: Response) => { res.status(404).end(); });

  // MediaMTX allows only on 2xx, so ANY failure here (a malformed body reaching express.json(),
  // an unexpected throw) must answer 401 rather than Express's default 400/500 — and must never
  // leak a stack trace to a caller we do not control.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error('[mediamtx-auth] rejecting a request that failed to parse or handle', err);
    res.status(401).end();
  });

  return app;
}
