import { PrismaClient, Prisma, Track } from '@prisma/client';
import { ColorValue } from '../templates/templateTypes';

export interface TrackOverlayOverride {
  color?: ColorValue;
  backgroundColor?: ColorValue;
}

// TrackOverlayOverride's shape is fully JSON-compatible, but structurally doesn't satisfy
// Prisma's InputJsonValue (which requires an index signature) — same escape hatch
// templateRepository.ts's toJson() uses for TemplateElement[].
function toJson(override: TrackOverlayOverride): Prisma.InputJsonValue {
  return override as unknown as Prisma.InputJsonValue;
}

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

  async updateOverlayOverride(trackId: string, override: TrackOverlayOverride | null): Promise<void> {
    await this.prisma.track.update({ where: { id: trackId }, data: { overlayOverride: override ? toJson(override) : Prisma.DbNull } });
  }
}
