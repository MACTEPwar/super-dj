import { CustomRtmpProvider } from '../../src/destinations/customRtmpProvider';
import { encrypt } from '../../src/crypto/streamKeyCipher';

const KEY = 'a'.repeat(64);

describe('CustomRtmpProvider', () => {
  it('decrypts the stored stream key and returns it alongside rtmpUrl, with no lifecycle', async () => {
    const provider = new CustomRtmpProvider(KEY);
    const destination: any = { rtmpUrl: 'rtmp://example.com/live', streamKeyEncrypted: encrypt('secret-key', KEY) };

    const session = await provider.prepareSession(destination, { title: 'ignored' });

    expect(session).toEqual({ rtmpUrl: 'rtmp://example.com/live', streamKey: 'secret-key' });
    expect(session.lifecycle).toBeUndefined();
  });

  it('throws if the destination is missing rtmpUrl/streamKeyEncrypted', async () => {
    const provider = new CustomRtmpProvider(KEY);
    const destination: any = { rtmpUrl: null, streamKeyEncrypted: null };

    await expect(provider.prepareSession(destination, { title: 'x' })).rejects.toThrow();
  });
});
