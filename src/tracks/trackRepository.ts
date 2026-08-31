import { PrismaClient, Track } from '@prisma/client';

export class TrackRepository {
  constructor(private readonly prisma: PrismaClient) {}

  create(data: {
    id: string; userId: string; name: string; audioPath: string; coverPath: string | null; durationSeconds: number;
  }): Promise<Track> {
    return this.prisma.track.create({ data });
  }

  listByUser(userId: string): Promise<Track[]> {
    return this.prisma.track.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
  }

  findById(id: string): Promise<Track | null> {
    return this.prisma.track.findUnique({ where: { id } });
  }

  async deleteById(id: string): Promise<void> {
    await this.prisma.track.deleteMany({ where: { id } });
  }
}
