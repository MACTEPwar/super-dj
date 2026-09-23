# Donation Library-Track Requests — Phase B (one queue, no interrupt) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Donation-requested tracks stop interrupting playback and are queued "next" through the same single FIFO `play`-by-name uses, with every interrupt-only code path deleted and the temp-file holes this opens closed.

**Architecture:** `PlaylistQueue.insertNext()` becomes the only "queue this next" mechanism; `StreamController.enqueueTrack()` (renamed from `insertEphemeralTrack`) is two lines, and `playByName` delegates to it. A new `Track.ephemeral` flag keeps one-off temp-file tracks out of `history`, and `next()`/`previous()` release (delete) an ephemeral track they skip off.

**Tech Stack:** TypeScript, Jest (ts-jest), Node 20.

**Spec:** `docs/superpowers/specs/2026-09-23-donation-library-track-request-design.md` — section "Phase B", edge cases B1–B9, judgment calls #8/#9.

## Global Constraints

- Phase order is B → A → C; this plan must leave the repo fully green (`npm test`, `npm run build`) at every commit.
- Unit tests never spawn real ffmpeg; use the existing fake-child / plain-object fake patterns in `test/stream/streamController.test.ts` (CLAUDE.md "Testing strategy").
- The renamed method is exactly `enqueueTrack(track: Track): void` on `StreamController`, and `enqueueTrack(userId: string, track: Track): void` on `LocalStreamManager` and on `songRequestAction.ts`'s `StreamInserter` interface.
- `Track.ephemeral?: true` — set only by `songRequestAction.ts`, alongside `_onFinished`.
- Commit trailer for every commit: `Co-Authored-By: Claude Opus <noreply@anthropic.com>` (the model doing the implementing may differ; use the trailer for the model that actually makes the commit).
- No frontend changes in this phase.

## Review Focus

