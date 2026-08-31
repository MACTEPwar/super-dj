import { Track } from './types';

export class PlaylistQueue {
  private baseTracks: Track[];
  private position: number;
  private currentTrack: Track | undefined;
  private history: Track[] = [];
  private insertedNext: Track | null = null;

  constructor(tracks: Track[]) {
    this.baseTracks = tracks;
    this.position = tracks.length > 0 ? 0 : -1;
    this.currentTrack = tracks[0];
  }

  current(): Track | undefined {
    return this.currentTrack;
  }

  peekNext(): Track | undefined {
    if (this.insertedNext) return this.insertedNext;
    if (this.baseTracks.length === 0) return undefined;
    return this.baseTracks[(this.position + 1) % this.baseTracks.length];
  }

  next(): Track | undefined {
    if (this.baseTracks.length === 0 && !this.insertedNext) return undefined;
    if (this.currentTrack) this.history.push(this.currentTrack);

    if (this.insertedNext) {
      this.currentTrack = this.insertedNext;
      this.insertedNext = null;
      return this.currentTrack;
    }

    this.position = (this.position + 1) % this.baseTracks.length;
    this.currentTrack = this.baseTracks[this.position];
    return this.currentTrack;
  }

  previous(): Track | undefined {
    if (this.history.length === 0) return this.currentTrack;

    const previousTrack = this.history.pop()!;
    const foundIndex = this.baseTracks.findIndex((t) => t.name === previousTrack.name);
    if (foundIndex >= 0) this.position = foundIndex;
    this.currentTrack = previousTrack;
    return this.currentTrack;
  }

  insertNext(track: Track): void {
    this.insertedNext = track;
  }

  setTracks(tracks: Track[]): void {
    this.baseTracks = tracks;
    if (this.currentTrack) {
      const foundIndex = tracks.findIndex((t) => t.name === this.currentTrack!.name);
      this.position = foundIndex >= 0 ? foundIndex : 0;
    } else {
      this.position = tracks.length > 0 ? 0 : -1;
      this.currentTrack = tracks[0];
    }
  }
}
