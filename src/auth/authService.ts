import { ApiError } from '../errors';
import { hashPassword, verifyPassword } from './passwordHash';

export interface AuthUser {
  id: string;
  email: string;
}

export interface UserRepositoryLike {
  create(email: string, passwordHash: string): Promise<{ id: string; email: string; passwordHash: string }>;
  findByEmail(email: string): Promise<{ id: string; email: string; passwordHash: string } | null>;
}

export interface SessionRepositoryLike {
  create(userId: string, expiresAt: Date): Promise<{ id: string; expiresAt: Date }>;
  findValid(id: string, now: Date): Promise<{ id: string; expiresAt: Date; user: AuthUser } | null>;
  deleteById(id: string): Promise<void>;
}

export interface AuthResult {
  user: AuthUser;
  sessionId: string;
  expiresAt: Date;
}

export interface AuthServiceDeps {
  userRepository: UserRepositoryLike;
  sessionRepository: SessionRepositoryLike;
  sessionTtlDays: number;
}

export class AuthService {
  constructor(private readonly deps: AuthServiceDeps) {}

  async register(email: string, password: string): Promise<AuthResult> {
    const existing = await this.deps.userRepository.findByEmail(email);
    if (existing) throw new ApiError(409, 'email is already registered');

    const passwordHash = await hashPassword(password);
    const user = await this.deps.userRepository.create(email, passwordHash);
    return this.createSession({ id: user.id, email: user.email });
  }

  async login(email: string, password: string): Promise<AuthResult> {
    const user = await this.deps.userRepository.findByEmail(email);
    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      throw new ApiError(401, 'invalid email or password');
    }
    return this.createSession({ id: user.id, email: user.email });
  }

  async logout(sessionId: string): Promise<void> {
    await this.deps.sessionRepository.deleteById(sessionId);
  }

  async getCurrentUser(sessionId: string | null): Promise<AuthUser | null> {
    if (!sessionId) return null;
    const session = await this.deps.sessionRepository.findValid(sessionId, new Date());
    return session ? session.user : null;
  }

  private async createSession(user: AuthUser): Promise<AuthResult> {
    const expiresAt = new Date(Date.now() + this.deps.sessionTtlDays * 24 * 60 * 60 * 1000);
    const session = await this.deps.sessionRepository.create(user.id, expiresAt);
    return { user, sessionId: session.id, expiresAt: session.expiresAt };
  }
}
