import { Library } from '../../src/playlist/library';
import * as fs from 'fs/promises';

jest.mock('fs/promises');
const mockedReaddir = fs.readdir as jest.MockedFunction<typeof fs.readdir>;

describe('Library', () => {
  beforeEach(() => {
    mockedReaddir.mockReset();
  });

  it('scans audio files sorted alphabetically with matching covers', async () => {
    mockedReaddir.mockResolvedValue(['b.mp3', 'a.mp3', 'a.png', 'readme.txt'] as any);
    const library = new Library('/music', '/assets/default.png');

    const tracks = await library.scan();

    expect(tracks.map((t) => t.name)).toEqual(['a', 'b']);
    expect(tracks[0].coverPath).toBe('/music/a.png');
    expect(tracks[1].coverPath).toBeNull();
  });

  it('findByName returns the matching track after scan', async () => {
    mockedReaddir.mockResolvedValue(['song.mp3'] as any);
    const library = new Library('/music', '/assets/default.png');
    await library.scan();

    expect(library.findByName('song')?.audioPath).toBe('/music/song.mp3');
    expect(library.findByName('missing')).toBeUndefined();
  });

  it('list returns an empty array before scan', () => {
    const library = new Library('/music', '/assets/default.png');
    expect(library.list()).toEqual([]);
  });
});
