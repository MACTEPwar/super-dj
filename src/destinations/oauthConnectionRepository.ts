import { PrismaClient, OAuthConnection } from '@prisma/client';

export class OAuthConnectionRepository {
  constructor(private readonly prisma: PrismaClient) {}

  create(data: {
    destinationId: string; provider: string; externalAccountId: string; externalAccountName: string; refreshTokenEncrypted: string;
  }): Promise<OAuthConnection> {
    return this.prisma.oAuthConnection.create({ data });
  }

  findByDestinationId(destinationId: string): Promise<OAuthConnection | null> {
    return this.prisma.oAuthConnection.findUnique({ where: { destinationId } });
  }
}
