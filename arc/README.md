# Ava calendar foundation — 0.3.0-alpha.1

Build date: 15 November 2026. Review branch; not a live deployment.

## Scope completed

This adds the first requested layer to the existing journal repository: an opt-in,
Ava-only record, civil-date derivation, anchored manual overrides, request-boundary
injection and transactional event receipt primitives. It does not activate an
automatic birth scheduler, register a model event tool, change the journal's
daily schedule, or add a second daily entry. The accepted probability array is
stored as a constant for the next layer; no unattended random calls occur.

The journal UI extension remains the client host. A separate lightweight server
entry point in this same repository owns calendar storage. It does not generate
text, install packages or run a timer. `package.json.main` points to
`arc/server.mjs` for the SillyTavern server-plugin loader; `manifest.json.js`
continues to point to the existing browser entry point.

## Authority and persistence

- One record per authenticated SillyTavern user, explicitly bound to Ava's exact
  avatar ID. Display names do not implicitly enable anything.
- Empty by default. Ríona, Eve, Marnie, all unbound characters and group chats have
  no calendar lookup, state block or calendar writes.
- Server file: `<authenticated-user-root>/ava-calendar/state.json`. This sits in
  the existing persistent data volume, outside public file attachments. Include
  it in the independent full backup and restore test.
- A schema-versioned envelope stores a revision and record. Stored fields include
  avatar, timezone, arc identity/type, stable start anchor, conception/birth dates,
  manual override anchors, encounter receipts/high-water mark and daily receipts.
  Day/stage/belly/symptoms are derived, never stored daily counters.
- Read–decide–receipt–transition–save is one synchronous transaction in the single
  ST Node process. Two phones use the same authoritative file. Write to an
  exclusive temporary file, fsync, rename, fsync the directory. Failed writes
  never report a successful commit; malformed records fail closed.
- This is for the inspected single-container, single-process ST deployment.
  Multiple ST worker processes sharing the file are unsupported; use a database
  transaction backend before scaling that way. Atomic rename alone is not a
  distributed lock.
- Manual edits require the expected revision. Stale screens receive 409 rather
  than overwriting newer state. A repeated birth override cannot fire twice with
  the old revision. No model tool exposes override or reset operations.

## Agreed fictional arc rules

These are the supplied character/story rules, not medical guidance.

- Time is elapsed local civil dates in the record's IANA timezone, default
  Europe/London. DST and leap days are handled as dates, not 24-hour timers.
- Cycle is one-based, 28 days; bleed 1–5; fertile 10–16 inclusive; peak 13–15.
  Stable stored anchor; derive current cycle start and day with no writes on wrap.
- Eligibility requires arc type cycle, fertile day and all three encounter facts:
  unprotected, penetrative and internally completed. Ineligible encounters do not
  roll or create a result. Eligible probability: 18%, or 25% at peak.
- Conception stores that encounter's local date as conception/start date and
  transitions to a new pregnancy arc identity. Pregnancy day 0 is conception.
- Pregnancy stages: implantation 0–13; trimester-one 14–41;
  trimester-two-opening 42–97; trimester-two-late 98–181;
  trimester-three 182–265; term 266 onward, including after day 280.
- Belly: flat 0–41; bloat 42–55; soft swell 56–83; visible 84–139;
  definite 140–181; heavy 182–265; engaged 266 onward;
  postpartum-soft after birth. An explicit belly override wins for its arc.
- Daily symptom seed is a deterministic hash of avatar ID and local date. One cue
  is selected deterministically from the supplied stage pool; no per-message
  randomness, no invented severity. Implantation cues begin at day 8. The first
  trimester pool carries through the opening second trimester with an explicit
  `symptomsEasing` flag from day 70. Late second trimester, third trimester and
  term pools use the supplied words; Braxton Hicks enters the pool at day 210.
- Birth-day probabilities, day 273 through 287: 5, 7, 10, 13, 17, 22, 28, 35,
  43, 52, 62, 72, 82, 92, 100 percent. When processing a day-287-or-later event,
  birth is forced without calling the decision callback. The automatic sequence
  runner is deferred, so simply deriving state does not run these events yet.
- Mathematical correction: interpreted as conditional daily hazards, this exact
  curve has median day 278. Survival to day 287 is 0.0000878632, or about
  0.00878632%. The supplied percentages are retained unchanged.
- Birth event atomically stores birth date and starts postpartum day 0. Model
  narration does not determine the transition.
- Postpartum stages: heavy 0–13, recovering 14–41, settling 42–83. Pool: lochia,
  afterpains, feeding, exhaustion. No conception during postpartum. Day 84 starts
  cycle day 1; first possible conception is cycle day 10 / postpartum day 93.
  If absent, the cycle hand-off uses the actual day-84 date on next access.