- A donation track that finished playing must never be replayable via `previous()` (its file is gone) — pinned in Task 1 (queue) and Task 2 (controller).
- Skipping a playing donation track with `next()`/`previous()` must delete its temp file exactly once — pinned in Task 2.
- `status().currentTrack` must be `null` for an idle/stopped controller, not the queue's first track — pinned in Task 2.
- A donation arriving while paused must NOT resume playback — pinned in Task 2.
- A reconnect that happens while a donation track is current must resume that same track at its offset (it's now just `queue.current()`) — pinned in Task 2.

---

### Task 1: `Track.ephemeral` and keeping ephemeral tracks out of `history`

**Files:**
- Modify: `src/playlist/types.ts`
- Modify: `src/playlist/queue.ts` (`next()`)
- Test: `test/playlist/queue.test.ts`

**Interfaces:**
- Produces: `Track.ephemeral?: true`; `PlaylistQueue.next()` no longer pushes a track whose `ephemeral === true` onto `history`.

- [ ] **Step 1: Write the failing tests** — append inside the top-level `describe('PlaylistQueue', ...)` in `test/playlist/queue.test.ts`:

```ts
  describe('ephemeral tracks', () => {
    const ephemeral = (name: string): Track => ({ name, audioPath: `/tmp/${name}.mp3`, coverPath: null, ephemeral: true });

    it('an ephemeral track plays once from the inserted FIFO but never enters history', () => {
      const queue = new PlaylistQueue([track('a'), track('b'), track('c')]);
      queue.insertNext(ephemeral('donation'));
      expect(queue.next()?.name).toBe('donation');
      expect(queue.next()?.name).toBe('b');
      // history is [a] — the donation was skipped over when it stopped being current
      expect(queue.previous()?.name).toBe('a');
      expect(queue.previous()?.name).toBe('a');
    });

    it('a non-ephemeral inserted track still joins history (play-by-name semantics unchanged)', () => {
      const queue = new PlaylistQueue([track('a'), track('b')]);
      queue.insertNext(track('z'));
      queue.next(); // z
      queue.next(); // b
      expect(queue.previous()?.name).toBe('z');
    });
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest test/playlist/queue.test.ts`
Expected: FAIL — TypeScript error "Object literal may only specify known properties, and 'ephemeral' does not exist in type 'Track'".

- [ ] **Step 3: Implement**

`src/playlist/types.ts` — add after `_onFinished`:

```ts
  // Set only on a one-off, temp-file track (a donation song request — see songRequestAction.ts),
  // always together with _onFinished. Unlike _onFinished (self-disarming: cleared once it fires,
  // so unreadable after the fact) this stays set, which is what lets PlaylistQueue keep such a
  // track out of `history`: its file is deleted the moment it finishes, so previous() must never
  // be able to reach it again.
  ephemeral?: true;
```

`src/playlist/queue.ts` — in `next()`, replace
`if (this.currentTrack) this.history.push(this.currentTrack);` with:

```ts
    if (this.currentTrack && !this.currentTrack.ephemeral) this.history.push(this.currentTrack);
```

- [ ] **Step 4: Run to verify pass**

Run: `npx jest test/playlist/queue.test.ts`
Expected: PASS (all, including the existing donation-queue suite, which is untouched in this task).

- [ ] **Step 5: Commit**

```bash
git add src/playlist/types.ts src/playlist/queue.ts test/playlist/queue.test.ts
git commit -m "feat(queue): keep ephemeral (temp-file) tracks out of history"
```

---

### Task 2: Remove interrupt/resume from `StreamController`; rename to `enqueueTrack` end to end

**Files:**
- Modify: `src/stream/streamController.ts`
- Modify: `src/stream/localStreamManager.ts:269-275`
- Modify: `src/donations/songRequestAction.ts`
- Test: `test/stream/streamController.test.ts`, `test/stream/localStreamManager.test.ts`, `test/donations/songRequestAction.test.ts`

**Interfaces:**
- Consumes: `Track.ephemeral` (Task 1).
- Produces: `StreamController.enqueueTrack(track: Track): void`; `LocalStreamManager.enqueueTrack(userId: string, track: Track): void`; `StreamInserter { enqueueTrack(userId: string, track: Track): void }`. Phase A calls `LocalStreamManager.enqueueTrack`; Phase C hooks `StreamController.enqueueTrack`.

- [ ] **Step 1: Delete the obsolete controller tests**

In `test/stream/streamController.test.ts` delete these `it(...)` blocks entirely (search by title):
- `'a donation interruption in progress survives a crash: the reconnect resumes the donation track itself, not queue.current() (the track it interrupted)'`
- `'pause()/resume() while a donation track is playing act on the donation track itself, not the track it interrupted'`
- `'insertEphemeralTrack() enqueues onto the donation queue and interrupts whatever is playing immediately'`
- `'a second donation arriving while the first one is already playing just queues behind it, without re-interrupting'`
- `'resumes the interrupted track at its captured elapsed position once the donation queue drains'`
- `'plays multiple queued donation tracks back to back, in FIFO order, before resuming the interrupted track'`
- `'a donation arriving while paused wakes the stream and plays it right away'`
- `'a donation arriving while idle just queues — nothing plays until a stream is actually started'`
- `'next()/previous() reject while a donation track is playing — a donation track cannot be skipped'`

In `buildDeps()` remove the three queue fakes `enqueueDonation`, `hasDonationPending`, `shiftDonation`.

- [ ] **Step 2: Write the new failing tests** — add after the `'playByName() throws 404 for an unknown track'` test:

```ts
  describe('enqueueTrack (donation requests queue next, never interrupt)', () => {
    const donation = (onFinished = jest.fn()): Track => ({
      name: 'donation', audioPath: '/tmp/d.mp3', coverPath: null, ephemeral: true, _onFinished: onFinished,
    });

    it('inserts next without switching what is playing', async () => {
      const { deps, queue, audioRelay } = buildDeps();
      const controller = new StreamController(deps);
      await controller.start();
      audioRelay.switchTrack.mockClear();
      const d = donation();

      controller.enqueueTrack(d);

      expect(queue.insertNext).toHaveBeenCalledWith(d);
      expect(audioRelay.switchTrack).not.toHaveBeenCalled();
      expect(controller.status().state).toBe('streaming');
    });

    it('while paused it only queues — the stream stays paused', async () => {
      const { deps, audioRelay } = buildDeps();
      const controller = new StreamController(deps);
      await controller.start();
      controller.pause();
      audioRelay.switchTrack.mockClear();

      controller.enqueueTrack(donation());

      expect(audioRelay.switchTrack).not.toHaveBeenCalled();
      expect(controller.status().state).toBe('paused');
    });

    it('while idle it only queues', () => {
      const { deps, queue, audioRelay } = buildDeps();
      const controller = new StreamController(deps);
      const d = donation();
      controller.enqueueTrack(d);
      expect(queue.insertNext).toHaveBeenCalledWith(d);
      expect(audioRelay.switchTrack).not.toHaveBeenCalled();
    });

    it('notifies onStatusChanged', () => {
      const { deps } = buildDeps();
      deps.onStatusChanged = jest.fn();
      const controller = new StreamController(deps);
      controller.enqueueTrack(donation());
      expect(deps.onStatusChanged).toHaveBeenCalled();
    });

    it('playByName goes through the same insert (one insert path)', async () => {
      const { deps, queue } = buildDeps();
      const controller = new StreamController(deps);
      const spy = jest.spyOn(controller, 'enqueueTrack');
      controller.playByName('b');
      expect(spy).toHaveBeenCalledWith({ name: 'b', audioPath: '/music/b.mp3', coverPath: null });
      expect(queue.insertNext).toHaveBeenCalledTimes(1);
    });
  });

  describe('releasing a skipped ephemeral track', () => {
    it('next() off a playing ephemeral track fires its _onFinished exactly once', async () => {
      const { deps, queue } = buildDeps();
      const onFinished = jest.fn();
      const d: Track = { name: 'donation', audioPath: '/tmp/d.mp3', coverPath: null, ephemeral: true, _onFinished: onFinished };
      const controller = new StreamController(deps);
      await controller.start();
      queue.current.mockReturnValue(d);

      await controller.next();

      expect(onFinished).toHaveBeenCalledTimes(1);
      expect(d._onFinished).toBeUndefined();
    });

    it('previous() off a playing ephemeral track fires its _onFinished exactly once', async () => {
      const { deps, queue } = buildDeps();
      const onFinished = jest.fn();
      const d: Track = { name: 'donation', audioPath: '/tmp/d.mp3', coverPath: null, ephemeral: true, _onFinished: onFinished };
      const controller = new StreamController(deps);
      await controller.start();
      queue.current.mockReturnValue(d);
      queue.previous.mockReturnValueOnce(track('a'));

      await controller.previous();

      expect(onFinished).toHaveBeenCalledTimes(1);
    });

    it('previous() that stays on the same track (empty history) releases nothing', async () => {
      const { deps, queue } = buildDeps();
      const onFinished = jest.fn();
      const d: Track = { name: 'donation', audioPath: '/tmp/d.mp3', coverPath: null, ephemeral: true, _onFinished: onFinished };
      const controller = new StreamController(deps);
      await controller.start();
      queue.current.mockReturnValue(d);
      queue.previous.mockReturnValueOnce(d);

      await controller.previous();

      expect(onFinished).not.toHaveBeenCalled();
    });

    it('a throwing _onFinished on skip is logged, not thrown', async () => {
      const { deps, queue } = buildDeps();
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const d: Track = { name: 'donation', audioPath: '/tmp/d.mp3', coverPath: null, ephemeral: true, _onFinished: () => { throw new Error('boom'); } };
        const controller = new StreamController(deps);
        await controller.start();
        queue.current.mockReturnValue(d);
        await expect(controller.next()).resolves.toBeUndefined();
        expect(errorSpy).toHaveBeenCalled();
      } finally {
        errorSpy.mockRestore();
      }
    });
  });

  describe('status().currentTrack', () => {
    it('is null before start and after stop, the current track name while streaming/paused', async () => {
      const { deps } = buildDeps();
      const controller = new StreamController(deps);
      expect(controller.status().currentTrack).toBeNull();
      await controller.start();
      expect(controller.status().currentTrack).toBe('a');
      controller.pause();
      expect(controller.status().currentTrack).toBe('a');
      controller.stop();
      expect(controller.status().currentTrack).toBeNull();
    });
  });
```

Also replace the existing test `'playByName() inserts into the queue without switching immediately'` body's expectation only if it now fails — it should still pass unchanged.

- [ ] **Step 3: Run to verify failure**

Run: `npx jest test/stream/streamController.test.ts`
Expected: FAIL — `controller.enqueueTrack is not a function` (and TS errors on the missing method).

- [ ] **Step 4: Implement in `src/stream/streamController.ts`**

1. Delete the fields `nowPlayingTrack` and `interruptedForDonation` with their comments.
2. `resume()`: replace the body's track line and its comment with `const track = this.deps.queue.current();`.
3. `next()`: delete the `interruptedForDonation` 409 line, and release the skipped track:

```ts
  async next(): Promise<void> {
    if (this.state === 'idle' || this.state === 'error') throw new ApiError(409, 'stream is not active');
    const before = this.deps.queue.current();
    const track = this.deps.queue.next();
    if (!track) throw new ApiError(409, 'no tracks in queue');
    if (before && before !== track) this.releaseTrack(before);
    this.pausedElapsedSeconds = 0;
    if (this.state === 'streaming') {
      await this.feedCurrentTrack(track);
    }
    this.deps.onStatusChanged?.();
  }

  async previous(): Promise<void> {
    if (this.state === 'idle' || this.state === 'error') throw new ApiError(409, 'stream is not active');
    const before = this.deps.queue.current();
    const track = this.deps.queue.previous();
    if (before && track && before !== track) this.releaseTrack(before);
    this.pausedElapsedSeconds = 0;
    if (track && this.state === 'streaming') {
      await this.feedCurrentTrack(track);
    }
    this.deps.onStatusChanged?.();
  }
```

4. In `feedCurrentTrack()`: delete `this.nowPlayingTrack = track;`. Replace the `close` handler's hook block and `this.advanceAfterTrackFinished();` with:

```ts
    child.once('close', () => {
      if (generation !== this.sessionGeneration) return;
      if (this.state !== 'streaming') return;
      this.releaseTrack(track);
      this.advanceToNextTrack();
    });
```

5. Delete `advanceAfterTrackFinished()`, `playNextDonationTrack()`, `interruptCurrentTrackForDonation()` entirely. Add:

```ts
  // Fires a one-off track's cleanup hook once it stops being the current track — naturally (the
  // decode 'close' above) or because next()/previous() moved off it mid-play. Self-disarming:
  // track objects can be re-fed (a non-ephemeral one via previous()), so the hook is cleared
  // before it's invoked and can never fire twice. A throwing hook is logged, never propagated —
  // it must not skip auto-advance or reject a transport command.
  private releaseTrack(track: Track): void {
    const onFinished = track._onFinished;
    track._onFinished = undefined;
    try {
      onFinished?.();
    } catch (err) {
      console.error('a track\'s _onFinished hook threw', err);
    }
  }
```

6. `teardown()`: delete the `nowPlayingTrack`/`interruptedForDonation` resets.
7. `handleUnexpectedExit()`: `const capturedTrack = this.deps.queue.current();`; delete `wasInterruptedForDonation` and its restore line after `teardown()`; update the comment above the captures to drop the donation wording.
8. `performReconnect()`: delete the whole `if (this.interruptedForDonation !== null) { ... }` block and its comment.
9. Replace `playByName` and `insertEphemeralTrack` with:

```ts
  playByName(name: string): void {
    const track = this.deps.library.findByName(name);
    if (!track) throw new ApiError(404, `track not found: ${name}`);
    this.enqueueTrack(track);
  }

  // The ONE "queue this next" path: plays after the current track ends, never interrupts, joins
  // history normally unless ephemeral (see PlaylistQueue.next()). Used by playByName and by every
  // donation request (free-text via songRequestAction.ts, exact via libraryTrackRequestAction.ts).
  enqueueTrack(track: Track): void {
    this.deps.queue.insertNext(track);
    this.deps.onStatusChanged?.();
  }
```

10. `status()`:

```ts
  status(): StreamStatus {
    // Only while a session exists: an idle/errored controller keeps its queue (the entry survives
    // stop()), and reporting queue.current() then would claim a track is playing when none is.
    const live = this.state === 'streaming' || this.state === 'paused' || this.state === 'reconnecting';
    return {
      state: this.state,
      currentTrack: live ? this.deps.queue.current()?.name ?? null : null,
      nextTrack: this.deps.queue.peekNext()?.name ?? null,
    };
  }
```

- [ ] **Step 5: Run controller tests**

Run: `npx jest test/stream/streamController.test.ts`
Expected: PASS. If an older test asserted `currentTrack` while `reconnecting` was `null`, update it to expect the track name (reconnecting now reports the track — spec B7) and note it in the commit message.

- [ ] **Step 6: Rename through `LocalStreamManager` and `songRequestAction.ts`**

`src/stream/localStreamManager.ts`:

```ts
  enqueueTrack(userId: string, track: Track): void {
    this.require(userId).controller.enqueueTrack(track);
  }
```

`src/donations/songRequestAction.ts`: rename the interface method to `enqueueTrack(userId: string, track: Track): void`; build the track with the flag:

```ts
  const track: Track = {
    name: `🎁 Заказ: ${query}`,
    audioPath: filePath,
    coverPath: null,
    ephemeral: true,
  };
```

and call `deps.streamInserter.enqueueTrack(deps.targetUserId, track);`. Update the top-of-function comment ("inserts it as a one-off next track" stays accurate).

In `test/stream/localStreamManager.test.ts` and `test/donations/songRequestAction.test.ts` rename every `insertEphemeralTrack` to `enqueueTrack`, and add to the success-path test in `songRequestAction.test.ts`:

```ts
    const inserted = streamInserter.enqueueTrack.mock.calls[0][1];
    expect(inserted.ephemeral).toBe(true);
    expect(typeof inserted._onFinished).toBe('function');
```

(adapt `streamInserter` to that file's fake variable name).

- [ ] **Step 7: Run everything touched plus the type check**

Run: `npx jest test/stream test/donations test/playlist` then `npm run build`
Expected: PASS, and tsc exits 0 (`server.ts` passes `localStreamManager` as `streamInserter` structurally, so it compiles with the rename).

- [ ] **Step 8: Commit**

```bash
git add src/stream/streamController.ts src/stream/localStreamManager.ts src/donations/songRequestAction.ts test/stream/streamController.test.ts test/stream/localStreamManager.test.ts test/donations/songRequestAction.test.ts
git commit -m "feat(stream): queue donation tracks next instead of interrupting; rename to enqueueTrack"
```

---

### Task 3: Delete the donation FIFO; rename the inserted-track window builder; docs

**Files:**
- Modify: `src/playlist/queue.ts`
- Modify: `src/ffmpeg/overlayText.ts`, `src/stream/streamScene.ts`
- Modify: `CLAUDE.md`
- Test: `test/playlist/queue.test.ts`, `test/ffmpeg/overlayText.test.ts`

**Interfaces:**
- Produces: `buildInsertedTrackWindowLines(tracks, baseAnchorIndex, currentTrackName, before, after)` (same signature as the old `buildEphemeralPlaylistWindowLines`). `positionInBase()` stays.

- [ ] **Step 1: Update tests first**

`test/playlist/queue.test.ts`: delete the whole `describe('donation queue', ...)` block and add:

```ts
  it('positionInBase stays on the base track while an inserted track is current', () => {
    const queue = new PlaylistQueue([track('a'), track('b'), track('c')]);
    queue.next(); // b
    queue.insertNext(track('z'));
    queue.next(); // z
    expect(queue.current()?.name).toBe('z');
    expect(queue.positionInBase()).toBe(1);
  });
```

`test/ffmpeg/overlayText.test.ts`: rename every `buildEphemeralPlaylistWindowLines` to `buildInsertedTrackWindowLines` (import and calls).

- [ ] **Step 2: Run to verify failure**

Run: `npx jest test/playlist/queue.test.ts test/ffmpeg/overlayText.test.ts`
Expected: FAIL — `buildInsertedTrackWindowLines` is not exported.

- [ ] **Step 3: Implement**

`src/playlist/queue.ts`: delete `donationQueue` (and its comment block), `enqueueDonation`, `hasDonationPending`, `shiftDonation`. Replace the `positionInBase()` comment with:

```ts
  // The base-playlist index most recently reached by REAL advancement. An inserted track (a
  // play-by-name pick from the whole library, or any donation request) is never part of
  // baseTracks, so while one is current this still points at the base track it follows — which
  // is what lets the overlay build before/after context around a track it can't find by name
  // (see streamScene.ts's buildOverlay and overlayText.ts's buildInsertedTrackWindowLines).
```

`src/ffmpeg/overlayText.ts`: rename the function to `buildInsertedTrackWindowLines`, and replace its leading comment with:

```ts
// The counterpart used while the current track is an INSERTED one (queued via insertNext — a
// play-by-name pick from outside this playlist, or a donation request): it isn't found by name in
// `tracks`, so buildPlaylistWindowLines' own currentIndex lookup misses and would render an empty
// window for the whole time it plays. baseAnchorIndex is PlaylistQueue.positionInBase() — the
// base track it follows — so "before" ends at (and includes) that track, the inserted track is
// marked ▶ after it, and "after" continues where the base playlist will pick back up.
```

`src/stream/streamScene.ts`: update the import and call to `buildInsertedTrackWindowLines`; replace the `buildOverlay` comment "A donation-requested track is never in this playlist's own snapshot …" with "An inserted track (play-by-name from outside this playlist, or a donation request) isn't in this playlist's own snapshot — …", and the `StreamScene.buildOverlay` doc comment's "a donation track" with "an inserted track".

- [ ] **Step 4: Run the full suite and type check**

Run: `npm test` then `npm run build`
Expected: all green; tsc exits 0. Then run the leftover-reference check with the Grep tool (not shell grep) for `enqueueDonation|shiftDonation|hasDonationPending|interruptedForDonation|nowPlayingTrack|insertEphemeralTrack|buildEphemeralPlaylistWindowLines` over `src/` and `test/` — expected: no matches.

- [ ] **Step 5: Update CLAUDE.md**

In "Donation-triggered song requests":
- In the first paragraph replace "**interrupts whatever is currently playing to play it immediately** — not queued to play "next" after the current track ends. Once it (and any donation tracks that queued up behind it — see below) finishes, the track it interrupted resumes at the exact position it was cut off at, never restarted from 0." with "is **queued to play next**, exactly like `play`-by-name: it plays once the current track ends, never cutting it off (it used to interrupt and resume; that was removed — see `docs/superpowers/specs/2026-09-23-donation-library-track-request-design.md`, Phase B)."
- In the module list, `songRequestAction.ts` now "calls `LocalStreamManager.enqueueTrack`".
- Replace the whole "**The interrupt-and-resume mechanism (`StreamController`).**" paragraph and its bullet list with:

```markdown
**One queue (`StreamController.enqueueTrack`).** Every donation request and every `play`-by-name
goes through the one `PlaylistQueue.insertNext()` FIFO via `enqueueTrack(track)` — play after the
current track ends, in call order, never interrupting, and skippable like any other track. A
donation's temp-file track carries `ephemeral: true` plus `_onFinished`: `PlaylistQueue.next()`
never pushes an ephemeral track into `history` (its file is deleted the moment it finishes, so
`previous()` must never reach it), and `StreamController.next()`/`previous()` call
`releaseTrack()` on an ephemeral track they move off mid-play, so skipping one still deletes its
file. A stop or crash mid-donation leaves the file to the 12-hour sweep, as before.
`status().currentTrack` is `queue.current()` while a session exists
(`streaming`/`paused`/`reconnecting`) and `null` otherwise. The overlay's playlist window still
uses `positionInBase()` + `buildInsertedTrackWindowLines()` for any current track not found in the
playlist by name — which covers both donation tracks and `play`-by-name picks from outside the
running playlist.
```

- Update the Layout tree's `donations/` entry "insertEphemeralTrack" → "enqueueTrack".

- [ ] **Step 6: Commit**

```bash
git add src/playlist/queue.ts src/ffmpeg/overlayText.ts src/stream/streamScene.ts test/playlist/queue.test.ts test/ffmpeg/overlayText.test.ts CLAUDE.md
git commit -m "refactor: delete the donation FIFO and interrupt docs; rename the inserted-track window builder"
```

---

### Task 4: Real-stream check

**Files:** none (verification only; record the outcome in the final report, not a file).

- [ ] **Step 1:** Deploy to the stand (192.168.14.26, see memory: port 8088 mapping must be re-applied and verified after a redeploy). Start a local stream, then use the Donations page "Test" button on a `songRequest` rule.
- [ ] **Step 2:** Confirm by watching the preview and `GET /local-stream/status`: the current track keeps playing (no cut), `nextTrack` becomes `🎁 Заказ: …`, and after the current track ends the donation plays, then the playlist continues.
- [ ] **Step 3:** Trigger a second test request, let it start playing, press "next": confirm playback moves on and the temp file under `os.tmpdir()/super-dj-donation-songs` is gone (`docker exec … ls`). Press "previous" twice: confirm the donation track is not replayed.
