const renderViaPoolMock = jest.fn();
const readImageAsDataUriMock = jest.fn();

jest.mock('../../src/render/renderWorkerPool', () => ({ renderViaPool: renderViaPoolMock }));
jest.mock('../../src/render/imageDataUri', () => ({ readImageAsDataUri: readImageAsDataUriMock }));

import { renderTemplatePng } from '../../src/render/renderOverlay';

describe('renderTemplatePng', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    renderViaPoolMock.mockResolvedValue(Buffer.from('fake-png'));
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('skips only the image asset whose file fails to read, instead of failing the whole render', async () => {
    readImageAsDataUriMock.mockImplementation((filePath: string) => {
      if (filePath === '/cover.png') return Promise.resolve('data:image/png;base64,cover');
      if (filePath === '/good.png') return Promise.resolve('data:image/png;base64,good');
      if (filePath === '/missing.png') return Promise.reject(new Error('ENOENT: no such file'));
      throw new Error(`unexpected path ${filePath}`);
    });

    const result = await renderTemplatePng({
      elements: [],
      title: 'Track title',
      playlistLines: [],
      coverPath: '/cover.png',
      width: 1280,
      height: 720,
      fontPath: '/font.ttf',
      fontFamily: 'DejaVu Sans',
      imageAssets: { imgGood: '/good.png', imgBad: '/missing.png' },
    });

    expect(result).toEqual(Buffer.from('fake-png'));
    expect(renderViaPoolMock).toHaveBeenCalledTimes(1);
    const [, scene] = renderViaPoolMock.mock.calls[0];
    expect(scene.imageDataUris).toEqual({ imgGood: 'data:image/png;base64,good' });
    expect(scene.imageDataUris.imgBad).toBeUndefined();
    expect(scene.coverDataUri).toBe('data:image/png;base64,cover');

    // Debuggable, not silently wrong — matches the "falling back to a blank overlay" logging
    // convention in buildStreamScene()'s buildOverlay (src/stream/streamScene.ts).
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('imgBad'),
      expect.any(Error),
    );
  });
});
