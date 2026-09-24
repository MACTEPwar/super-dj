import { Track } from './types';
import { WindowRow } from './window';

interface QueueEntry {
  track: Track;
  key: string;
}

export class PlaylistQueue {
  private baseTracks: Track[];
  private position: number;
  private currentTrack: Track | undefined;
  private history: QueueEntry[] = [];
  private insertedQueue: QueueEntry[] = [];
  private currentKey: string;
  private insertSeq = 0;

  constructor(tracks: Track[]) {
    this.baseTracks = tracks;
    this.position = tracks.length > 0 ? 0 : -1;
    this.currentTrack = tracks[0];
    this.currentKey = 'b:0';
  }

  current(): Track | undefined {
    return this.currentTrack;
  }

  peekNext(): Track | undefined {
    if (this.insertedQueue.length > 0) return this.insertedQueue[0].track;
    if (this.baseTracks.length === 0) return undefined;
    return this.baseTracks[(this.position + 1) % this.baseTracks.length];
  }

  next(): Track | undefined {
    if (this.baseTracks.length === 0 && this.insertedQueue.length === 0) return undefined;
    if (this.currentTrack && !this.currentTrack.ephemeral) {
      this.history.push({ track: this.currentTrack, key: this.currentKey });
    }

    if (this.insertedQueue.length > 0) {
      const entry = this.insertedQueue.shift()!;
      this.currentTrack = entry.track;
      this.currentKey = entry.key;
      return this.currentTrack;
    }

    this.position = (this.position + 1) % this.baseTracks.length;
    this.currentTrack = this.baseTracks[this.position];
    this.currentKey = `b:${this.position}`;
    return this.currentTrack;
  }

  previous(): Track | undefined {
    if (this.history.length === 0) return this.currentTrack;

    const entry = this.history.pop()!;
    const foundIndex = this.baseTracks.findIndex((t) => t.name === entry.track.name);
    if (foundIndex >= 0) this.position = foundIndex;
    this.currentTrack = entry.track;
    this.currentKey = entry.key;
    return this.currentTrack;
  }

  insertNext(track: Track): void {
    this.insertedQueue.push({ track, key: `i:${this.insertSeq++}` });
  }

  // The base-playlist index most recently reached by REAL advancement. An inserted track (a
  // play-by-name pick from the whole library, or any donation request) is never part of
  // baseTracks, so while one is current this still points at the base track it follows. Exposed
  // for tests; windowSnapshot() below reads the same underlying `position` field directly rather
  // than calling this method, but the value and its meaning are identical.
  positionInBase(): number {
    return this.position;
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
    this.currentKey = `b:${this.position}`;
  }

  windowSnapshot(before: number, after: number): WindowRow[] {
    if (!this.currentTrack) return [];
    const rows: WindowRow[] = [];
    const insertedIsCurrent = this.currentKey.startsWith('i:');
    const anchor = this.position;
    if (this.baseTracks.length > 0 && anchor >= 0) {
      // Same before-context semantics the old buildPlaylistWindowLines/buildInsertedTrackWindowLines
      // had: base rows before the current base track, or — while an inserted track is current —
      // ending at (and including) the base track it follows.
      const end = insertedIsCurrent ? anchor : anchor - 1;
      const start = Math.max(0, end - before + 1);
      for (let i = start; i <= end; i += 1) {
        rows.push({ key: `b:${i}`, text: `  ${this.baseTracks[i].name}`, isCurrent: false });
      }
    }
    rows.push({ key: this.currentKey, text: `▶ ${this.currentTrack.name}`, isCurrent: true });
    let remaining = after;
    for (const entry of this.insertedQueue) {
      if (remaining <= 0) break;
      rows.push({ key: entry.key, text: `  ${entry.track.name}`, isCurrent: false });
      remaining -= 1;
    }
    for (let i = anchor + 1; i < this.baseTracks.length && remaining > 0; i += 1, remaining -= 1) {
      rows.push({ key: `b:${i}`, text: `  ${this.baseTracks[i].name}`, isCurrent: false });
    }
    return rows;
  }
}
