import { PrismaClient, StreamDestination } from '@prisma/client';

export class DestinationRepository {
  constructor(private readonly prisma: PrismaClient) {}

  create(data: {
    userId: string; name: string; rtmpUrl: string; streamKeyEncrypted: string;
  }): Promise<StreamDestination> {
    return this.prisma.streamDestination.create({ data });
  }

  listByUser(userId: string): Promise<StreamDestination[]> {
    return this.prisma.streamDestination.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
  }

  findById(id: string): Promise<StreamDestination | null> {
    return this.prisma.streamDestination.findUnique({ where: { id } });
  }

  async deleteById(id: string): Promise<void> {
    await this.prisma.streamDestination.deleteMany({ where: { id } });
  }
}
