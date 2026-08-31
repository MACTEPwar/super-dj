import express from 'express';
import request from 'supertest';
import { createAuthRouter } from '../../src/auth/authRoutes';
import { errorHandler } from '../../src/api/errorHandler';
import { ApiError } from '../../src/errors';
import { SESSION_COOKIE_NAME } from '../../src/auth/sessionCookie';

function buildApp(authService: any) {
  const app = express();
  app.use(express.json());
  app.use('/auth', createAuthRouter(authService));
  app.use(errorHandler);
  return app;
}

describe('auth routes', () => {
  it('POST /auth/register creates a user and sets a session cookie', async () => {
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60);
    const authService = {
      register: jest.fn().mockResolvedValue({ user: { id: 'u1', email: 'a@example.com' }, sessionId: 'sess-1', expiresAt }),
    };

    const res = await request(buildApp(authService)).post('/auth/register').send({ email: 'a@example.com', password: 'pw' });

    expect(authService.register).toHaveBeenCalledWith('a@example.com', 'pw');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 'u1', email: 'a@example.com' });
    expect(res.headers['set-cookie'][0]).toContain(`${SESSION_COOKIE_NAME}=sess-1`);
  });

  it('POST /auth/register normalizes the email (trimmed and lowercased)', async () => {
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60);
    const authService = {
      register: jest.fn().mockResolvedValue({ user: { id: 'u1', email: 'a@example.com' }, sessionId: 'sess-1', expiresAt }),
    };

    const res = await request(buildApp(authService)).post('/auth/register').send({ email: '  A@Example.com  ', password: 'pw' });

    expect(authService.register).toHaveBeenCalledWith('a@example.com', 'pw');
    expect(res.status).toBe(200);
  });

  it('POST /auth/register requires email and password in the body', async () => {
    const authService = { register: jest.fn() };
    const res = await request(buildApp(authService)).post('/auth/register').send({ email: 'a@example.com' });

    expect(res.status).toBe(400);
    expect(authService.register).not.toHaveBeenCalled();
  });

  it('POST /auth/login maps a 401 ApiError from the service', async () => {
    const authService = { login: jest.fn().mockRejectedValue(new ApiError(401, 'invalid email or password')) };
    const res = await request(buildApp(authService)).post('/auth/login').send({ email: 'a@example.com', password: 'wrong' });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'invalid email or password' });
  });

  it('POST /auth/logout clears the cookie', async () => {
    const authService = { logout: jest.fn().mockResolvedValue(undefined) };
    const res = await request(buildApp(authService)).post('/auth/logout').set('Cookie', `${SESSION_COOKIE_NAME}=sess-1`);

    expect(authService.logout).toHaveBeenCalledWith('sess-1');
    expect(res.status).toBe(200);
    expect(res.headers['set-cookie'][0]).toContain(`${SESSION_COOKIE_NAME}=;`);
  });

  it('GET /auth/me returns 401 without a valid session', async () => {
    const authService = { getCurrentUser: jest.fn().mockResolvedValue(null) };
    const res = await request(buildApp(authService)).get('/auth/me');

    expect(res.status).toBe(401);
  });

  it('GET /auth/me returns the current user with a valid session', async () => {
    const authService = { getCurrentUser: jest.fn().mockResolvedValue({ id: 'u1', email: 'a@example.com' }) };
    const res = await request(buildApp(authService)).get('/auth/me').set('Cookie', `${SESSION_COOKIE_NAME}=sess-1`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 'u1', email: 'a@example.com' });
  });
});
