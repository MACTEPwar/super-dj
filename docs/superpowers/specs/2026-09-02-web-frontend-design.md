# Web Frontend — Design

**Phase:** 5 of the super-dj roadmap (see project memory `project-super-dj-roadmap`), the final
phase. Turns super-dj from an API-only backend into a product the user actually operates —
login/register, track/playlist management, connecting streaming destinations (OAuth account
linking through the UI, not YouTube Studio), starting/controlling streams, and watching live
status — all through their own web app instead of curling the API or touching a platform's own
dashboard.

**Non-goals (deferred, YAGNI):** native mobile/desktop apps (the frontend is architected so a
later React Native port and an Electron/Tauri desktop wrap are both realistic, but neither is
built now); multi-provider UI polish beyond YouTube + the generic manual-RTMP path (no second
OAuth provider exists yet — see phase 4's design spec); end-to-end (Playwright) tests; a design
system beyond Tailwind + shadcn/ui defaults; real-time collaboration or multi-device sync beyond
what a shared session cookie already gives for free.

---

## 1. Stack and project structure

**Stack:** React 18 + TypeScript + Vite (SPA, no SSR — this is an authenticated control panel,
not a public/SEO surface). React Router for client-side routing. Tailwind CSS + shadcn/ui for
styling/components. TanStack Query (React Query) for all server state (fetching, caching,
mutations, and — critically — the live stream-status subscription, see §6).

React (not Angular/Vue) was chosen specifically because the user wants a realistic path to a
future mobile app: React Native is the dominant "one codebase, two native platforms" solution,
with a much larger ecosystem than Angular's NativeScript equivalent. A desktop wrap (Tauri/
Electron) works equally well from any web stack, so it didn't factor into the choice.

**Directory structure** (new top-level `frontend/` alongside the existing `src/`):

```
frontend/
  src/
    api/           typed client per backend resource — auth.ts, tracks.ts, playlists.ts,
                   destinations.ts, stream.ts, client.ts (shared fetch wrapper + ApiError)
                   Deliberately framework-agnostic: no React imports here. This is the layer
                   that ports almost unchanged to a future React Native app.
    pages/         one file per route — Login.tsx, Register.tsx, Library.tsx, Playlists.tsx,
                   PlaylistEditor.tsx, Destinations.tsx, DestinationPanel.tsx
    components/    reusable UI pieces — Sidebar, TrackList, PlaylistTrackEditor (drag-and-drop),
                   StreamStatusBar, PlayerControls, AddDestinationModal, forms
    hooks/         useAuth, useStreamStatus (wraps the SSE subscription + React Query cache),
                   etc.
    App.tsx        router + top-level layout (sidebar shell)
    main.tsx       entrypoint
  index.html
  vite.config.ts
  tailwind.config.ts
  package.json     separate from the backend's package.json — different dependency graph,
                   built and deployed independently (see §7)
```

## 2. Navigation shell

A persistent left sidebar (confirmed over a top-tab-bar and a dashboard-first layout during
design review) with three sections: **Library** (tracks), **Playlists**, **Destinations**.
Clicking a destination in the Destinations section opens its stream-control panel — the sidebar
itself doesn't need a fourth top-level "Stream" entry, since a stream is always a property of a
specific destination, not a standalone resource. This structure also scales cleanly to a future
multi-stream dashboard: the sidebar's Destinations list is already the place a "which one is
live right now" indicator would live.

Unauthenticated users are redirected to `/login`; `GET /auth/me` on app boot determines the
signed-in user before any protected route renders.

## 3. Screens

**Login / Register** — standard email+password forms, no design-review pass needed (not a novel
UI question). Posts to `/auth/{login,register}`, redirects to `/library` (or wherever the user
was headed) on success, inline error on failure.

