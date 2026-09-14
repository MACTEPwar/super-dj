import { PrismaClient } from '@prisma/client';

/**
 * A saved PRESET: the playlist, overlay template, destination checklist and broadcast metadata to
 * pre-populate the next local-stream start with. It is not "the running thing" — that is the one
 * in-memory local stream per account (see LocalStreamManager).
 *
 * The Prisma models behind this are still called StreamSession/StreamSessionDestination, so that
 * repurposing them cost no table rename and no data migration. This file is the boundary where the
 * old name stops.
 */
export interface StreamPresetRecord {
  id: string;
  userId: string;
  name: string;
  playlistId: string;
  templateId: string | null;
  title: string | null;
  description: string | null;
  privacyStatus: string | null;
  latencyPreference: string | null;
  createdAt: Date;
  destinationIds: string[];
}

export interface StreamPresetInput {
  name: string;
  playlistId: string;
  templateId: string | null;
  destinationIds: string[];
  title: string | null;
  description: string | null;
  privacyStatus: string | null;
  latencyPreference: string | null;
}

type PrismaStreamPreset = {
  id: string;
  userId: string;
  name: string;
  playlistId: string;
  templateId: string | null;
  title: string | null;
  description: string | null;
  privacyStatus: string | null;
  latencyPreference: string | null;
  createdAt: Date;
  destinations: { destinationId: string }[];
};

function toRecord(row: PrismaStreamPreset): StreamPresetRecord {
  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    playlistId: row.playlistId,
    templateId: row.templateId,
    title: row.title,
    description: row.description,
    privacyStatus: row.privacyStatus,
    latencyPreference: row.latencyPreference,
    createdAt: row.createdAt,
    destinationIds: row.destinations.map((d) => d.destinationId),
  };
}

export class StreamPresetRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(data: StreamPresetInput & { userId: string }): Promise<StreamPresetRecord> {
    const row = await this.prisma.streamSession.create({
      data: {
        userId: data.userId,
        name: data.name,
        playlistId: data.playlistId,
        templateId: data.templateId,
        title: data.title,
        description: data.description,
        privacyStatus: data.privacyStatus,
        latencyPreference: data.latencyPreference,
        destinations: { create: data.destinationIds.map((destinationId) => ({ destinationId })) },
      },
      include: { destinations: true },
    });
    return toRecord(row);
  }

  // A full replace, matching PUT semantics: the destination checklist is deleted and rewritten
  // rather than diffed, so a preset never keeps a destination the caller left out.
  async update(id: string, data: StreamPresetInput): Promise<StreamPresetRecord> {
    const row = await this.prisma.streamSession.update({
      where: { id },
      data: {
        name: data.name,
        playlistId: data.playlistId,
        templateId: data.templateId,
        title: data.title,
        description: data.description,
        privacyStatus: data.privacyStatus,
        latencyPreference: data.latencyPreference,
        destinations: {
          deleteMany: {},
          create: data.destinationIds.map((destinationId) => ({ destinationId })),
        },
      },
      include: { destinations: true },
    });
    return toRecord(row);
  }

  async findById(id: string): Promise<StreamPresetRecord | null> {
    const row = await this.prisma.streamSession.findUnique({ where: { id }, include: { destinations: true } });
    return row ? toRecord(row) : null;
  }

  async listByUser(userId: string): Promise<StreamPresetRecord[]> {
    const rows = await this.prisma.streamSession.findMany({
      where: { userId },
      include: { destinations: true },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(toRecord);
  }

  async deleteById(id: string): Promise<void> {
    await this.prisma.streamSession.deleteMany({ where: { id } });
  }
}
