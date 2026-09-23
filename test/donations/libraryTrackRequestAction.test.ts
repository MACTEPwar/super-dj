import { executeLibraryTrackRequest, extractTrackId } from '../../src/donations/libraryTrackRequestAction';

const ID = '3f2b9c1e-8d4a-4e2b-9a7c-1b2c3d4e5f60';

function buildDeps(row: any = { id: ID, userId: 'target', name: 'Believer', audioPath: '/u/a.mp3', coverPath: null, overlayOverride: null }) {
  return {
    trackRepository: { findById: jest.fn(async (id: string) => (row && id === row.id ? row : null)) },
    streamInserter: { enqueueTrack: jest.fn() },
    targetUserId: 'target',
  };
}

describe('extractTrackId', () => {
  it.each([
    [`Believer ${ID}`, ID],
    [`Believer${ID}`, ID],
    [`Believer ${ID} thanks!!`, ID],
    [`${ID.toUpperCase()}`, ID],
    [`00000000-0000-0000-0000-000000000000 in name ${ID}`, ID],
  ])('%s -> last uuid', (query, expected) => {
    expect(extractTrackId(query)).toBe(expected);
  });

  it('returns null when there is no uuid', () => {
    expect(extractTrackId('Believer imagine dragons')).toBeNull();
  });
});

describe('executeLibraryTrackRequest', () => {
  let errorSpy: jest.SpyInstance;
  beforeEach(() => { errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {}); });
  afterEach(() => errorSpy.mockRestore());

  it('queues the owned library track next, as a real (non-ephemeral) track', async () => {
    const deps = buildDeps();
    const result = await executeLibraryTrackRequest(deps, `Believer ${ID}`);
    expect(result).toEqual({ ok: true });
    expect(deps.streamInserter.enqueueTrack).toHaveBeenCalledWith('target', {
      name: 'Believer', audioPath: '/u/a.mp3', coverPath: null, overlayOverride: null,
    });
    const track = deps.streamInserter.enqueueTrack.mock.calls[0][1];
    expect(track.ephemeral).toBeUndefined();
    expect(track._onFinished).toBeUndefined();
  });

  it('trackIdMissing when no uuid is present, without a DB call', async () => {
    const deps = buildDeps();
    const result = await executeLibraryTrackRequest(deps, 'Believer');
    expect(result).toMatchObject({ ok: false, reason: 'trackIdMissing' });
    expect(deps.trackRepository.findById).not.toHaveBeenCalled();
  });

  it('trackNotFound for an unknown id', async () => {
    const deps = buildDeps(null);
    expect(await executeLibraryTrackRequest(deps, ID)).toMatchObject({ ok: false, reason: 'trackNotFound' });
  });

  it("trackNotFound (same reason) for another user's track", async () => {
    const deps = buildDeps({ id: ID, userId: 'someone-else', name: 'x', audioPath: '/x', coverPath: null, overlayOverride: null });
    expect(await executeLibraryTrackRequest(deps, ID)).toMatchObject({ ok: false, reason: 'trackNotFound' });
    expect(deps.streamInserter.enqueueTrack).not.toHaveBeenCalled();
  });

  it('noActiveStream when the inserter throws', async () => {
    const deps = buildDeps();
    deps.streamInserter.enqueueTrack.mockImplementation(() => { throw new Error('local stream is not active'); });
    expect(await executeLibraryTrackRequest(deps, ID)).toMatchObject({ ok: false, reason: 'noActiveStream', message: 'local stream is not active' });
  });
});
