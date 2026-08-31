import { PrismaClient, Playlist } from '@prisma/client';

export interface PlaylistTrackView {
  name: string;
  audioPath: string;
  coverPath: string | null;
}

export class PlaylistRepository {
  constructor(private readonly prisma: PrismaClient) {}

  create(userId: string, name: string): Promise<Playlist> {
    return this.prisma.playlist.create({ data: { userId, name } });
  }

  listByUser(userId: string): Promise<Playlist[]> {
    return this.prisma.playlist.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
  }

  findById(id: string): Promise<Playlist | null> {
    return this.prisma.playlist.findUnique({ where: { id } });
  }

  async listTracks(playlistId: string): Promise<PlaylistTrackView[]> {
    const rows = await this.prisma.playlistTrack.findMany({
      where: { playlistId },
      orderBy: { position: 'asc' },
      include: { track: true },
    });
    return rows.map((row) => ({
      name: row.track.name,
      audioPath: row.track.audioPath,
      coverPath: row.track.coverPath,
    }));
  }

  async replaceTracks(playlistId: string, trackIds: string[]): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.playlistTrack.deleteMany({ where: { playlistId } }),
      this.prisma.playlistTrack.createMany({
        data: trackIds.map((trackId, index) => ({ playlistId, trackId, position: index })),
      }),
    ]);
  }

  async deleteById(id: string): Promise<void> {
    await this.prisma.playlist.deleteMany({ where: { id } });
  }
}
