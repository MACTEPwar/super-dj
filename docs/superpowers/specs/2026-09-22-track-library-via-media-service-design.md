# Add-track-via-media-service — design spec

## Goal

Give the streamer a second way to add a track to their library (alongside the existing file
upload): type a text query, have the backend fetch matching audio from the streamer's own
external media-search microservice (already integrated for the donation song-request feature —
see `src/donations/mediaSearchClient.ts`), preview it in the browser, and only persist it as a
real library track once confirmed.

## Why preview-before-save

The media-search service exposes exactly one relevant endpoint, `GET /download/audio?query=`,
which returns raw mp3 bytes on success — no title, no candidate list, no metadata of any kind.
Without some form of confirmation step, a mismatched query would only be discovered after the
track had already been added to the library (and possibly played live). A preview step needs no
changes to the external service at all: it reuses the exact same download call, just holds the
result in temporary storage and lets the streamer listen before it's kept.

Two alternatives were considered and rejected:
- **Blind add** (fetch and save in one step, no listen-first) — simplest, but a bad query silently
  pollutes the library with the wrong track.
- **Real search with a candidate list** (Spotify/YouTube-style picker) — best UX, but requires the
  *external* media-search service (which the streamer runs and controls separately, outside this
  repo) to expose a new "list candidates" endpoint. Out of scope until that service supports it;
  revisit if/when it does.

## Entry points

Both create a track the same way; only what happens right after differs:

1. **Library page (`AddTrackDrawer.tsx`)** — a new "Через сервис" tab alongside the existing
   "Загрузить файл" tab. Creates a library track, available to add to any playlist afterward, same
   as an uploaded track.
2. **Playlist page** — the same search-preview-confirm flow, but on confirm the newly created track
   is immediately added to the playlist being edited too (one action instead of two), by chaining
   the existing "add existing track to playlist" call right after track creation.

## Backend

### New shared module: `src/media/mediaSearchClient.ts`

`HttpMediaSearchClient`, `MediaSearchClient`, `MediaSearchError` move here verbatim from
`src/donations/mediaSearchClient.ts` (mechanical relocation, no behavior change) — both the
donation feature and this one now depend on it, so it no longer belongs under `donations/`.
`src/donations/songRequestAction.ts` and `src/server.ts` update their imports accordingly.

### New module: `src/tracks/trackPreviewRegistry.ts`

An in-memory `previewId → { userId, tempFilePath, createdAt }` map, the same shape and lifecycle
discipline as `MediaMtxAuthRegistry` (`src/stream/mediaMtxAuth.ts`) — register on create, look up
and delete on confirm/discard, nothing persisted to the database. `previewId` is a random token
(`crypto.randomUUID()`), not guessable, not reused.

### New module: `src/tracks/trackPreviewService.ts`

Orchestrates search → temp file → registry entry, and registry entry → permanent track. Depends on
`MediaSearchClient` and `Pick<TrackUploadService, 'upload'>` (reused as-is — `TrackUploadService.
upload()` only needs an object shaped `{originalname, path, size}}`, which a preview's temp file
can be wrapped in without any change to that class).

- `search(userId, query): Promise<{ previewId: string }>` — calls `mediaSearchClient.fetchAudio
  (query)`, writes the bytes to `path.join(previewTempDir, `${previewId}.mp3`)`, registers
  `{userId, query, tempFilePath, createdAt: Date.now()}`, returns the id. Lets `MediaSearchError`
  propagate as-is (the route layer maps it to a 502/504 the frontend can show — see "Error
  handling" below; unlike the donation flow, a preview has a live human waiting for the answer, so
  failures must never be swallowed here). `query` is stored on the registry entry, not just used
  and discarded, specifically so `confirm()` below has a sensible name to fall back to.
- `getPreviewPath(userId, previewId): string` — looks up the registry entry, throws `ApiError(404,
  'preview not found or expired')` if missing, `ApiError(403, 'not your preview')` if the owner
  doesn't match. Used by both the streaming route and the confirm route.
