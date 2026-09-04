import { loadFontData } from '../../src/render/fontCache';
import * as fs from 'fs/promises';

jest.mock('fs/promises');

describe('loadFontData', () => {
  beforeEach(() => jest.clearAllMocks());

  it('reads each distinct path from disk only once, even when called out of order', async () => {
    (fs.readFile as jest.Mock)
      .mockImplementation((p: string) => Promise.resolve(Buffer.from(p)));

    await loadFontData('/fonts/a.ttf');
    await loadFontData('/fonts/b.ttf');
    const a2 = await loadFontData('/fonts/a.ttf');

    expect(fs.readFile).toHaveBeenCalledTimes(2);
    expect(a2.toString()).toBe('/fonts/a.ttf');
  });
});