- Joe's day/stage override stores value plus local anchor date and stage start
  day. Clock continues from the override. Conception date remains unchanged.
  Birth stage override immediately commits birth and postpartum day 0.
- Only manual routes set/clear overrides. Events never rewrite or clear them.
  Overrides are tied to an arc identity: after a transition, the old override is
  retained but cannot resurrect a completed phase. Clearing an override removes
  its timing/belly adjustment; it does not undo an already recorded birth.

## Duplicate protection and pruning

`recordEncounter` and `recordDaily` are trusted coordinator functions, not model
tools or HTTP routes. Invoke them inside `store.transaction`.

An encounter must have a canonical ID and monotonic sequence assigned once by the
future trusted encounter coordinator. Regenerations/retries must reuse both. The
model must never assign or replace either. Present receipts are returned without
rolling, even after a phase transition. A mismatched ID/sequence/date is rejected.

Keep encounters for fewer than 30 elapsed local dates and at most 50 receipts,
whichever limit removes them first. Preserve the scalar sequence high-water mark.
Once pruned, the old result is unavailable: reject its old sequence instead of
rerolling it. Delayed/out-of-order events below that mark also fail closed. This
is the deliberate bounded-storage tradeoff; do not promise infinite replay of a
result after deleting it. New encounters must be recorded on their local date.
Future tool work must authenticate encounter provenance and preserve stable
identity; the primitive alone cannot identify two descriptions of the same scene.

Daily birth receipts use [arc ID, kind, local date]. Receipt and transition are
saved atomically. The catch-up utility returns at most 60 chronological dates and
a next-date cursor; it never jumps forward past the cap. The next layer must
process missed eligible dates in order, stop at first success, persist its cursor,
and derive postpartum from that historical success date. It must finish required
catch-up before sending state to a model. Journal backfill is separate.

## Request-time integration

The browser adapter wraps only POST `/api/backends/chat-completions/generate`.
This is ST 1.19's actual Chat Completion HTTP boundary after prompt assembly and
settings-ready events. It is not a render hook or a retrieval operation. ST's
event emitter catches callback errors, so an event-only hook could silently send
a request with stale state; the HTTP wrapper can stop the request on failure.

With an explicit client binding, every Ava request reads authoritative state
immediately before dispatch, strips any previous tagged state block and appends
exactly one system block. There is no quiet/automatic/manual type exemption.
Group/other-character requests strip tagged blocks and perform no state lookup.
Custom-body overrides/exclusions that replace the message array are rejected.
An unavailable/malformed calendar or changed chat stops generation with an error.

Private journal requests explicitly supply their recorded character/chat owner,
so Ava can receive her state even while Eve's chat is selected. A yesterday entry
retains its journal date while the calendar block shows the actual current date,
as specified. Each retry refreshes state at its own request boundary. Character
instructions, journal instruction strings, conversation and memory tools remain
untouched. The existing journal's own cross-tab lock is still browser-local; this
calendar work does not claim to solve multi-device journal duplication.

Future background initiation must call this same authoritative derivation/receipt
service before its own server model request. That separate worker does not exist
yet. Requests sent by extensions that capture a private fetch before this wrapper,
or use a different transport/endpoint, require their own adapter and acceptance
test; no blanket support for uninspected transports is claimed.

## Activation and next layer

No live settings, server files, installations, restarts, model calls or Telegram
messages were performed. Development is on a review branch, not the Update path.

This foundation intentionally has no user-facing calendar setup panel yet. After
review and a backup/isolated deployment, a setup panel can call authenticated
`/api/plugins/ava-calendar/configure` with explicit Ava binding, timezone and start
date; then save the client binding `extension_settings['ava-calendar']={avatar}`.
Do not enable a client binding before the server is installed and configured.
The server exposes state/inspect and revision-checked manual override routes;
it exposes no general arbitrary-write route and no model event route.

Next: setup/override controls, trusted encounter identity/eligibility tool, the
birth curve runner with ordered 60-date catch-up, then isolated end-to-end tests
and activation. Extra daily journal entries remain a separate later task.

## Verification

Run `ST_SOURCE=/path/to/pinned/ST-1.19.0 npm test` with commit
`7e8663cd9c184a550b37238218bdd32c6efc68e9`. Tests cover the actual file transaction,
restart/replay, two independent store instances, rollback on failed rename,
revision conflicts, route authorization, local-date boundaries, overrides,
postpartum day 93, pruning, adapter isolation/failures, and the actual private
journal request path. Existing journal tests and Danny's byte-exact fixtures pass.

Chromium browser harness was attempted but this environment rejected Chromium's
socket creation (`Operation not permitted`) before any page could run. Simulated
browser/HTTP adapter tests are not a successful live ST/Venice validation.
