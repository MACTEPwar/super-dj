import * as fs from 'fs/promises';
import { posix as path } from 'path';
import { Track } from './types';

const AUDIO_EXTENSIONS = ['.mp3', '.wav', '.flac', '.m4a'];
const COVER_EXTENSIONS = ['.jpg', '.jpeg', '.png'];

export class Library {
  private tracks: Track[] = [];

  constructor(private readonly audioDir: string, private readonly defaultCoverPath: string) {}

  async scan(): Promise<Track[]> {
    const entries = await fs.readdir(this.audioDir);

    const audioFiles = entries
      .filter((entry) => AUDIO_EXTENSIONS.includes(path.extname(entry).toLowerCase()))
      .sort((a, b) => a.localeCompare(b));

    this.tracks = audioFiles.map((file) => {
      const base = path.basename(file, path.extname(file));
      const coverFile = COVER_EXTENSIONS
        .map((ext) => base + ext)
        .find((candidate) => entries.includes(candidate));

      return {
        name: base,
        audioPath: path.join(this.audioDir, file),
        coverPath: coverFile ? path.join(this.audioDir, coverFile) : null,
      };
    });

    return this.tracks;
  }

  list(): Track[] {
    return this.tracks;
  }

  findByName(name: string): Track | undefined {
    return this.tracks.find((track) => track.name === name);
  }
}
