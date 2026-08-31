import { encrypt, decrypt } from '../../src/crypto/streamKeyCipher';

const KEY = 'a'.repeat(64); // 32 bytes, hex-encoded

describe('streamKeyCipher', () => {
  it('encrypts and decrypts a round trip', () => {
    const ciphertext = encrypt('my-secret-stream-key', KEY);
    expect(ciphertext).not.toContain('my-secret-stream-key');
    expect(decrypt(ciphertext, KEY)).toBe('my-secret-stream-key');
  });

  it('produces different ciphertext for the same plaintext (random IV)', () => {
    const a = encrypt('same-value', KEY);
    const b = encrypt('same-value', KEY);
    expect(a).not.toBe(b);
  });

  it('fails to decrypt with the wrong key', () => {
    const ciphertext = encrypt('my-secret-stream-key', KEY);
    const wrongKey = 'b'.repeat(64);
    expect(() => decrypt(ciphertext, wrongKey)).toThrow();
  });
});
