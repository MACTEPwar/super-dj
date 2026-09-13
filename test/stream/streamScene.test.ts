jest.mock('../../src/ffmpeg/duration', () => ({ getAudioDurationSeconds: jest.fn().mockResolvedValue(100) }));
jest.mock('../../src/ffmpeg/imageFrameCount', () => ({ getImageFrameCount: jest.fn().mockResolvedValue(1) }));
jest.mock('../../src/render/renderOverlay', () => ({ renderTemplatePng: jest.fn().mockResolvedValue(Buffer.from('fake-png')) }));

import { buildStreamScene, StreamSceneDeps } from '../../src/stream/streamScene';
import { renderTemplatePng } from '../../src/render/renderOverlay';
import { getImageFrameCount } from '../../src/ffmpeg/imageFrameCount';
import { BLANK_OVERLAY_PNG } from '../../src/render/blankOverlay';
import { DEFAULT_TEMPLATE_ELEMENTS } from '../../src/templates/templateTypes';
import { SessionOverlayCache } from '../../src/stream/sessionOverlayCache';

function buildDeps() {
  const playlistRepository = {
    findById: jest.fn().mockResolvedValue({ id: 'playlist-1', userId: 'user-1', name: 'Mix' }),
    listTracks: jest.fn().mockResolvedValue([
      { name: 'a', audioPath: '/music/a.mp3', coverPath: null },
      { name: 'b', audioPath: '/music/b.mp3', coverPath: null },
    ]),
  };
  const trackRepository = {
    listByUser: jest.fn().mockResolvedValue([
      { name: 'a', audioPath: '/music/a.mp3', coverPath: null },
      { name: 'c', audioPath: '/music/c.mp3', coverPath: null },
    ]),
  };
  const templateRepository = { findById: jest.fn() };
  const templateImageService = {
    resolvePath: jest.fn().mockReturnValue('/uploads/user-1/templates/tpl-1/images/asset-1.png'),
    resolveOriginalPath: jest.fn().mockResolvedValue(null),
  };
  const deps: StreamSceneDeps = {
    spawner: jest.fn(), pipeSpawner: jest.fn(),
    fifoDir: '/tmp', defaultCoverPath: '/assets/default.png', backgroundImagePath: '/assets/bg.png',
    fontFile: '/fonts/x.ttf', fontFamily: 'DejaVu Sans',
    playlistRepository, trackRepository, templateRepository, templateImageService,
  } as unknown as StreamSceneDeps;
  return { deps, playlistRepository, trackRepository, templateRepository, templateImageService };
}

const params = { userId: 'user-1', playlistId: 'playlist-1', sceneId: 'scene-1' };

