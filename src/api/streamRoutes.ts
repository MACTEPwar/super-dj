import { Router } from 'express';
import { StreamController } from '../stream/streamController';
import { ApiError } from '../errors';
import { wrapAsync } from './errorHandler';

export function createStreamRouter(streamController: StreamController): Router {
  const router = Router();

  router.post('/start', wrapAsync(async (_req, res) => {
    await streamController.start();
    res.status(200).json(streamController.status());
  }));

  router.post('/stop', wrapAsync(async (_req, res) => {
    streamController.stop();
    res.status(200).json(streamController.status());
  }));

  router.post('/pause', wrapAsync(async (_req, res) => {
    streamController.pause();
    res.status(200).json(streamController.status());
  }));

  router.post('/resume', wrapAsync(async (_req, res) => {
    await streamController.resume();
    res.status(200).json(streamController.status());
  }));

  router.post('/next', wrapAsync(async (_req, res) => {
    await streamController.next();
    res.status(200).json(streamController.status());
  }));

  router.post('/previous', wrapAsync(async (_req, res) => {
    await streamController.previous();
    res.status(200).json(streamController.status());
  }));

  router.post('/play', wrapAsync(async (req, res) => {
    const { name } = req.body ?? {};
    if (typeof name !== 'string' || name.length === 0) {
      throw new ApiError(400, 'body.name is required');
    }
    streamController.playByName(name);
    res.status(200).json(streamController.status());
  }));

  router.get('/status', wrapAsync(async (_req, res) => {
    res.status(200).json(streamController.status());
  }));

  return router;
}
