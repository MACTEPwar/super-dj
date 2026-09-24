import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tracksApi, updateTrackOverlayOverride, type TrackOverlayOverride } from './tracks';

function mockFetchOnce(body: unknown) {
  (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: true, status: 200, json: async () => body });
}

describe('tracks API', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('tracksApi.list GETs /tracks with overlayOverride field', async () => {
    mockFetchOnce([
      {
        id: 't1',
        name: 'Track A',
        durationSeconds: 180,
        hasCover: true,
        overlayOverride: null,
      },
      {
        id: 't2',
        name: 'Track B',
        durationSeconds: 240,
        hasCover: false,
        overlayOverride: {
          color: { mode: 'solid', color: '#FF0000' },
        },
      },
    ]);
    const tracks = await tracksApi.list();
    expect(tracks).toHaveLength(2);
    expect(tracks[0].overlayOverride).toBeNull();
    expect(tracks[1].overlayOverride?.color).toEqual({ mode: 'solid', color: '#FF0000' });
  });

  it('tracksApi.upload POSTs multipart form data to /tracks with overlayOverride in response', async () => {
    mockFetchOnce({
      id: 't1',
      name: 'New Track',
      durationSeconds: 180,
      hasCover: false,
      overlayOverride: null,
    });
    const audio = new File(['x'], 'a.mp3', { type: 'audio/mpeg' });
    const track = await tracksApi.upload(audio, null, 'New Track');
    expect(track.overlayOverride).toBeNull();
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('/tracks');
    expect(init.body).toBeInstanceOf(FormData);
  });

  it('tracksApi.remove DELETEs /tracks/{id}', async () => {
    mockFetchOnce({});
    await tracksApi.remove('t1');
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('/tracks/t1');
    expect(init.method).toBe('DELETE');
  });

  it('tracksApi.coverUrl returns the correct GET URL', () => {
    const url = tracksApi.coverUrl('t1');
    expect(url).toContain('/tracks/t1/cover');
  });

  it('updateTrackOverlayOverride PATCHes /tracks/{id} with solid color override', async () => {
    mockFetchOnce({});
    const override: TrackOverlayOverride = {
      color: { mode: 'solid', color: '#FFFFFF' },
    };
    await updateTrackOverlayOverride('t1', override);
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('/tracks/t1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ overlayOverride: override });
  });

  it('updateTrackOverlayOverride PATCHes /tracks/{id} with gradient color and backgroundColor', async () => {
    mockFetchOnce({});
    const override: TrackOverlayOverride = {
      color: { mode: 'gradient', gradientType: 'linear', angleDeg: 45,
        stops: [{ color: '#FF0000', offset: 0 }, { color: '#00FF00', offset: 50 }, { color: '#0000FF', offset: 100 }] },
      backgroundColor: { mode: 'solid', color: '#000000' },
    };
    await updateTrackOverlayOverride('t1', override);
    const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ overlayOverride: override });
  });

  it('updateTrackOverlayOverride PATCHes /tracks/{id} with null to clear override', async () => {
    mockFetchOnce({});
    await updateTrackOverlayOverride('t1', null);
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('/tracks/t1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ overlayOverride: null });
  });

  describe('tracksApi.searchPreview', () => {
    it('POSTs the query to /tracks/search-preview and returns the previewId', async () => {
      mockFetchOnce({ previewId: 'p1' });
      const result = await tracksApi.searchPreview('Blur - Song 2');
      const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toContain('/tracks/search-preview');
      expect(JSON.parse(init.body)).toEqual({ query: 'Blur - Song 2' });
      expect(result).toEqual({ previewId: 'p1' });
    });
  });

  describe('tracksApi.previewUrl', () => {
    it('builds the preview streaming URL', () => {
      expect(tracksApi.previewUrl('p1')).toContain('/tracks/preview/p1');
    });
  });

  describe('tracksApi.confirmPreview', () => {
    it('POSTs a multipart form with name and cover to /tracks/from-preview/{id}', async () => {
      mockFetchOnce({ id: 't1', name: 'x', durationSeconds: 1, hasCover: true, overlayOverride: null });
      const cover = new File(['data'], 'cover.png', { type: 'image/png' });
      await tracksApi.confirmPreview('p1', 'My Song', cover);
      const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toContain('/tracks/from-preview/p1');
      expect(init.body).toBeInstanceOf(FormData);
      const form = init.body as FormData;
      expect(form.get('name')).toBe('My Song');
      expect(form.get('cover')).toBe(cover);
    });

    it('omits name/cover from the form when not given', async () => {
      mockFetchOnce({ id: 't1', name: 'x', durationSeconds: 1, hasCover: false, overlayOverride: null });
      await tracksApi.confirmPreview('p1', undefined, null);
      const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      const form = init.body as FormData;
      expect(form.has('name')).toBe(false);
      expect(form.has('cover')).toBe(false);
    });
  });

  describe('tracksApi.discardPreview', () => {
    it('DELETEs /tracks/preview/{id}', async () => {
      mockFetchOnce({});
      await tracksApi.discardPreview('p1');
      const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toContain('/tracks/preview/p1');
      expect(init.method).toBe('DELETE');
    });
  });
});