describe('buildStreamScene — resolution and ownership', () => {
  beforeEach(() => {
    // jest.mock's module-level mocks are shared by every test in this file — without clearing,
    // assertions on mock.calls[0] and on call counts would read an earlier test's renders.
    jest.clearAllMocks();
    (renderTemplatePng as jest.Mock).mockResolvedValue(Buffer.from('fake-png'));
    (getImageFrameCount as jest.Mock).mockResolvedValue(1);
  });

  it('returns the playlist name, its ordered tracks, and a library that also finds the user\'s other tracks by name', async () => {
    const { deps } = buildDeps();
    const scene = await buildStreamScene(deps, params);
    expect(scene.playlistName).toBe('Mix');
    expect(scene.tracks.map((t) => t.name)).toEqual(['a', 'b']);
    expect(scene.library.list().map((t) => t.name)).toEqual(['a', 'b']);
    // 'c' is in the user's library but not in this playlist — playByName must still find it.
    expect(scene.library.findByName('c')?.audioPath).toBe('/music/c.mp3');
    expect(scene.library.findByName('nope')).toBeUndefined();
  });

  it('throws 404 for a playlist that does not exist', async () => {
    const { deps, playlistRepository } = buildDeps();
    playlistRepository.findById.mockResolvedValue(null);
    await expect(buildStreamScene(deps, params)).rejects.toThrow('playlist not found');
  });

  it('throws 403 for a playlist owned by someone else', async () => {
    const { deps, playlistRepository } = buildDeps();
    playlistRepository.findById.mockResolvedValue({ id: 'playlist-1', userId: 'someone-else', name: 'Mix' });
    await expect(buildStreamScene(deps, params)).rejects.toThrow('not your playlist');
  });

  it('throws 409 for an empty playlist', async () => {
    const { deps, playlistRepository } = buildDeps();
    playlistRepository.listTracks.mockResolvedValue([]);
    await expect(buildStreamScene(deps, params)).rejects.toThrow('playlist is empty');
  });

  it('throws 404/403 for a template that is missing or owned by someone else', async () => {
    const { deps, templateRepository } = buildDeps();
    templateRepository.findById.mockResolvedValue(null);
    await expect(buildStreamScene(deps, { ...params, templateId: 'tpl-1' })).rejects.toThrow('template not found');
    templateRepository.findById.mockResolvedValue({ id: 'tpl-1', userId: 'someone-else', elements: [] });
    await expect(buildStreamScene(deps, { ...params, templateId: 'tpl-1' })).rejects.toThrow('not your template');
  });

  it('falls back to DEFAULT_TEMPLATE_ELEMENTS when no templateId is given, without hitting the repository', async () => {
    const { deps, templateRepository } = buildDeps();
    const scene = await buildStreamScene(deps, params);
    await scene.buildOverlay({ name: 'a', audioPath: '/music/a.mp3', coverPath: null });
    expect(templateRepository.findById).not.toHaveBeenCalled();
    expect(renderTemplatePng).toHaveBeenCalledWith(expect.objectContaining({ elements: DEFAULT_TEMPLATE_ELEMENTS }));
  });
});

describe('buildStreamScene — overlay building', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (renderTemplatePng as jest.Mock).mockResolvedValue(Buffer.from('fake-png'));
    (getImageFrameCount as jest.Mock).mockResolvedValue(1);
  });

  it('renders the overlay at 1280x720 with the configured font and the track\'s own cover', async () => {
    const { deps } = buildDeps();
    const scene = await buildStreamScene(deps, params);
    await scene.buildOverlay({ name: 'a', audioPath: '/music/a.mp3', coverPath: '/covers/a.png' });
    expect(renderTemplatePng).toHaveBeenCalledWith(expect.objectContaining({
      title: 'a', width: 1280, height: 720, fontPath: '/fonts/x.ttf', fontFamily: 'DejaVu Sans', coverPath: '/covers/a.png',
    }));
  });

  it('falls back to the default cover when the track has none', async () => {
    const { deps } = buildDeps();
    const scene = await buildStreamScene(deps, params);
    await scene.buildOverlay({ name: 'a', audioPath: '/music/a.mp3', coverPath: null });
    expect(renderTemplatePng).toHaveBeenCalledWith(expect.objectContaining({ coverPath: '/assets/default.png' }));
  });

  // Keeping the pipeline alive matters more than one frame's picture — unlike the preview endpoint,
  // which deliberately lets a render error become a real 500.
  it('falls back to a blank overlay instead of throwing when the render fails', async () => {
    const { deps } = buildDeps();
    (renderTemplatePng as jest.Mock).mockRejectedValue(new Error('satori exploded'));
    const scene = await buildStreamScene(deps, params);
    const overlay = await scene.buildOverlay({ name: 'a', audioPath: '/music/a.mp3', coverPath: null });
    expect(overlay.overlayPng).toBe(BLANK_OVERLAY_PNG);
    expect(overlay.overlayPngAbove).toBeUndefined();
  });

  it('splits a timer element out of the baked picture and returns its position instead', async () => {
    const { deps, templateRepository } = buildDeps();
    templateRepository.findById.mockResolvedValue({
      id: 'tpl-1', userId: 'user-1',
      elements: [
        { type: 'cover', x: 0, y: 0, width: 100, height: 100 },
        { type: 'timer', x: 10, y: 660, fontSize: 20, color: '#ffffff', style: { fontFamily: 'DejaVu Sans', bold: false, italic: false } },
      ],
    });
    const scene = await buildStreamScene(deps, { ...params, templateId: 'tpl-1' });
    const overlay = await scene.buildOverlay({ name: 'a', audioPath: '/music/a.mp3', coverPath: null });
    expect(overlay.timer).toEqual(expect.objectContaining({ x: 10, y: 660, fontSize: 20, color: '#ffffff' }));
    const rendered = (renderTemplatePng as jest.Mock).mock.calls[0][0].elements;
    expect(rendered.some((e: { type: string }) => e.type === 'timer')).toBe(false);
  });

  it('applies a track\'s overlayOverride colour to title/text elements and its background to the lower layer only', async () => {
    const { deps, templateRepository } = buildDeps();
    templateRepository.findById.mockResolvedValue({
      id: 'tpl-1', userId: 'user-1',
      elements: [{ type: 'title', x: 0, y: 0, width: 400, fontSize: 24, color: { mode: 'solid', color: '#ffffff' }, style: { fontFamily: 'DejaVu Sans', bold: false, italic: false } }],
    });
    const scene = await buildStreamScene(deps, { ...params, templateId: 'tpl-1' });
    await scene.buildOverlay({
      name: 'a', audioPath: '/music/a.mp3', coverPath: null,
      overlayOverride: { color: { mode: 'solid', color: '#ff0000' }, backgroundColor: { mode: 'solid', color: '#000000' } },
    });
    const call = (renderTemplatePng as jest.Mock).mock.calls[0][0];
    expect(call.elements[0].color).toEqual({ mode: 'solid', color: '#ff0000' });
    expect(call.background).toEqual({ mode: 'solid', color: '#000000' });
  });
});

