# Donation-triggered song request — design

Status: approved for implementation planning (2026-09-21). MVP scope only — the first of a
larger "donation interactivity" idea space explored separately (see the published catalog
artifact referenced in project memory `project_donation_interactivity_catalog.md`).

## What this is

A viewer donates on Donatello.to with a message like `!song:Imagine Dragons - Believer`. If the
donation clears a configurable threshold, the streamer's own local media-search service is asked
for that track's audio, and it plays **next** in the live queue — once — then is discarded. The
regular playlist is untouched and resumes exactly where it left off.

This is deliberately narrow: one trigger source, one action type. The data model is kept general
enough that a second action type doesn't require a redesign, but nothing beyond "donation song
request" is built now.

## Explicitly rejected during design

- Pulling audio from YouTube/YouTube Music, directly or via a wrapper service, to rebroadcast
  publicly — declined on copyright/ToS grounds regardless of how many hops the scraping is moved
  behind. Superseded once the user confirmed their media-search service now searches only their
  own AI-generated ("in the style of") tracks, not third-party content.
- YouTube Super Chat / Twitch Cheer / Twitch Channel Points / any platform-native paid-message
  event as an additional trigger source — user chose external-donation-only (Donatello.to) for
  MVP simplicity. May be revisited later as separate, independent trigger sources.
- A generic multi-condition (AND/OR) rule engine — not needed while there is exactly one trigger
  shape (donation amount + donation message text) and one action type.

## Trigger

**Source:** Donatello.to "Колбеки" (callback) webhook only. No Super Chat, no Twitch EventSub, no
live-chat reading of any kind.

**Condition:** `actualAmount` (after currency conversion to UAH) ≥ the rule's `minAmount` (always
UAH) **AND** the donation's `message` field contains `!{commandKeyword}:{query}` anywhere in the
text (not required at position 0 — a donor may write a greeting first). The keyword match is
case-insensitive; `query` is everything after the `:` to the end of the message, trimmed.

**Currency conversion:** MVP ships a `CurrencyConverter` as its own pluggable module, not inlined
into the rule-matching code, specifically so it can be swapped for a real live-rate lookup later
without touching the matching logic. The MVP implementation is a **hardcoded approximate-rate
stub supporting USD and EUR → UAH** — deliberately not a no-op, because a no-op would mean a $10
donation could never cross a "≥400 UAH" threshold, defeating the point. Any other donation
currency falls through as non-matching (safe default) until real conversion is built.

**`isSubscription: true` donations** are treated identically to one-off donations — no special
casing.

**No cooldown / no rate limit** on how often the trigger can fire — accepted for MVP because the
action side now has a real ordered queue (see below), so rapid donations queue up rather than
racing or overwriting each other.

**No query-length limiting on our side** — Donatello's own message-length limits are considered
sufficient.

**Deduplication — open, blocking item.** The sample "Колбеки" callback body has no visible unique
per-donation id (`pubId`, `clientName`, `message`, `amount`, `currency`, `actualAmount`,
`actualCurrency`, `source`, `goal`, `interactionMedia`, `interactionMediaStartTime`, `show`,
`isPaidFee`, `isSubscription`, `createdAt` — nothing that looks like a transaction id). A retry of
the same webhook by Donatello could double-trigger a song. **Deduplication must be keyed on a
genuine per-event id, never on content equality** — the same donor legitimately re-ordering the
same song is a normal case, not a duplicate to suppress. Donatello's separate "Вебхуки" tab
(distinct from "Колбеки", not yet inspected) may expose a real event id — needs checking before
this can be closed out. Until resolved, MVP ships without dedup and accepts the small risk of a
double-play on a webhook retry.

## Data model

```
InteractionRule {
  id            String   @id @default(uuid())
  userId        String
  actionType    String   // "songRequest" is the only value that exists today, but the field
                          // is real (not inlined into a boolean) precisely so a second action
                          // type is additive, not a migration that reshapes existing rows.
  enabled       Boolean  @default(false)
  minAmount     Decimal  // always UAH for MVP — see CurrencyConverter above
  commandKeyword String  @default("song")  // stored bare, without the leading "!"
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
}
```

No `@@unique` on `[userId, actionType]` — the UI (below) is a genuine list, and a streamer may
want more than one `songRequest` rule (e.g. a cheap `!song` keyword and a separate, higher-tier
keyword with different behaviour later). Full CRUD, not a singleton settings row.

**Target user resolution for the webhook (MVP stopgap):** a fixed environment variable holding the
one account's `userId`, since exactly one person uses this today. **Tracked follow-up:** replace
with a real per-user webhook path/token the moment there is a second user — this is cheap to do
now and expensive to retrofit, but the user explicitly chose to defer it.

## Webhook ingestion

`POST /webhooks/donatello` — no session cookie (this is a server-to-server call from Donatello,
not a browser).

- **Auth:** compare the `X-Key` header against `config.donatelloCallbackKey` (already added to
  `src/config/env.ts` and `docker-compose.yml` — required, never defaulted, same pattern as
  `MEDIAMTX_AUTH_SECRET`) using a timing-safe comparison. Missing/wrong key → `401`.
- **Response codes:** any structurally valid, authenticated request answers `200` — including
  when no rule matched, or the action failed downstream — specifically so our own internal
  decisions never trigger Donatello's retry logic. Only a malformed body or bad auth is a non-200.
- **Processing model:** acknowledge fast, do the real work (currency conversion, rule matching,
  fetching audio, queue insertion) asynchronously after responding.

