import express from 'express';
import request from 'supertest';
import { createRequestPageRouter, generateRequestPageToken, REQUEST_PAGE_TOKEN_PATTERN } from '../../src/requestPage/requestPageRoutes';
import { errorHandler } from '../../src/api/errorHandler';

function buildApp(initialToken: string | null = null, generate = () => 'a'.repeat(32)) {
  const user = { id: 'user-1', requestPageToken: initialToken };
  const users = {
    findById: jest.fn(async (id: string) => (id === user.id ? user : null)),
    setRequestPageToken: jest.fn(async (_id: string, token: string | null) => { user.requestPageToken = token; }),
  };
  const authService: any = { getCurrentUser: jest.fn().mockResolvedValue({ id: 'user-1', email: 'a@example.com' }) };
  const app = express();
  app.use(express.json());
  app.use('/request-page', createRequestPageRouter(authService, users as any, generate));
  app.use(errorHandler);
  return { app, users, user };
}

describe('request page owner routes', () => {
  it('generateRequestPageToken produces 32 lowercase hex chars, different each time', () => {
    const a = generateRequestPageToken();
    const b = generateRequestPageToken();
    expect(a).toMatch(REQUEST_PAGE_TOKEN_PATTERN);
    expect(a).not.toBe(b);
  });

  it('GET returns null when no link exists', async () => {
    const { app } = buildApp(null);
    const res = await request(app).get('/request-page');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ token: null });
  });

  it('GET never mints a token as a side effect', async () => {
    const { app, users } = buildApp(null);
    await request(app).get('/request-page');
    expect(users.setRequestPageToken).not.toHaveBeenCalled();
  });

  it('POST /token mints (or rotates) and returns the new token', async () => {
    const { app, user } = buildApp('b'.repeat(32), () => 'c'.repeat(32));
    const res = await request(app).post('/request-page/token').set('Content-Type', 'application/json').send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ token: 'c'.repeat(32) });
    expect(user.requestPageToken).toBe('c'.repeat(32));
  });

  it('DELETE /token disables the link — with NO body and NO content-type, exactly as a browser sends it', async () => {
    const { app, user } = buildApp('b'.repeat(32));
    const res = await request(app).delete('/request-page/token');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ token: null });
    expect(user.requestPageToken).toBeNull();
  });

  it('mutating routes require application/json', async () => {
    const { app } = buildApp(null);
    const res = await request(app).post('/request-page/token').set('Content-Type', 'text/plain').send('x');
    expect(res.status).toBe(400);
  });
});