describe('buildStreamScene — encoder wiring', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (renderTemplatePng as jest.Mock).mockResolvedValue(Buffer.from('fake-png'));
    (getImageFrameCount as jest.Mock).mockResolvedValue(1);
  });

  it('builds an encoder pointed at whatever RTMP target the caller supplies', async () => {
    const { deps } = buildDeps();
    const pipeSpawner = jest.fn().mockReturnValue({ once: jest.fn(), kill: jest.fn(), pid: 1, stdout: null, stderr: null });
    const scene = await buildStreamScene({ ...deps, pipeSpawner } as unknown as StreamSceneDeps, params);
    scene.createPersistentEncoder({ rtmpUrl: 'rtmp://mediamtx:1935/live', streamKey: 'token?user=pub&pass=s' }).start(() => {});
    const args: string[] = pipeSpawner.mock.calls[0][1];
    expect(args[args.length - 1]).toBe('rtmp://mediamtx:1935/live/token?user=pub&pass=s');
  });

  it('creates no pulse visualizer factory when the template has no equalizer element', async () => {
    const { deps } = buildDeps();
    const scene = await buildStreamScene(deps, params);
    expect(scene.createPulseVisualizer).toBeUndefined();
  });

  // The canvas is only pinned on top when there are no gifs; with a gif present, elements listed
  // before it must be able to land underneath it. See CanvasPlacement.
  it('places the canvas below the gifs when every baked element is listed before the first gif', async () => {
    const { deps, templateRepository, templateImageService } = buildDeps();
    templateImageService.resolveOriginalPath.mockResolvedValue('/uploads/user-1/templates/tpl-1/images/asset-1.original.gif');
    (getImageFrameCount as jest.Mock).mockResolvedValue(12);
    templateRepository.findById.mockResolvedValue({
      id: 'tpl-1', userId: 'user-1',
      elements: [
        { type: 'cover', x: 0, y: 0, width: 100, height: 100 },
        { type: 'image', x: 0, y: 0, width: 1280, height: 720, assetId: 'asset-1' },
      ],
    });
    const pipeSpawner = jest.fn().mockReturnValue({ once: jest.fn(), kill: jest.fn(), pid: 1, stdout: null, stderr: null });
    const scene = await buildStreamScene({ ...deps, pipeSpawner } as unknown as StreamSceneDeps, { ...params, templateId: 'tpl-1' });
    scene.createPersistentEncoder({ rtmpUrl: 'rtmp://x/live', streamKey: 'k' }).start(() => {});
    const filter: string = pipeSpawner.mock.calls[0][1][pipeSpawner.mock.calls[0][1].indexOf('-filter_complex') + 1];
    expect(filter).toContain('[vcanvas_below]');
    expect(filter).not.toContain('[vcanvas_top]');
  });
});

