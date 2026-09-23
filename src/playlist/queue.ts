import { Track } from './types';

export class PlaylistQueue {
  private baseTracks: Track[];
  private position: number;
  private currentTrack: Track | undefined;
  private history: Track[] = [];
  private insertedQueue: Track[] = [];
  // A SEPARATE FIFO from insertedQueue — donation song requests never touch position/history/
  // insertedQueue at all (see StreamController's interrupt/resume mechanism). Keeping them apart
  // means playByName's "play after the current track ends, join history normally" semantics are
  // completely unaffected by the donation flow's "interrupt immediately, never enter history"
  // semantics — two genuinely different behaviors sharing one FIFO would have meant every read of
  // insertedQueue had to reason about which kind of entry it might be.
  private donationQueue: Track[] = [];

  constructor(tracks: Track[]) {
    this.baseTracks = tracks;
    this.position = tracks.length > 0 ? 0 : -1;
    this.currentTrack = tracks[0];
  }

  current(): Track | undefined {
    return this.currentTrack;
  }

  peekNext(): Track | undefined {
    if (this.insertedQueue.length > 0) return this.insertedQueue[0];
    if (this.baseTracks.length === 0) return undefined;
    return this.baseTracks[(this.position + 1) % this.baseTracks.length];
  }

  next(): Track | undefined {
    if (this.baseTracks.length === 0 && this.insertedQueue.length === 0) return undefined;
    if (this.currentTrack && !this.currentTrack.ephemeral) this.history.push(this.currentTrack);

    if (this.insertedQueue.length > 0) {
      this.currentTrack = this.insertedQueue.shift();
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
    this.insertedQueue.push(track);
  }

  // The base-playlist index most recently reached by REAL advancement — i.e. never moved by a
  // donation track, which is never part of baseTracks. Lets the overlay build sensible
  // before/after context around a donation track that isn't itself findable in the playlist's own
  // track array (see StreamController.feedCurrentTrack and streamScene.ts's buildOverlay).
  positionInBase(): number {
    return this.position;
  }

  enqueueDonation(track: Track): void {
    this.donationQueue.push(track);
  }

  hasDonationPending(): boolean {
    return this.donationQueue.length > 0;
  }

  // Pops directly off the donation FIFO with NO other side effect — position/history/currentTrack
  // are untouched, so queue.current() keeps pointing at whatever real playlist track a donation
  // interruption is standing in front of, for the whole time donation tracks are playing.
  shiftDonation(): Track | undefined {
    return this.donationQueue.shift();
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
