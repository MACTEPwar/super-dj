import { TemplateImageService } from '../../src/templates/templateImageService';

describe('TemplateImageService', () => {
  describe('resolveOriginalPath', () => {
    // upload() stores the untouched original alongside the flattened .png (see the upload test
    // above), under a name whose extension depends on what was actually uploaded — resolvePath()
    // deliberately always points at the .png (that's what every Satori-rendered element needs),
    // so finding the original back requires listing the directory rather than guessing the
    // extension. Needed so a multi-frame (animated) original can be probed/played by ffmpeg
    // directly, instead of the already-flattened-to-one-frame .png every other caller uses.
    it('finds the original file by its assetId prefix, whatever extension it was uploaded with', async () => {
      const readdir = jest.fn().mockResolvedValue(['asset-123.png', 'asset-123.original.gif', 'other-asset.png']);
      const service = new TemplateImageService({ uploadsDir: '/data/uploads', moveFile: jest.fn(), runFfmpeg: jest.fn(), generateId: () => 'x', readdir });

      const result = await service.resolveOriginalPath('user-1', 'tpl-1', 'asset-123');

      expect(readdir).toHaveBeenCalledWith('/data/uploads/user-1/templates/tpl-1/images');
      expect(result).toBe('/data/uploads/user-1/templates/tpl-1/images/asset-123.original.gif');
    });

    it('returns null when no original file exists for the assetId (e.g. an asset predating this method)', async () => {
      const readdir = jest.fn().mockResolvedValue(['asset-123.png']);
      const service = new TemplateImageService({ uploadsDir: '/data/uploads', moveFile: jest.fn(), runFfmpeg: jest.fn(), generateId: () => 'x', readdir });

      expect(await service.resolveOriginalPath('user-1', 'tpl-1', 'asset-123')).toBeNull();
    });

    it('returns null (not a throw) when the images directory itself does not exist', async () => {
      const readdir = jest.fn().mockRejectedValue(Object.assign(new Error('nope'), { code: 'ENOENT' }));
      const service = new TemplateImageService({ uploadsDir: '/data/uploads', moveFile: jest.fn(), runFfmpeg: jest.fn(), generateId: () => 'x', readdir });

      expect(await service.resolveOriginalPath('user-1', 'tpl-1', 'asset-123')).toBeNull();
    });

    it('rejects a path-traversal assetId the same way resolvePath does, before ever touching the filesystem', async () => {
      const readdir = jest.fn();
      const service = new TemplateImageService({ uploadsDir: '/data/uploads', moveFile: jest.fn(), runFfmpeg: jest.fn(), generateId: () => 'x', readdir });

      await expect(service.resolveOriginalPath('user-1', 'tpl-1', '../../etc/passwd')).rejects.toThrow();
      expect(readdir).not.toHaveBeenCalled();
    });
  });

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
