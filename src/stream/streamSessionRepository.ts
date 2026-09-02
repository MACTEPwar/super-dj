import { PrismaClient } from '@prisma/client';

export interface StreamSessionRecord {
  id: string;
  userId: string;
  playlistId: string;
  title: string | null;
  description: string | null;
  privacyStatus: string | null;
  createdAt: Date;
  destinationIds: string[];
}

type PrismaStreamSession = {
  id: string;
  userId: string;
  playlistId: string;
  title: string | null;
  description: string | null;
  privacyStatus: string | null;
  createdAt: Date;
  destinations: { destinationId: string }[];
};

function toRecord(session: PrismaStreamSession): StreamSessionRecord {
  return {
    id: session.id,
    userId: session.userId,
    playlistId: session.playlistId,
    title: session.title,
    description: session.description,
    privacyStatus: session.privacyStatus,
    createdAt: session.createdAt,
    destinationIds: session.destinations.map((d) => d.destinationId),
  };
}

export class StreamSessionRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(data: {
    userId: string;
    playlistId: string;
    destinationIds: string[];
    title: string | null;
    description: string | null;
    privacyStatus: string | null;
  }): Promise<StreamSessionRecord> {
    const session = await this.prisma.streamSession.create({
      data: {
        userId: data.userId,
        playlistId: data.playlistId,
        title: data.title,
        description: data.description,
        privacyStatus: data.privacyStatus,
        destinations: { create: data.destinationIds.map((destinationId) => ({ destinationId })) },
      },
      include: { destinations: true },
    });
    return toRecord(session);
  }

  async findById(id: string): Promise<StreamSessionRecord | null> {
    const session = await this.prisma.streamSession.findUnique({ where: { id }, include: { destinations: true } });
    return session ? toRecord(session) : null;
  }

  async listByUser(userId: string): Promise<StreamSessionRecord[]> {
    const sessions = await this.prisma.streamSession.findMany({
      where: { userId },
      include: { destinations: true },
      orderBy: { createdAt: 'desc' },
    });
    return sessions.map(toRecord);
  }

  async deleteById(id: string): Promise<void> {
    await this.prisma.streamSession.deleteMany({ where: { id } });
  }
}
