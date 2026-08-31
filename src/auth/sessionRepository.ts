import { PrismaClient, Session, User } from '@prisma/client';

export type SessionWithUser = Session & { user: User };

export class SessionRepository {
  constructor(private readonly prisma: PrismaClient) {}

  create(userId: string, expiresAt: Date): Promise<Session> {
    return this.prisma.session.create({ data: { userId, expiresAt } });
  }

  findValid(id: string, now: Date): Promise<SessionWithUser | null> {
    return this.prisma.session.findFirst({
      where: { id, expiresAt: { gt: now } },
      include: { user: true },
    });
  }

  async deleteById(id: string): Promise<void> {
    await this.prisma.session.deleteMany({ where: { id } });
  }
}
