import { NextFunction, Request, RequestHandler, Response } from 'express';
import { ApiError } from '../errors';

export function wrapAsync(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<void> | void,
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof ApiError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  console.error('unexpected error handling request', err);
  res.status(500).json({ error: 'internal server error' });
}
