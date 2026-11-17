# Ava calendar — review build 0.3.0-alpha.2

Build date: 16 November 2026. Review branch; not a live deployment.

## Scope completed

This extends the requested foundation with journal-panel setup/override controls,
a trusted encounter coordinator, one narrow registered model tool, and automatic
birth catch-up. It remains inactive by default and is not deployed to the VPS.
The existing journal schedule and second-entry policy are unchanged.

There are two installations from this repository: the existing UI extension and a
small server plugin. `manifest.json.js` is `index.js`; `package.json.main` is
`arc/server.mjs`. No npm dependencies or build step are required. Updating the UI
extension alone does not install or update the server copy; server code updates
require a deliberate matching update and container restart.

The server owns the clock and records; it never calls Venice or sends messages.
It evaluates due dates on access. The bound Ava client checks on tab return,
focus, a visible-tab 60-second timer, and immediately before model requests.
With the browser closed there is no notification/narration job: the next request
processes elapsed dates and obtains the same historical transition date.

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
  birth is forced without calling the decision callback. The sequence runner processes these events before returning current state;
  pure `derive()` remains free of writes and random calls.
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

`recordEncounter` and `recordDaily` remain internal functions invoked inside
`store.transaction`. The append-event route exposes only a validated completion
against a server-issued encounter, never a raw state update.

Joe presses **Begin new encounter** once in Ava's one-to-one chat. This revision-
checked operation assigns a server UUID and monotonic sequence, bound to that
chat and local date. This explicit control is required: neither the model nor
text similarity determines where one encounter ends and another starts. It is
available only during cycle days 10–16. A new click deliberately supersedes the
previous encounter; stale revision conflicts require refresh.

The single `ava_append_arc_event` tool accepts exactly three boolean facts. It
cannot supply an ID, start another encounter, alter overrides, or write a journal.
The client captures the open ID during tool registration, validates chat identity
again on execution, and the server checks ID/chat/date/phase. The tool is offered
only for a current, open Ava encounter in ordinary generation, never quiet,
impersonation, automatic initiation or private journal requests. Ava reports
completion; the server determines eligibility and outcome. A manual completion
form uses the same route for providers without verified tool support.

An ineligible completion creates no result. An eligible completion records once;
repeated calls reuse the receipt even after conception. Reopening ST cannot
mint another identity. The scene facts themselves are model-reported or manually
entered; this is not an independent semantic verifier of the conversation.

Keep receipts for fewer than 30 elapsed local dates and at most 50 receipts,
whichever removes them first. Preserve sequence high-water/issued scalars. Clear
expired active-encounter metadata at 30 days. Once a result is pruned, reject its
old sequence/token instead of rerolling. Superseded tokens also fail closed. This
is the bounded-storage tradeoff; infinite replay of deleted results is not claimed.

Daily birth receipts use [arc ID, kind, local date]. Receipt, cursor and transition
are saved atomically. The runner processes missed eligible dates in chronological
order, stops at first success and derives postpartum from that historical date.
The date batch is capped at 60; forced birth on day 287 bounds the actual pregnancy
window to 15 dates. A complete required catch-up precedes model dispatch.

A clock override resets the cursor's clock identity, while existing daily receipts
still prevent same-date rerolls. A manual jump applies from its anchor date; it
does not invent births earlier than that date. If a same-day failed roll is then
manually advanced to day 287+, preserve the failed roll and separately record the
forced birth transition without another random call. Journal backfill is separate.

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

## Controls and activation

**Journal → Ava’s calendar** contains Check server / refresh; explicit Ava
confirmation; initial arc/date/timezone; reconnect; current state; anchored day,
stage and belly overrides; Clear overrides; encounter controls; and JSON record
download. Start date means cycle day 1, conception day 0, or birth day 0.

No settings, server files, installations, restarts, model calls or Telegram
messages were performed on Joe's VPS. Main remains unchanged. Do not install the
review branch directly into a live deployment before isolated acceptance testing.

The first installation needs a server-plugin copy in the persistent plugins mount,
`enableServerPlugins: true`, and one clean container restart. Pin both client and
server to the reviewed commit. Check `enableServerPluginsAutoUpdate` explicitly:
ST 1.19 defaults it to true, so disable automatic server-plugin updates for the
pinned deployment. Do not pull the `latest` container image, recreate/delete
volumes, or run `docker compose down -v` as part of this work.

Follow the isolated procedure in [VALIDATION.md](VALIDATION.md). A fresh backup and
restore check must precede deployment. The real avatar ID and starting date are
chosen by Joe in the controls, never inferred from a display name. A saved server
record can be reconnected after a failed client settings save; setup cannot
replace an existing record. No reset/delete/import route is exposed.

Remaining work: live browser/mobile layout acceptance, authenticated ST 1.19
integration, and Venice tool-call acceptance. Then the reviewed install/update,
restart and explicit configuration. Future background initiation must use this
same server state service before its own requests; that worker is separate. A
second daily journal entry remains a separate job.

## Verification

Run `ST_SOURCE=/path/to/pinned/ST-1.19.0 npm test` with commit
`7e8663cd9c184a550b37238218bdd32c6efc68e9`. Tests cover actual file transactions,
restart/replay, two store instances, failed rename, revision conflicts, account
isolation, local dates, overrides, postpartum day 93, pruning, request injection,
private journals, chronological birth catch-up, forced day 287, encounter tools,
setup/reconnect, manual controls and tab-return behavior. Existing journal tests
and Danny's byte-exact fixtures pass.

The controls tests execute real callbacks/routes with a minimal DOM adapter;
they are behavioral tests, not rendered-layout validation. Chromium was attempted
again but socket creation was denied (`Operation not permitted`) before any page
ran. No live ST/Venice integration success is claimed.
