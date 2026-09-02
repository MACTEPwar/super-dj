import { PrismaClient, Session } from '@prisma/client';

export type SessionWithUser = Session & { user: { id: string; email: string } };

export class SessionRepository {
  constructor(private readonly prisma: PrismaClient) {}

  create(userId: string, expiresAt: Date): Promise<Session> {
    return this.prisma.session.create({ data: { userId, expiresAt } });
  }

  findValid(id: string, now: Date): Promise<SessionWithUser | null> {
    return this.prisma.session.findFirst({
      where: { id, expiresAt: { gt: now } },
      // select only id/email on the nested user — never pull passwordHash into
      // an object that authMiddleware puts straight onto req.user and GET /auth/me echoes back
      include: { user: { select: { id: true, email: true } } },
    });
  }

  async deleteById(id: string): Promise<void> {
    await this.prisma.session.deleteMany({ where: { id } });
  }
}
