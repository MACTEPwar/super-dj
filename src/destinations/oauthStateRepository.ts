import { PrismaClient, OAuthState } from '@prisma/client';

export class OAuthStateRepository {
  constructor(private readonly prisma: PrismaClient) {}

  create(userId: string, provider: string, expiresAt: Date): Promise<OAuthState> {
    return this.prisma.oAuthState.create({ data: { userId, provider, expiresAt } });
  }

  findValid(id: string, provider: string, now: Date): Promise<OAuthState | null> {
    return this.prisma.oAuthState.findFirst({ where: { id, provider, expiresAt: { gt: now } } });
  }

  async deleteById(id: string): Promise<void> {
    await this.prisma.oAuthState.deleteMany({ where: { id } });
  }
}
