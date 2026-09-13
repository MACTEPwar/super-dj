import { LocalRelayTarget, LOCAL_RELAY_PUBLISH_USER, LOCAL_RELAY_READ_USER } from '../../src/stream/localRelayTarget';

function fixed(base: Partial<{ token: string; secrets: string[] }> = {}) {
  const secrets = [...(base.secrets ?? ['pubsecret', 'readsecret'])];
  return new LocalRelayTarget({
    rtmpBaseUrl: 'rtmp://mediamtx:1935',
    hlsBaseUrl: 'http://mediamtx:8888',
    generateToken: () => base.token ?? 'a'.repeat(32),
    generateSecret: () => secrets.shift() ?? 'exhausted',
  });
}

describe('LocalRelayTarget', () => {
  it('mints a path of the exact shape MediaMTX\'s regex path accepts', () => {
    const session = new LocalRelayTarget({ rtmpBaseUrl: 'rtmp://mediamtx:1935', hlsBaseUrl: 'http://mediamtx:8888' }).create('user-1');
    expect(session.pathToken).toMatch(/^[0-9a-f]{32}$/);
    expect(session.path).toBe(`live/${session.pathToken}`);
  });

  // The whole point of the "zero signature change" claim: buildPersistentEncoderArgs concatenates
  // `${rtmpUrl}/${streamKey}`, and MediaMTX v1.21.0 reads RTMP credentials from the QUERY STRING
  // (internal/servers/rtmp/conn.go: query.Get("user")/query.Get("pass")), not from URL userinfo.
  it('splits the publish URL so the existing rtmpUrl/streamKey concatenation yields a credentialed URL', () => {
    const session = fixed().create('user-1');
    expect(session.publishRtmpUrl).toBe('rtmp://mediamtx:1935/live');
    expect(session.publishStreamKey).toBe(`${'a'.repeat(32)}?user=pub&pass=pubsecret`);
    expect(`${session.publishRtmpUrl}/${session.publishStreamKey}`)
      .toBe(`rtmp://mediamtx:1935/live/${'a'.repeat(32)}?user=pub&pass=pubsecret`);
  });

  it('mints a read credential that differs from the publish one, so a leaked reader can never publish', () => {
    const session = fixed().create('user-1');
    expect(session.publishSecret).toBe('pubsecret');
    expect(session.readSecret).toBe('readsecret');
    expect(session.readSecret).not.toBe(session.publishSecret);
    expect(session.readRtmpUrl).toBe(`rtmp://mediamtx:1935/live/${'a'.repeat(32)}?user=sub&pass=readsecret`);
  });

  it('exposes the HLS base URL and a Basic credential for the backend-side preview proxy', () => {
    const session = fixed().create('user-1');
    expect(session.hlsBaseUrl).toBe(`http://mediamtx:8888/live/${'a'.repeat(32)}`);
    expect(session.readAuthorization).toBe(`Basic ${Buffer.from('sub:readsecret').toString('base64')}`);
  });

  it('normalises trailing slashes on both base URLs', () => {
    const target = new LocalRelayTarget({
      rtmpBaseUrl: 'rtmp://mediamtx:1935/', hlsBaseUrl: 'http://mediamtx:8888/',
      generateToken: () => 'b'.repeat(32), generateSecret: () => 's',
    });
    const session = target.create('user-1');
    expect(session.publishRtmpUrl).toBe('rtmp://mediamtx:1935/live');
    expect(session.hlsBaseUrl).toBe(`http://mediamtx:8888/live/${'b'.repeat(32)}`);
  });

  it('carries the owning userId and uses the agreed usernames', () => {
    const session = fixed().create('user-42');
    expect(session.userId).toBe('user-42');
    expect(LOCAL_RELAY_PUBLISH_USER).toBe('pub');
    expect(LOCAL_RELAY_READ_USER).toBe('sub');
  });

  it('mints a different token on every create, so a path never outlives its session', () => {
    const target = new LocalRelayTarget({ rtmpBaseUrl: 'rtmp://mediamtx:1935', hlsBaseUrl: 'http://mediamtx:8888' });
    expect(target.create('user-1').pathToken).not.toBe(target.create('user-1').pathToken);
  });

  it('mints secrets containing only URL-safe characters (they travel in an RTMP query string)', () => {
    const target = new LocalRelayTarget({ rtmpBaseUrl: 'rtmp://mediamtx:1935', hlsBaseUrl: 'http://mediamtx:8888' });
    const session = target.create('user-1');
    expect(session.publishSecret).toMatch(/^[0-9a-f]{48}$/);
    expect(session.readSecret).toMatch(/^[0-9a-f]{48}$/);
  });
});
