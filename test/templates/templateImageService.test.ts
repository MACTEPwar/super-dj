import { TemplateImageService } from '../../src/templates/templateImageService';

describe('TemplateImageService', () => {
  it('normalizes a PNG upload to {assetId}.png via ffmpeg and keeps the original alongside it', async () => {
    const moveFile = jest.fn().mockResolvedValue(undefined);
    const runFfmpeg = jest.fn().mockResolvedValue(undefined);
    const generateId = () => 'asset-123';
    const service = new TemplateImageService({ uploadsDir: '/data/uploads', moveFile, runFfmpeg, generateId });

    const result = await service.upload('user-1', 'tpl-1', { originalname: 'logo.png', path: '/tmp/upload-abc', size: 1000 });

    expect(result).toEqual({ assetId: 'asset-123' });
    expect(moveFile).toHaveBeenCalledWith('/tmp/upload-abc', '/data/uploads/user-1/templates/tpl-1/images/asset-123.original.png');
    expect(runFfmpeg).toHaveBeenCalledWith(
      '/data/uploads/user-1/templates/tpl-1/images/asset-123.original.png',
      '/data/uploads/user-1/templates/tpl-1/images/asset-123.png',
    );
  });

  it('resolvePath points at the renderable .png regardless of the original upload extension', () => {
    const service = new TemplateImageService({ uploadsDir: '/data/uploads', moveFile: jest.fn(), runFfmpeg: jest.fn(), generateId: () => 'x' });
    expect(service.resolvePath('user-1', 'tpl-1', 'asset-123'))
      .toBe('/data/uploads/user-1/templates/tpl-1/images/asset-123.png');
  });

  it('rejects a path-traversal assetId instead of resolving outside the template images directory', () => {
    const service = new TemplateImageService({ uploadsDir: '/data/uploads', moveFile: jest.fn(), runFfmpeg: jest.fn(), generateId: () => 'x' });
    expect(() => service.resolvePath('user-1', 'tpl-1', '../../other-user/templates/other-template/images/x'))
      .toThrow();
  });

  it('rejects an assetId containing a path separator, even without any ".." segment', () => {
    const service = new TemplateImageService({ uploadsDir: '/data/uploads', moveFile: jest.fn(), runFfmpeg: jest.fn(), generateId: () => 'x' });
    expect(() => service.resolvePath('user-1', 'tpl-1', 'sub/asset'))
      .toThrow();
  });
});
