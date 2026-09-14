import express from 'express';
import request from 'supertest';
import { createStreamPresetRouter } from '../../src/stream/streamPresetRoutes';
import { errorHandler } from '../../src/api/errorHandler';

const PRESET = {
  id: 'preset-1', userId: 'user-1', name: 'Friday night', playlistId: 'p1', templateId: 'tpl-1',
  title: null, description: null, privacyStatus: null, latencyPreference: null,
  createdAt: new Date('2026-09-14T10:00:00.000Z'), destinationIds: ['dest-1'],
};

function buildApp(userId = 'user-1') {
  const authService: any = { getCurrentUser: jest.fn().mockResolvedValue({ id: userId, email: 'a@example.com' }) };
  const repository: any = {
    create: jest.fn().mockResolvedValue(PRESET),
    update: jest.fn().mockResolvedValue(PRESET),
    findById: jest.fn().mockResolvedValue(PRESET),
    listByUser: jest.fn().mockResolvedValue([PRESET]),
    deleteById: jest.fn().mockResolvedValue(undefined),
  };
  const playlistRepository: any = { findById: jest.fn().mockResolvedValue({ id: 'p1', userId: 'user-1', name: 'Mix' }) };
  const templateRepository: any = { findById: jest.fn().mockResolvedValue({ id: 'tpl-1', userId: 'user-1' }) };
  const destinationRepository: any = { findById: jest.fn().mockResolvedValue({ id: 'dest-1', userId: 'user-1' }) };
  const app = express();
  app.use(express.json());
  app.use('/stream-presets', createStreamPresetRouter(authService, repository, playlistRepository, templateRepository, destinationRepository));
  app.use(errorHandler);
  return { app, repository, playlistRepository, templateRepository, destinationRepository };
}

describe('stream preset routes', () => {
  it('creates a preset owned by the caller', async () => {
    const { app, repository } = buildApp();
    const res = await request(app).post('/stream-presets').send({
      name: 'Friday night', playlistId: 'p1', templateId: 'tpl-1', destinationIds: ['dest-1'],
    });
    expect(res.status).toBe(200);
    expect(repository.create).toHaveBeenCalledWith({
      userId: 'user-1', name: 'Friday night', playlistId: 'p1', templateId: 'tpl-1',
      destinationIds: ['dest-1'], title: null, description: null, privacyStatus: null, latencyPreference: null,
    });
    expect(res.body).toEqual(expect.objectContaining({ id: 'preset-1', name: 'Friday night', destinationIds: ['dest-1'] }));
  });

  // The old StreamSession required a non-empty destination list because a session existed only to
  // fan out to destinations. A preset does not: zero destinations is a valid, useful preset now.
  it('accepts a preset with no destinations at all', async () => {
    const { app, repository } = buildApp();
    const res = await request(app).post('/stream-presets').send({ name: 'Just the local stream', playlistId: 'p1' });
    expect(res.status).toBe(200);
    expect(repository.create).toHaveBeenCalledWith(expect.objectContaining({ destinationIds: [] }));
  });

  it.each([
    [{ playlistId: 'p1' }, 'name'],
    [{ name: '', playlistId: 'p1' }, 'empty name'],
    [{ name: 'x' }, 'playlistId'],
    [{ name: 'x', playlistId: 'p1', templateId: '' }, 'empty templateId'],
    [{ name: 'x', playlistId: 'p1', destinationIds: 'dest-1' }, 'non-array destinationIds'],
    [{ name: 'x', playlistId: 'p1', destinationIds: ['a', 'a'] }, 'duplicate destinationIds'],
    [{ name: 'x', playlistId: 'p1', privacyStatus: 'semi' }, 'bad privacyStatus'],
    [{ name: 'x', playlistId: 'p1', latencyPreference: 'instant' }, 'bad latencyPreference'],
  ])('rejects %j (%s)', async (body, _description) => {
    const { app, repository } = buildApp();
    const res = await request(app).post('/stream-presets').send(body);
    expect(res.status).toBe(400);
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('404s an unknown playlist and 403s someone else\'s', async () => {
    const { app, playlistRepository } = buildApp();
    playlistRepository.findById.mockResolvedValueOnce(null);
    expect((await request(app).post('/stream-presets').send({ name: 'x', playlistId: 'p1' })).status).toBe(404);
    playlistRepository.findById.mockResolvedValueOnce({ id: 'p1', userId: 'someone-else' });
    expect((await request(app).post('/stream-presets').send({ name: 'x', playlistId: 'p1' })).status).toBe(403);
  });

  it('403s a destination belonging to another user', async () => {
    const { app, destinationRepository } = buildApp();
    destinationRepository.findById.mockResolvedValueOnce({ id: 'dest-1', userId: 'someone-else' });
    const res = await request(app).post('/stream-presets').send({ name: 'x', playlistId: 'p1', destinationIds: ['dest-1'] });
    expect(res.status).toBe(403);
  });

  it('lists only the caller\'s presets', async () => {
    const { app, repository } = buildApp('user-9');
    const res = await request(app).get('/stream-presets');
    expect(res.status).toBe(200);
    expect(repository.listByUser).toHaveBeenCalledWith('user-9');
  });

  it('gets, updates and deletes a preset, refusing another user\'s', async () => {
    const { app, repository } = buildApp();
    expect((await request(app).get('/stream-presets/preset-1')).status).toBe(200);
    expect((await request(app).put('/stream-presets/preset-1').send({ name: 'New name', playlistId: 'p1' })).status).toBe(200);
    expect(repository.update).toHaveBeenCalledWith('preset-1', expect.objectContaining({ name: 'New name' }));
    expect((await request(app).delete('/stream-presets/preset-1')).status).toBe(200);

    repository.findById.mockResolvedValue({ ...PRESET, userId: 'someone-else' });
    expect((await request(app).get('/stream-presets/preset-1')).status).toBe(403);
    expect((await request(app).put('/stream-presets/preset-1').send({ name: 'x', playlistId: 'p1' })).status).toBe(403);
    expect((await request(app).delete('/stream-presets/preset-1')).status).toBe(403);
  });

  it('404s a preset that does not exist', async () => {
    const { app, repository } = buildApp();
    repository.findById.mockResolvedValue(null);
    expect((await request(app).get('/stream-presets/nope')).status).toBe(404);
  });

  it('requires authentication', async () => {
    const authService: any = { getCurrentUser: jest.fn().mockResolvedValue(null) };
    const app = express();
    app.use(express.json());
    app.use('/stream-presets', createStreamPresetRouter(authService, {} as never, {} as never, {} as never, {} as never));
    app.use(errorHandler);
    expect((await request(app).get('/stream-presets')).status).toBe(401);
  });
});
