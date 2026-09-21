export interface MediaSearchClient {
  fetchAudio(query: string): Promise<Buffer>;
}

export class MediaSearchError extends Error {}

// Talks to the streamer's own media-search microservice — GET {baseUrl}/download/audio?query=.
// Verified against the real running service: 200 with content-type audio/mpeg and raw mp3 bytes
// on success; 400/502/504 with a JSON {"detail": "..."} body on failure (see the design spec).
export class HttpMediaSearchClient implements MediaSearchClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async fetchAudio(query: string): Promise<Buffer> {
    const url = `${this.baseUrl}/download/audio?query=${encodeURIComponent(query)}`;
    const response = await this.fetchImpl(url);

    if (!response.ok) {
      let detail = response.statusText;
      try {
        const body = (await response.json()) as { detail?: string };
        if (body.detail) detail = body.detail;
      } catch {
        // Not a JSON body — keep the HTTP status text.
      }
      throw new MediaSearchError(`media search service returned ${response.status}: ${detail}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }
}
