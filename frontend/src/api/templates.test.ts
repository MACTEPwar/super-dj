import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { templatesApi, uploadTemplateImage, templateImageUrl, getFontFamilies } from './templates';

function mockFetchOnce(body: unknown) {
  (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: true, status: 200, json: async () => body });
}

describe('templates API', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('templatesApi.list GETs /templates', async () => {
    mockFetchOnce([
      { id: 't1', name: 'Default' },
      { id: 't2', name: 'Custom' },
    ]);
    const templates = await templatesApi.list();
    expect(templates).toHaveLength(2);
    expect(templates[0].name).toBe('Default');
    const [url] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('/templates');
  });

  it('templatesApi.get GETs /templates/{id}', async () => {
    mockFetchOnce({
      id: 't1',
      name: 'Test Template',
      elements: [{ type: 'cover', x: 0, y: 0, width: 100, height: 100 }],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });
    const template = await templatesApi.get('t1');
    expect(template.id).toBe('t1');
    expect(template.name).toBe('Test Template');
    const [url] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('/templates/t1');
  });

  it('templatesApi.create POSTs to /templates', async () => {
    mockFetchOnce({
      id: 't1',
      name: 'New Template',
      elements: [],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });
    const template = await templatesApi.create('New Template');
    expect(template.name).toBe('New Template');
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('/templates');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ name: 'New Template', elements: [] });
  });

  it('templatesApi.update PUTs to /templates/{id}', async () => {
    mockFetchOnce({
      id: 't1',
      name: 'Updated',
      elements: [],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-02T00:00:00Z',
    });
    const template = await templatesApi.update('t1', { name: 'Updated' });
    expect(template.name).toBe('Updated');
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('/templates/t1');
    expect(init.method).toBe('PUT');
  });

  it('templatesApi.remove DELETEs /templates/{id}', async () => {
    mockFetchOnce({});
    await templatesApi.remove('t1');
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('/templates/t1');
    expect(init.method).toBe('DELETE');
  });

  it('uploadTemplateImage POSTs multipart form data to /templates/{id}/images', async () => {
    mockFetchOnce({ assetId: 'asset-123' });
    const file = new File(['x'], 'image.png', { type: 'image/png' });
    const result = await uploadTemplateImage('t1', file);
    expect(result.assetId).toBe('asset-123');
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('/templates/t1/images');
    expect(init.method).toBe('POST');
    expect(init.body).toBeInstanceOf(FormData);
  });

  it('templateImageUrl returns the correct GET URL', () => {
    const url = templateImageUrl('t1', 'asset-123');
    expect(url).toContain('/templates/t1/images/asset-123');
  });

  it('getFontFamilies GETs /templates/fonts and extracts families array', async () => {
    mockFetchOnce({ families: ['DejaVu Sans', 'Liberation Sans'] });
    const families = await getFontFamilies();
    expect(families).toEqual(['DejaVu Sans', 'Liberation Sans']);
    const [url] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('/templates/fonts');
  });
});
