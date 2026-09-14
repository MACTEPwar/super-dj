import { PrismaClient, StreamDestination } from '@prisma/client';

export class DestinationRepository {
  constructor(private readonly prisma: PrismaClient) {}

  create(data: {
    userId: string; name: string; provider: string; rtmpUrl: string | null; streamKeyEncrypted: string | null;
  }): Promise<StreamDestination> {
    return this.prisma.streamDestination.create({ data });
  }

  listByUser(userId: string): Promise<StreamDestination[]> {
    return this.prisma.streamDestination.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
  }

  findById(id: string): Promise<StreamDestination | null> {
    return this.prisma.streamDestination.findUnique({ where: { id } });
  }

  // Records (or clears) the reusable YouTube liveStream this destination pushes into. Cleared back
  // to null when YouTube no longer has that stream, so the next toggle-on creates a fresh one.
  async setYoutubeLiveStreamId(id: string, youtubeLiveStreamId: string | null): Promise<void> {
    await this.prisma.streamDestination.update({ where: { id }, data: { youtubeLiveStreamId } });
  }

  async deleteById(id: string): Promise<void> {
    await this.prisma.streamDestination.deleteMany({ where: { id } });
  }
}