- `confirm(userId, previewId, name, coverFile): Promise<TrackSummary>` — resolves the path via
  `getPreviewPath`, wraps it as an `UploadedFile` (`originalname: `${previewId}.mp3`, path, size`
  via `fs.stat`), calls `trackUploadService.upload(userId, trackName, audioFile, coverFile)` where
  `trackName` is `name` if it's a non-empty string, otherwise the registry entry's own `query` —
  **never `name` unchecked**. `TrackUploadService.upload()`'s own filename-based default (basename
  of `originalname`) would otherwise name the track after the synthetic `${previewId}.mp3` — a
  random UUID, not anything the streamer actually searched for or listened to — the exact failure
  mode a streamer clearing the name field before confirming would hit. Deletes the registry entry
  on success. The temp file itself does NOT need explicit deletion here — `TrackUploadService.
  upload()`'s `moveFile` already relocates (renames) it into permanent storage, so there is nothing
  left at the temp path afterward.
- `discard(userId, previewId): void` — looks up + ownership-checks, deletes the registry entry and
  unlinks the temp file (best-effort, swallow ENOENT).

### New temp directory + sweep

`path.join(os.tmpdir(), 'super-dj-track-previews')` — separate from the donation feature's temp
dir (`super-dj-donation-songs`), because the risk profile is different: an unconfirmed preview is
an abandoned draft, not a track a stream might still be about to play, so it can be reaped much
sooner. `server.ts` starts a second `startTempFileCleanupSweep(previewTempDir, 60 * 60 * 1000,
10 * 60 * 1000)` — 1 hour max age, same 10-minute sweep interval as the existing donation sweep.
This is the backstop for previews nobody ever confirmed or explicitly discarded (browser closed,
drawer abandoned, etc.) — the registry itself doesn't expire entries on a timer; the sweep deletes
orphaned files, and any registry entry pointing at a since-swept file simply gets `getPreviewPath`'s
"not found" treatment on next use, since the confirm/stream routes attempt to actually `stat`/read
the file, not just check registry presence.

### New routes (`src/tracks/trackRoutes.ts`, all `requireAuth`, mounted at `/tracks`)

- **`POST /tracks/search-preview`** — body `{query: string}` (400 if missing/empty/not a string).
  Calls `trackPreviewService.search`. Returns `{previewId}`. A `MediaSearchError` maps to `502`
  with the service's own `detail` message surfaced (`400`/`404`-shaped upstream errors — "not
  found" style — could arguably be a `404` instead of `502`; see open question below).
- **`GET /tracks/preview/{previewId}`** — resolves the path via `trackPreviewService.
  getPreviewPath`, streams it with `res.sendFile` (matching `GET /tracks/{id}/cover`'s existing
  pattern) plus an explicit `Cache-Control: no-store` header (unlike the cover route — a preview is
  temporary and must never be cached by the browser across a discard/re-search). 404/403 exactly
  like `getPreviewPath` throws.