**Library** — upload form (drag-and-drop or file picker for the audio file + optional cover
image + optional name override, matching `POST /tracks`'s multipart body) above a list of the
user's tracks (name, duration, cover thumbnail if present, delete button). No playback preview in
the browser for MVP — tracks are managed as data, not auditioned in the frontend.

**Playlists** — list of the user's playlists (name, track count) with create/delete. Selecting
one opens the **Playlist Editor**: an ordered list of its tracks, reorderable via drag-and-drop
(confirmed over up/down buttons — better fits a "build a set" mental model, buttons are a
fallback worth keeping in mind if the future mobile port makes drag-and-drop awkward on touch),
with an "add tracks" picker (multi-select from the user's full library) and per-track remove.
Saves via `PUT /playlists/:id/tracks` (replaces the full ordered id list, matching the existing
API).

**Destinations** — list of the user's destinations (name, provider badge, delete). A single
**"+ Add Destination"** button (confirmed over two side-by-side buttons and a provider-card grid)
opens a modal with two tabs: **YouTube** (a single "Connect with Google" button that calls
`GET /destinations/youtube/oauth/start`, opens the returned `authUrl` in a new tab/window, and
polls or listens for the destinations list to gain a new `provider: 'youtube'` entry — see §8 for
the exact mechanics, since the OAuth callback currently returns a bare HTML confirmation page,
not a redirect back into the SPA) and **Manual** (a form for `name`/`rtmpUrl`/`streamKey`,
posting to `POST /destinations`).

**Destination stream panel** — the most novel screen, reached by clicking a destination. Two
tiers (confirmed over a full phase-stepper and a minimal header badge):
- A **broadcast-status bar** at the top, shown only for OAuth-backed destinations (i.e. when
  `GET .../stream/status`'s response includes a `provider` object): a colored state line ("🟡
  Connecting to YouTube…" / "🔴 Live" / "⚫ Error" / etc., derived from `provider.phase`), with a
  "Watch on YouTube" link once `provider.watchUrl` is present. Absent entirely for `provider:
  'custom'` destinations — there's no separate broadcast phase to show, only playback state.
- A **player card** below, always shown once a stream session exists: current/next track name,
  elapsed indicator, and controls (start playlist picker when idle; pause/resume, next, previous,
  stop, and a "play by name" input once streaming/paused).

## 4. Data flow and live status (SSE)

Every read/write goes through the `frontend/src/api/*` client modules, consumed via TanStack
Query (`useQuery`/`useMutation`) in pages/components — no direct `fetch` calls outside `api/`.

**Live stream status is pushed, not polled.** During design review the option of polling
`GET .../stream/status` on a fixed interval (e.g. every 2s) was raised and explicitly rejected in
favor of Server-Sent Events, because the backend already changes a destination's status only at a
small number of well-defined, already-imperative call sites (`pause`/`resume`/`next`/`previous`,
the ffmpeg auto-advance exit handler, and `YoutubeProvider`'s phase transitions inside its poll
loop and `finalize()`) — there's no continuously-changing value that genuinely needs sampling,
just discrete events that are cheap to emit.

This requires a **small, additive backend change**, in scope for this phase alongside the
frontend itself:
- `StreamManager` gains an event-emission mechanism (exact shape — a Node `EventEmitter` `
  StreamManager extends EventEmitter` vs. an injected callback — is left to the implementation
  plan) that fires a `statusChanged` event (keyed by `destinationId`) at each of the call sites
  above.
- A new route, `GET /destinations/:destinationId/stream/events`, opens a `text/event-stream`
  response scoped to that one destination: sends the current `status()` immediately on connect,
  then a new `data: <json>\n\n` frame every time that destination's `statusChanged` fires. Reuses
  the existing `requireOwnedDestination` ownership check from `streamRoutes.ts`.
- The frontend's `useStreamStatus(destinationId)` hook opens an `EventSource` against that
  endpoint and calls `queryClient.setQueryData(...)` on each message — TanStack Query officially
  supports externally-pushed cache updates this way, so the rest of the UI (the status bar,
  player card) just reads the query result as normal and re-renders on push, no manual state
  threading.
- `EventSource` reconnects automatically on a dropped connection (browser-native behavior); no
  custom reconnect logic needed on the frontend.

Every other read (tracks, playlists, destinations lists) is plain request/response through
TanStack Query with default caching — no push needed, these don't change from outside the user's
own actions.

## 5. Auth and cross-origin cookies

The frontend deploys as its own container/hosting (confirmed over having Express serve the built
static files), separate from the backend's origin. This means:
- The backend's CORS configuration must allow the frontend's specific origin with
  `credentials: true` (not a wildcard — wildcard origins can't be combined with credentialed
  requests).
- The session cookie (`src/auth/sessionCookie.ts`) must be set with `SameSite=None; Secure` for
  cross-origin requests to carry it at all in modern browsers — which in turn requires HTTPS on
  *both* the backend and frontend in any real deployment (a purely local dev setup can keep
  `SameSite=Lax`/no `Secure` by running both on `localhost` with different ports, browsers treat
  same-site-different-port as same-site).
- Every frontend API call sets `credentials: 'include'`.

This is a real, if small, backend change (currently no CORS middleware exists at all, and the
cookie has no `SameSite`/`Secure` attributes set) — in scope for this phase, alongside SSE.

## 6. Error handling

`frontend/src/api/client.ts` parses `{error: string}` from any non-2xx response and throws a
typed `ApiError` (mirroring the backend's own `ApiError` shape). Errors from a request tied to a
visible form (create playlist, add destination, upload a track) render inline near that form —
not a global toast, so the user sees the error where they'll act on it. Errors from a stream-panel
action (start/stop/pause/etc., which have no adjacent form) surface as a corner toast, since
there's no natural inline location for them.

## 7. Deployment

The frontend is a separate Vite build (`frontend/`, own `package.json`) producing static assets,
served by its own container (nginx or similar) independent of the backend's Docker image —
confirmed over having the existing Express server host the built files. `docker-compose.yml`
gains a third service; the frontend container needs to know the backend's base URL at build or
runtime (exact mechanism — Vite build-time env var vs. a runtime-injected config — left to the
plan).

## 8. Testing strategy

Vitest + React Testing Library for component tests, focused on the screens with real branching
logic (the stream status bar's phase→display mapping, the playlist drag-and-drop reorder, the
add-destination modal's two tabs) — not chasing full coverage, matching this project's existing
testing philosophy. `frontend/src/api/*` modules are tested with a mocked `fetch`, the same
pattern the backend itself uses for its own external calls (ffmpeg, Google's API). No Playwright/
e2e for this phase.

The two backend additions this phase requires (§4's SSE endpoint, §5's CORS/cookie changes) are
tested the existing backend way, in `test/`: `StreamManager`'s new event emission is unit-tested
with a plain listener assertion (no real HTTP), and the SSE route is tested with supertest the
same way every other route in this codebase already is, faking `StreamManager` rather than
opening a real long-lived connection in the test.

## Open questions for the implementation plan

- Exact `StreamManager` event-emission mechanism (`EventEmitter` subclass vs. injected callback).
- Exact SSE reconnect/cleanup semantics on the backend (removing a listener when the client
  disconnects, `req.on('close', ...)`).
- Exact mechanism for the frontend to detect that a YouTube OAuth connect (opened in a new tab,
  which returns a static confirmation page, not a redirect back into the SPA) has finished — a
  short-interval poll of `GET /destinations` while the modal is open, `postMessage` from the
  callback page, or something else.
- Vite build-time vs. runtime backend-URL configuration for the separately-deployed frontend
  container.
- Exact CORS origin configuration shape (single configured origin vs. an allow-list) in
  `src/config/env.ts`.