// The extraction moves renderShared's four-part cache key (sessionId/trackName/templateId/layer)
// out of streamManager.ts along with everything else — nothing in the EXISTING suite exercises it:
// streamManager.test.ts never passes overlayCache/sessionId at all, and
// streamSessionManager.test.ts only asserts a SessionOverlayCache instance was constructed,
// against a fully faked StreamManager. Without these, dropping `layer` from the key (the subtle
// bit — see SessionOverlayCache's own doc comment: "must never be served for each other") would be
// caught by nothing, on the blast radius of the still-live /stream-sessions/* path.
describe('buildStreamScene — overlay cache integration (SessionOverlayCache)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (renderTemplatePng as jest.Mock).mockResolvedValue(Buffer.from('fake-png'));
    (getImageFrameCount as jest.Mock).mockResolvedValue(1);
  });

  it('renders once and reuses the cached buffer for a second buildOverlay call sharing the same session, track and template', async () => {
    const { deps } = buildDeps();
    const overlayCache = new SessionOverlayCache();
    const scene = await buildStreamScene(deps, { ...params, sessionId: 'session-1', overlayCache });
    const track = { name: 'a', audioPath: '/music/a.mp3', coverPath: null };

    await scene.buildOverlay(track);
    await scene.buildOverlay(track);

    expect(renderTemplatePng).toHaveBeenCalledTimes(1);
  });

  // Asserts the KEY itself, not just the end-to-end caching behaviour above — a fake standing in
  // for SessionOverlayCache so the exact argument getOrRender receives is inspectable.
  it('includes sessionId, the track name, the templateId and the layer in every cache key', async () => {
    const { deps } = buildDeps();
    const getOrRender = jest.fn((_key: unknown, render: () => Promise<Buffer>) => render());
    const overlayCache = { getOrRender } as unknown as SessionOverlayCache;
    const scene = await buildStreamScene(deps, { ...params, sessionId: 'session-1', overlayCache });
    await scene.buildOverlay({ name: 'a', audioPath: '/music/a.mp3', coverPath: null });

    expect(getOrRender).toHaveBeenCalledWith(
      { sessionId: 'session-1', trackName: 'a', templateId: null, layer: 'below' },
      expect.any(Function),
    );
  });

  it('never shares a cache entry between two destinations that have drifted onto different tracks or templates', async () => {
    const { deps, templateRepository } = buildDeps();
    templateRepository.findById.mockResolvedValue({ id: 'tpl-1', userId: 'user-1', elements: [] });
    const overlayCache = new SessionOverlayCache();
    const sceneA = await buildStreamScene(deps, { ...params, sessionId: 'session-1', overlayCache });
    const sceneB = await buildStreamScene(deps, { ...params, sessionId: 'session-1', overlayCache, templateId: 'tpl-1' });

    await sceneA.buildOverlay({ name: 'a', audioPath: '/music/a.mp3', coverPath: null });
    await sceneB.buildOverlay({ name: 'b', audioPath: '/music/b.mp3', coverPath: null });

    expect(renderTemplatePng).toHaveBeenCalledTimes(2);
  });
});