Confirmed by testing the real Donatello dashboard's own example payload
(`pubId`, `clientName`, `message`, `amount`, `currency`, `actualAmount`, `actualCurrency`,
`source`, `goal`, `interactionMedia`, `interactionMediaStartTime`, `show`, `isPaidFee`,
`isSubscription`, `createdAt`) — the threshold check uses `actualAmount`/`actualCurrency` (the
"honestly received" amount), per the user's explicit call.

## Rule matching engine

- Parses the command out of `message` per the trigger section above.
- Converts `actualAmount`/`actualCurrency` to UAH via `CurrencyConverter`.
- Compares against every enabled `InteractionRule` row whose `commandKeyword` matches the parsed
  keyword; on match, dispatches to the action executor for that rule's `actionType`.

## Action executor: `songRequest`

1. Calls the streamer's own media-search service: `GET http://<host>:8010/download/audio?query=<query>`.
   **Verified against the real running service** (not assumed from its OpenAPI schema, which
   leaves the success response schema empty): `200 OK`, `content-type: audio/mpeg`,
   `content-disposition: attachment; filename="<timestamp>.mp3"`, raw MP3 bytes (magic-byte
   checked: starts `49 44 33` = `ID3`) — roughly 7 s and ~2 MB for a real query, a dramatic
   improvement over the original video+audio endpoint's ~90 s / ~113 MB. Error responses
   (`400` empty query, `502` not found / prep failure, `504` timeout) carry `{"detail": "..."}"`
   unchanged from the video endpoint.
2. Saves the response body to a **dedicated temporary directory** (not `{UPLOADS_DIR}`, which is
   for the permanent track library) under a unique filename per request, so concurrent requests
   never collide.
3. Builds an ephemeral, **DB-less** `Track` (the lightweight `{name, audioPath, coverPath,
   overlayOverride?}` shape from `src/playlist/types.ts` — confirmed by reading the actual
   interface — not a Prisma row). This is exactly the shape `StreamController.playByName()`
   already constructs from the real library, just sourced from a temp file instead of an uploaded
   one. Its `name` is set to something like `"🎁 Заказ: <query>"` so it reads as a donation
   request wherever a track name is already shown (status API, overlay title) — no new rendering
   code needed for that distinction.
4. **Inserts into an ordered queue, not a single slot.** `PlaylistQueue` (`src/playlist/queue.ts`)
   currently holds `insertedNext: Track | null` — a single slot that a second `insertNext()` call
   silently overwrites, dropping the first request with no trace. Confirmed by reading the code.
   The user explicitly rejected "last write wins": two donation requests arriving before the first
   plays must both play, in order, between the current track and the regular next track. This
   requires changing `insertedNext` to an ordered list (`insertedQueue: Track[]`), with `next()`
   and `peekNext()` draining it FIFO before falling back to `baseTracks`. The only existing caller
   of `insertNext()` (`StreamController.playByName()`) is unaffected in behaviour — it now pushes
   onto the same list instead of overwriting a slot, which is strictly more correct for it too.
5. **Cleanup.** No public "track ended" event exists on `StreamController` today — the relevant
   `close` handler lives inside the private `feedCurrentTrack()`. Rather than adding a new
   generic event/pub-sub surface, attach a cleanup callback directly to the ephemeral track object
   at construction time (e.g. a non-serialized `track._onFinished` hook) and have the existing
   `close` handler invoke it if present. **Belt and suspenders:** also run a periodic sweep of the
   temp directory (age-based deletion) as a fallback for crash/error paths that skip the direct
   hook.
6. **Errors from the media service** (400/502/504, timeout) — no-op: log and drop. No donor-facing
   feedback in MVP (explicitly accepted).

## UI

**A new, dedicated page** (not a section/drawer on the existing Stream page) — chosen once the
scope was corrected from "one settings form" to "a real rules table," by analogy with how the
Templates CRUD earned its own page once it stopped being trivial.

- **Rules table:** trigger summary (e.g. "Донат ≥400 грн + команда `!song`"), action name, an
  inline enabled/disabled toggle, edit and delete per row.
- **"+ Добавить правило"** opens a create form: an action-type picker (MVP offers exactly one
  option, "Заказ песни за донат," but the control exists so a second action type is additive to
  the UI, not a redesign), then the trigger fields (`minAmount`, `commandKeyword`).
- **Edit** reopens the same form pre-filled; **delete** asks for confirmation first.
- A donor-facing instruction string is shown per rule and updates live as the keyword is typed
  (e.g. `Зрители смогут заказать песню, написав в сообщении к донату: !{keyword}:Исполнитель -
  Название`), meant to be copy-pasted onto the streamer's own donation page.

**API:** `GET /interaction-rules`, `POST /interaction-rules`, `PUT /interaction-rules/{id}`,
`DELETE /interaction-rules/{id}` — full CRUD, matching the data model's list shape (not a
singleton settings endpoint).

## Known follow-ups (explicitly tracked, not MVP-blocking)

1. **Currency conversion is a hardcoded USD/EUR→UAH stub**, not live rates — replace with a real
   conversion source. The user asked for this to be remembered explicitly.
2. **The webhook's target-user resolution is a fixed env var**, correct only for exactly one
   account — replace with per-user webhook routing/tokens the moment a second user exists. The
   user asked for this to be remembered explicitly.
3. **Donation deduplication is unresolved** pending a look at Donatello's "Вебхуки" tab for a real
   per-event id; must never be content-based (see Trigger section).

## Explored but out of scope for this feature (see the separate ideas catalog)

The broader "donation interactivity" idea space (AI DJ persona, viewer memory/status, visual
effects, voting/battle mechanics, crowdfunding-style goals, VTuber-style fan mechanics, etc.) was
brainstormed separately across 6 research threads plus a synthesis pass and published as an
artifact — see project memory `project_donation_interactivity_catalog.md`. None of it is part of
this feature; it's the backlog this MVP is the first slice of.