- **`POST /tracks/from-preview/{previewId}`** — multipart (`cover` optional, matching the existing
  upload route's cover handling) plus `name` field. Calls `trackPreviewService.confirm`. Returns
  the same `TrackSummary` shape `POST /tracks` already returns.
- **`DELETE /tracks/preview/{previewId}`** — calls `trackPreviewService.discard`. `200 {}` on
  success; 404/403 the same way.

### Track naming

Defaults to the raw query text typed (mirrors the existing upload flow's "filename becomes the
name when omitted" default); the existing optional `name` field on confirm overrides it exactly
like it already does on `POST /tracks`.

## Frontend

- **`frontend/src/api/tracks.ts`**: add `searchPreview(query)`, `previewUrl(previewId)` (a plain
  URL string, like `coverUrl`), `confirmPreview(previewId, name, cover)`, `discardPreview
  (previewId)`.
- **`AddTrackDrawer.tsx`**: a two-tab layout (`Загрузить файл` / `Через сервис`) replacing the
  single upload form. The service tab: a text input + "Найти" button → on success, renders
  `<audio controls src={tracksApi.previewUrl(previewId)}>` plus a name field (defaulting to the
  query), an optional cover picker, and "Добавить" / "Другой запрос" buttons. "Другой запрос" calls
  `discardPreview` for the current id (best-effort, ignore failure) before clearing the preview
  state and re-showing the query input. Loading state covers the search call (can take several
  seconds — this is a synchronous foreground fetch, not backgrounded).
- **Playlist page's add-track flow**: reuses `AddTrackDrawer` (or a thin wrapper around it) with an
  `onAdded` callback that also calls the existing "add track to this playlist" mutation right after
  a successful confirm.
- i18n: new keys for both locales already covered by this repo's `en`/`ru`/`uk` convention (tab
  labels, "Найти"/"Добавить"/"Другой запрос", search-failed/preview-expired error strings).

## Error handling

- Search fails (`MediaSearchError`) → inline error in the drawer ("не найдено" / "сервис
  недоступен"), same tab stays open, query input keeps its value so the streamer can retry or edit.
- Confirm called on an expired/missing preview → clear "превью устарело, найдите заново" message,
  drawer resets to the query-input state.
- Every failure surfaces to the streamer directly — unlike the donation flow's `executeSongRequest`,
  there is a live human waiting on this call, so nothing here is swallowed-and-logged-only.

## Testing

Same fake-collaborator style as the rest of this backend: a fake `MediaSearchClient`, a real (not
faked) `TrackPreviewRegistry` instance where practical (it's pure in-memory logic, cheap to use for
real — same reasoning `PlaylistQueue` tests already lean on), and `Pick<TrackUploadService,
'upload'>` faked at the service-test level. Route tests use `supertest` against a router built with
fakes, matching every existing route test file in `test/`. Frontend: React Testing Library render
tests with `tracksApi` mocked, matching `AddTrackDrawer.test.tsx`'s existing pattern.

## Open questions / follow-ups deliberately deferred

- **Upstream error status mapping**: whether `MediaSearchError` should map to `502` uniformly or
  try to distinguish "not found" (`404`-ish) from "service down" (`502`/`504`) is left to the
  implementer's judgment during the plan — the service's own error body's `detail` text is the only
  signal available, and CLAUDE.md's own notes on `mediaSearchClient.ts` don't specify a fixed
  status-to-reason mapping. Default to `502` with the upstream detail message if no finer signal is
  available.
- **Real search-with-candidates UX** is out of scope until the external media-search service itself
  grows a "list candidates" endpoint — not part of this plan.
- **Preview TTL (1 hour)** is a starting guess, not a measured value — revisit if streamers report
  losing an in-progress preview to the sweep during normal use.

**Reviewed and explicitly accepted, not fixed** (raised during design review, deliberately left as
known limitations rather than engineered around — the 1-hour sweep is the backstop for all of
these):
- **No discard call fires when the drawer's service tab is abandoned** — switching to the "Upload"
  tab while a preview is pending unmounts the component holding its `previewId`, and closing the
  whole drawer (✕/Escape/overlay click) doesn't call `discard` either. The temp file and registry
  entry just sit until the sweep reaps them. Only the explicit "Другой запрос" button calls
  `discard`.
- **Switching away from the Upload tab mid-request, then having it resolve later, can still close
  the drawer out from under the streamer** (`onSuccess` fires regardless of which tab is now
  active) — a new edge case this feature introduces by giving the drawer a second tab to switch to
  in the first place. Not mitigated.
- **A double-click on "Добавить" can race `confirm()` against itself** — the second call's
  `moveFile` finds the temp file already gone (the first call already renamed it into permanent
  storage) and surfaces as a generic error rather than a clean "already added" response.
- **A track added from the playlist editor is created in the library immediately on confirm**, even
  if the playlist page's own "Save" is never pressed afterward — consistent with how uploading
  already behaves from the Library page, but a streamer navigating away without saving may not
  expect a new library track to already exist.
