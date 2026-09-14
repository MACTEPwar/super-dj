import express from 'express';
import request from 'supertest';
import { Readable } from 'stream';
import { createLocalStreamPreviewRouter, PreviewFetch } from '../../src/stream/localStreamPreviewRoutes';
import { errorHandler } from '../../src/api/errorHandler';

const TOKEN = 'd'.repeat(32);

function buildApp(opts: {
  previewTarget?: unknown;
  previewFetch?: PreviewFetch;
  userId?: string | null;
} = {}) {
  const authService: any = {
    getCurrentUser: jest.fn().mockResolvedValue(
      opts.userId === null ? null : { id: opts.userId ?? 'user-1', email: 'a@example.com' },
    ),
  };
  const localStreamManager: any = {
    previewTarget: jest.fn().mockReturnValue(
      opts.previewTarget === undefined
        ? { hlsBaseUrl: `http://mediamtx:8888/live/${TOKEN}`, authorization: 'Basic c3ViOnM=' }
        : opts.previewTarget,
    ),
  };
  const previewFetch: PreviewFetch = opts.previewFetch ?? jest.fn().mockResolvedValue({
    status: 200,
    contentType: 'application/vnd.apple.mpegurl',
    body: Readable.from(['#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nstream.m3u8\n']),
  });
  const app = express();
  app.use('/local-stream/preview', createLocalStreamPreviewRouter(authService, localStreamManager, previewFetch));
  app.use(errorHandler);
  return { app, previewFetch: previewFetch as jest.Mock, localStreamManager, authService };
}

describe('GET /local-stream/preview', () => {
  it('requires authentication', async () => {
    const { app, previewFetch } = buildApp({ userId: null });
    const res = await request(app).get('/local-stream/preview/index.m3u8');
    expect(res.status).toBe(401);
    expect(previewFetch).not.toHaveBeenCalled();
  });

  // The single most important rule in the spec's security section: the client never names a path.
  // The token is resolved from the authenticated user's own stream, server-side.
  it('resolves the MediaMTX path from the authenticated user and presents the read credential', async () => {
    const { app, previewFetch, localStreamManager } = buildApp({ userId: 'user-7' });
    const res = await request(app).get('/local-stream/preview/index.m3u8');
    expect(res.status).toBe(200);
    expect(localStreamManager.previewTarget).toHaveBeenCalledWith('user-7');
    expect(previewFetch).toHaveBeenCalledWith(
      `http://mediamtx:8888/live/${TOKEN}/index.m3u8`,
      { headers: { Authorization: 'Basic c3ViOnM=' } },
    );
  });

  it('streams the playlist body back with the upstream content type and no caching', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/local-stream/preview/index.m3u8');
    expect(res.text).toContain('#EXTM3U');
    expect(res.headers['content-type']).toContain('application/vnd.apple.mpegurl');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('proxies a media playlist and a segment by name', async () => {
    const { app, previewFetch } = buildApp();
    await request(app).get('/local-stream/preview/stream.m3u8');
    expect(previewFetch).toHaveBeenLastCalledWith(`http://mediamtx:8888/live/${TOKEN}/stream.m3u8`, expect.anything());
    await request(app).get('/local-stream/preview/segment7.ts');
    expect(previewFetch).toHaveBeenLastCalledWith(`http://mediamtx:8888/live/${TOKEN}/segment7.ts`, expect.anything());
  });

  it('falls back to a content type derived from the extension when upstream sends none', async () => {
    const previewFetch = jest.fn().mockResolvedValue({ status: 200, contentType: null, body: Readable.from(['x']) });
    const { app } = buildApp({ previewFetch });
    const res = await request(app).get('/local-stream/preview/segment0.ts');
    expect(res.headers['content-type']).toContain('video/mp2t');
  });

  it('returns 409 when this user has no active local stream', async () => {
    const { app, previewFetch } = buildApp({ previewTarget: null });
    const res = await request(app).get('/local-stream/preview/index.m3u8');
    expect(res.status).toBe(409);
    expect(previewFetch).not.toHaveBeenCalled();
  });

  it('rejects any file name that is not a plain HLS artefact', async () => {
    const { app, previewFetch } = buildApp();
    for (const name of ['..', '..%2Fmediamtx.yml', 'evil.sh', 'stream.m3u8.bak', '.env', 'seg ment.ts']) {
      const res = await request(app).get(`/local-stream/preview/${name}`);
      expect([400, 404]).toContain(res.status);
    }
    expect(previewFetch).not.toHaveBeenCalled();
  });

  // MediaMTX muxes HLS on demand (hlsAlwaysRemux: no), so the first playlist request after a start
  // can legitimately 404 for a moment. Pass it through so the player can retry, rather than
  // dressing it up as a 500.
  it('mirrors a non-2xx upstream status without a body', async () => {
    const previewFetch = jest.fn().mockResolvedValue({ status: 404, contentType: null, body: null });
    const { app } = buildApp({ previewFetch });
    const res = await request(app).get('/local-stream/preview/index.m3u8');
    expect(res.status).toBe(404);
    expect(res.text).toBe('');
  });

  it('never echoes the upstream URL or the read credential to the client', async () => {
    const previewFetch = jest.fn().mockRejectedValue(new Error(`connect ECONNREFUSED http://mediamtx:8888/live/${TOKEN}`));
    const { app } = buildApp({ previewFetch });
    const res = await request(app).get('/local-stream/preview/index.m3u8');
    expect(res.status).toBe(502);
    expect(JSON.stringify(res.body)).not.toContain(TOKEN);
    expect(JSON.stringify(res.body)).not.toContain('Basic');
  });

  // Plain `.pipe()` leaves the upstream Readable with no 'error' listener — an unhandled 'error'
  // event is an uncaught exception in Node, which crashes the WHOLE process (every tenant's
  // active stream, not just this request). A body that errors mid-stream (MediaMTX restarts, the
  // muxer closes after hlsMuxerCloseAfter, a socket reset) must not be able to do that.
  it('does not crash the process when the upstream body errors mid-stream', async () => {
    const body = new Readable({ read() {} });
    const previewFetch = jest.fn().mockResolvedValue({ status: 200, contentType: 'video/mp2t', body });
    const { app } = buildApp({ previewFetch });
    const reqPromise = request(app).get('/local-stream/preview/segment0.ts');
    // supertest's Test object is a lazy thenable: the request is not actually dispatched until
    // something calls .then()/.end() on it. Trigger that dispatch now (swallowing this handler so
    // we don't get a spurious unhandled-rejection warning; the real result is awaited below off
    // the same cached promise) and give the real loopback round trip a couple of ticks to reach
    // our route and attach pipeline()'s listener, so the error below lands on a body the route is
    // actually consuming — not one nobody has looked at yet.
    reqPromise.catch(() => {});
    await new Promise((r) => setTimeout(r, 100));
    body.push('partial-segment-bytes');
    body.emit('error', new Error('ECONNRESET'));
    body.push(null);
    // pipeline() correctly destroys the now-broken response, so the client legitimately sees its
    // connection reset (`await reqPromise` on its own would reject with exactly that, matching a
    // real HLS player losing one segment fetch and retrying) — that per-request rejection is a
    // normal, expected outcome, not the hazard under test. The hazard is a process-wide uncaught
    // exception (which would take down every tenant's stream, not just this request); it has no
    // promise to await at all, so the only way to prove its absence here is that this whole test
    // file — including the requests still in flight after it — runs to completion. Swallow this
    // one request's own rejection accordingly.
    await reqPromise.catch(() => {});
  });
});
