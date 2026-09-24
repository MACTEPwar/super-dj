import { HttpMediaSearchClient, MediaSearchError } from '../../src/media/mediaSearchClient';

function fakeFetch(response: Partial<Response> & { ok: boolean; status: number }): typeof fetch {
  return jest.fn().mockResolvedValue(response) as unknown as typeof fetch;
}

describe('HttpMediaSearchClient', () => {
  it('fetches audio and returns it as a Buffer', async () => {
    const bytes = new Uint8Array([0x49, 0x44, 0x33]); // "ID3"
    const fetchImpl = fakeFetch({ ok: true, status: 200, arrayBuffer: async () => bytes.buffer } as Response);
    const client = new HttpMediaSearchClient('http://192.168.14.26:8010', fetchImpl);

    const result = await client.fetchAudio('Blur - Song 2');

    expect(fetchImpl).toHaveBeenCalledWith('http://192.168.14.26:8010/download/audio?query=Blur%20-%20Song%202');
    expect(Buffer.compare(result, Buffer.from(bytes))).toBe(0);
  });

  it('throws MediaSearchError with the service\'s detail message on a non-2xx response', async () => {
    const fetchImpl = fakeFetch({
      ok: false, status: 502, json: async () => ({ detail: 'Ошибка подготовки файла или результат не найден' }),
    } as Response);
    const client = new HttpMediaSearchClient('http://192.168.14.26:8010', fetchImpl);

    await expect(client.fetchAudio('nonexistent track')).rejects.toThrow(MediaSearchError);
    await expect(client.fetchAudio('nonexistent track')).rejects.toThrow('Ошибка подготовки файла или результат не найден');
  });

  it('falls back to the HTTP status text when the error body is not JSON', async () => {
    const fetchImpl = fakeFetch({
      ok: false, status: 504, statusText: 'Gateway Timeout', json: async () => { throw new Error('not json'); },
    } as unknown as Response);
    const client = new HttpMediaSearchClient('http://192.168.14.26:8010', fetchImpl);

    await expect(client.fetchAudio('slow track')).rejects.toThrow('Gateway Timeout');
  });
});
