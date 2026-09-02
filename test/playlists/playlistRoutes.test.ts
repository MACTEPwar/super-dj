import express from 'express';
import request from 'supertest';
import { createPlaylistRouter } from '../../src/playlists/playlistRoutes';
import { errorHandler } from '../../src/api/errorHandler';

function buildApp(playlistRepository: any, trackRepository: any = { listByUser: jest.fn().mockResolvedValue([]) }, userId = 'user-1') {
  const authService: any = { getCurrentUser: jest.fn().mockResolvedValue({ id: userId, email: 'a@example.com' }) };
  const app = express();
  app.use(express.json());
  app.use('/playlists', createPlaylistRouter(authService, playlistRepository, trackRepository));
  app.use(errorHandler);
  return app;
}

describe('playlist routes', () => {
  it('POST /playlists creates a playlist for the current user', async () => {
    const playlistRepository: any = { create: jest.fn().mockResolvedValue({ id: 'p1', name: 'My Mix', userId: 'user-1' }) };
    const res = await request(buildApp(playlistRepository)).post('/playlists').send({ name: 'My Mix' });
    expect(res.status).toBe(200);
    expect(playlistRepository.create).toHaveBeenCalledWith('user-1', 'My Mix');
    expect(res.body).toEqual({ id: 'p1', name: 'My Mix' });
  });

  it('POST /playlists requires a non-empty name', async () => {
    const playlistRepository: any = { create: jest.fn() };
    const res = await request(buildApp(playlistRepository)).post('/playlists').send({});
    expect(res.status).toBe(400);
    expect(playlistRepository.create).not.toHaveBeenCalled();
  });

  it('GET /playlists lists the current user\'s playlists', async () => {
    const playlistRepository: any = { listByUser: jest.fn().mockResolvedValue([{ id: 'p1', name: 'A' }, { id: 'p2', name: 'B' }]) };
    const res = await request(buildApp(playlistRepository)).get('/playlists');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: 'p1', name: 'A' }, { id: 'p2', name: 'B' }]);
  });

  it('GET /playlists/:id returns the playlist with its ordered tracks', async () => {
    const playlistRepository: any = {
      findById: jest.fn().mockResolvedValue({ id: 'p1', name: 'A', userId: 'user-1' }),
      listTracks: jest.fn().mockResolvedValue([{ name: 'a', audioPath: '/x/a.mp3', coverPath: null }]),
    };
    const res = await request(buildApp(playlistRepository)).get('/playlists/p1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 'p1', name: 'A', tracks: [{ name: 'a', audioPath: '/x/a.mp3', coverPath: null }] });
  });

  it('GET /playlists/:id includes each track\'s id', async () => {
    const playlistRepository: any = {
      findById: jest.fn().mockResolvedValue({ id: 'p1', name: 'Mix', userId: 'user-1' }),
      listTracks: jest.fn().mockResolvedValue([{ id: 't1', name: 'a', audioPath: '/a.mp3', coverPath: null }]),
    };
    const res = await request(buildApp(playlistRepository)).get('/playlists/p1');
    expect(res.status).toBe(200);
    expect(res.body.tracks[0].id).toBe('t1');
  });

  it('GET /playlists/:id returns 403 for someone else\'s playlist', async () => {
    const playlistRepository: any = { findById: jest.fn().mockResolvedValue({ id: 'p1', name: 'A', userId: 'someone-else' }) };
    const res = await request(buildApp(playlistRepository)).get('/playlists/p1');
    expect(res.status).toBe(403);
  });

  it('PUT /playlists/:id/tracks replaces the ordered track list', async () => {
    const playlistRepository: any = {
      findById: jest.fn().mockResolvedValue({ id: 'p1', name: 'A', userId: 'user-1' }),
      replaceTracks: jest.fn().mockResolvedValue(undefined),
    };
    const trackRepository: any = { listByUser: jest.fn().mockResolvedValue([{ id: 't1' }, { id: 't2' }]) };
    const res = await request(buildApp(playlistRepository, trackRepository)).put('/playlists/p1/tracks').send({ trackIds: ['t2', 't1'] });
    expect(res.status).toBe(200);
    expect(trackRepository.listByUser).toHaveBeenCalledWith('user-1');
    expect(playlistRepository.replaceTracks).toHaveBeenCalledWith('p1', ['t2', 't1']);
  });

  it('PUT /playlists/:id/tracks requires trackIds to be an array', async () => {
    const playlistRepository: any = { findById: jest.fn().mockResolvedValue({ id: 'p1', name: 'A', userId: 'user-1' }) };
    const res = await request(buildApp(playlistRepository)).put('/playlists/p1/tracks').send({ trackIds: 'not-an-array' });
    expect(res.status).toBe(400);
  });

  it('PUT /playlists/:id/tracks rejects a trackId the caller does not own', async () => {
    const playlistRepository: any = {
      findById: jest.fn().mockResolvedValue({ id: 'p1', name: 'A', userId: 'user-1' }),
      replaceTracks: jest.fn().mockResolvedValue(undefined),
    };
    const trackRepository: any = { listByUser: jest.fn().mockResolvedValue([{ id: 't1' }]) };
    const res = await request(buildApp(playlistRepository, trackRepository))
      .put('/playlists/p1/tracks').send({ trackIds: ['t1', 'someone-elses-track'] });
    expect(res.status).toBe(400);
    expect(playlistRepository.replaceTracks).not.toHaveBeenCalled();
  });

  it('DELETE /playlists/:id deletes an owned playlist', async () => {
    const playlistRepository: any = {
      findById: jest.fn().mockResolvedValue({ id: 'p1', name: 'A', userId: 'user-1' }),
      deleteById: jest.fn().mockResolvedValue(undefined),
    };
    const res = await request(buildApp(playlistRepository)).delete('/playlists/p1');
    expect(res.status).toBe(200);
    expect(playlistRepository.deleteById).toHaveBeenCalledWith('p1');
  });

  it('DELETE /playlists/:id returns 404 for a missing playlist', async () => {
    const playlistRepository: any = { findById: jest.fn().mockResolvedValue(null) };
    const res = await request(buildApp(playlistRepository)).delete('/playlists/missing');
    expect(res.status).toBe(404);
  });
});
