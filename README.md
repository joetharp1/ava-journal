# Character Journals 0.2.0

Built for SillyTavern 1.19.0 Chat Completion mode. Separate client extension; no server plugin, dependencies or build step. Installable from GitHub. Automatic writing defaults off. The live storage check runs inside ST through its existing authenticated session before writing is allowed. Joe confirmed he has done `her_world`; no live card inspection or changes were performed.

## Multi-character update (0.2.0)

Open each character's one-to-one chat, then enable **Journal → Enable journal for this character**. The panel follows the open character automatically. Rebinding is removed. Ava, Eve and Marnie can all remain enabled with independent timezone, scene hold, Telegram choice and editable journal instructions. New characters start disabled.

The existing 0.1.x bound profile migrates automatically, preserving its enabled state, timezone, hold, notification choice and the exact original Danny journal/read-back strings. Saved entries, activity snapshots, pending saves and Data Bank registrations are retained. Other profiles use a neutral diary instruction referring to their own card voice and recorded conversation, without Ava's world or style restrictions. Card fields and World Info are never edited.

Daily completion and backfill are checked separately per character. Due entries run serially under the existing locks, using only that character's saved prompt, previous journal and matching connection. An unavailable context/model waits without blocking other eligible characters. Chat activity or switching during generation discards the pending generation. This is still a browser scheduler: keep ST open; a suspended or closed app delays writing until a later opportunity.

Read-back, panel lists, Data Bank attachments and backup downloads are filtered by character avatar. Telegram uses the existing bot with an owner-specific generic notice, e.g. “Eve March wrote a journal entry.” It never includes the entry body. VPS filenames retain the legacy `ava-log-` prefix for compatibility with Written Memory Search; avatar metadata and Data Bank ownership separate the entries, with collision suffixes preventing overwrites.

Validation: 54 Node tests pass with ST 1.19.0 source-contract checks enabled, including the real boot/panel adapter in a simulated DOM, migration and failed-save rollback, independent enable switches, per-character daily scheduling, source-context/previous-entry isolation, read-back isolation and named notifications. Existing fixed-content fixtures still match byte for byte. The Chromium harness is updated but has not been executed for this release because Chromium startup was blocked in this environment. Live installation remains to be checked in Joe's ST.

## Installation

Existing users: update **Ava Journal** in ST's extension manager, then reload. Confirm **Journal · 0.2.0**. Open Eve's chat and enable her journal, then repeat for Marnie. Ava's existing enabled profile is preserved automatically. Use **Write now** once in Eve's chat to verify the first live entry. No terminal or server changes are required.

New users: Extensions → Install extension → `https://github.com/joetharp1/ava-journal.git`. Open a character chat and enable Journal. Storage checks run automatically before writing.

## Review fixes and runtime checks

| Review item | Result |
| --- | --- |
| 1. File API shapes and live serving | **Source-verified; runtime check required.** Source check found and fixed a real path error: ST 1.19.0 stores files at `data/<handle>/user/files/`, returns `/user/files/<name>`, and serves `/user/files/*`. The prior `files/` adapter was wrong. Upload is JSON/base64 and verify returns URL-keyed booleans in the saved source. New tests execute ST’s actual URL helper against its actual directory template. The extension verifies these APIs through the active ST login before enabling/writing. |
| 2. Telegram setting names | **Confirmed against published Ava Initiation 0.1.9**, commit `a7be5c928fbf733ca0e431ae0550d26f65e99d5e`, index.js blob `d7b7aadca3241a0fc930e13afb50aacadb5f2b4e`. `NAME` at line 5; `telegramChatId` default/validation at lines 13 and 26; token read at 584; token write at 856; config plus token write at 877. Both values live in `extension_settings['ava-initiation']`. No live credentials read or exported; installed version remains unconfirmed. |
| 3. Optional dependency | manifest.json now declares `"optional": ["ava-initiation"]`. |
| 4. Word-count retry | Exactly one retry for the typed word-count error. The request stays identical; no new model instruction, no failed output added to context. Other provider/parse failures do not retry immediately. Both tries share the generation lock, draft checks, discard-on-resume and 150-second deadline. |
| 5. Backoff on activity | New messages and edits update activity/context while preserving retryAt and failures. Tested that the 23:30 trigger still waits for the saved deadline. |
| 6. Token counting | Uses ST’s native `countTokensOpenAIAsync` on each message and sums the counts. Each count is cached for that trimming operation. No whole-array JSON token estimate. |
| Low context | Error reports configured context, required 3200 minimum and 2200 reserved tokens. |
| Rebind | “Rebind to current chat” selects its character, preserves existing files/records, clears stale in-memory context and leaves automatic writing off. Unavailable during generation/pending save. |

Live access attempt on 6 November 2026: HTTPS root returned HTTP 401 with `WWW-Authenticate: Basic realm="SillyTavern", charset="UTF-8"`. The connected browser could not open the authenticated site. This establishes an access blocker, **not** successful endpoint verification. No authenticated live verify/upload/read call, provider generation or Telegram send was performed. The user subsequently approved publication followed by live verification inside ST. Source and mocked tests are not represented as live results. Version 0.1.2 checks storage on enable and once per page session before any journal generation. Failure leaves writing paused with a visible status; Check storage retries it.

Path correction applies to the adapter, verify keys, upload return validation, read/open URLs, recovery index, panel backup path and tests. The files remain flat, named `ava-log-YYYY-MM-DD.md`; no server plugin or folder creation change is introduced. The actual deployed version must still be checked.

## 0.1.3 — fix stuck busy state

A source-backed defect in 0.1.2 could leave ST busy after a context-only attempt. `setSendButtonState(true)` sets `is_send_press`, and `isGenerating()` reads that same flag. The prior conditional cleanup therefore refused to release its own flag. This could prevent later journal attempts and opening chats. The earlier test harness incorrectly modeled those values as independent; it now matches ST and checks snapshot-only, no-job, reload and completed-write cleanup.

The journal now tracks ownership of the send flag. It always releases its own flag, unless a real (non-dry-run) generation starts and takes ownership. Dry-run context assembly does not transfer ownership. A completed/stopped streaming processor no longer blocks an attempt. Write now immediately shows “Preparing journal…” and disables the button while work is underway.

Update Ava Journal to 0.1.3 and reload to clear the previous page’s stuck flag. No chat files, character content, initiation settings or authentication settings are modified. This fix does not claim to diagnose a separate login failure.

## Additional 0.1.2 corrections

- Source-contract assertions cover both `getChatCompletionModel` from openai.js and `hasPendingFileAttachment` from chats.js.
- A Telegram failure preserves the saved filename in the success status.
- Index recovery rejects empty closing beats.
- A failed settings save restores the previous extension settings, local config and controls.
- The original 0.1.2 conditional Send cleanup is superseded by the ownership fix above.
- Read-back stays in its existing system role; no wording or placement changes were made.
- Storage verification creates a UUID-named `ava-journal-check-….txt` containing only a generic check message, confirms upload/verify/read bytes, deletes its own file and verifies removal. It uses ST CSRF headers and the current login. It never calls a model or Telegram and never registers the probe as a journal. A filename collision prevents upload; a content mismatch prevents deletion. Each request has a 20-second timeout. Failed checks are not repeatedly retried by the timer; use Check storage or enable again. An interrupted/failed probe may leave a harmless unregistered test file.

## What it does

- Eight transcript messages arm ordinary writing. User and completed assistant positions count; system messages, swipes and regenerations do not add counts.
- Once automatically per Europe/London calendar day: 90 minutes idle, or after 21:00 with 30 minutes idle. A failed/blocked first opportunity does not suppress the evening opportunity.
- 23:30 catch-up with any recorded activity ignores scene hold and idle, but keeps the generation lock and draft checks.
- First-load/wake backfill for yesterday uses the recorded avatar, chat ID and saved context. It does not switch the open chat or borrow its conversation.
- Scene hold defaults off; it suppresses ordinary automatic writing and backfill. Catch-up and manual writing bypass it.
- Write now bypasses automatic enable, timing, count, scene hold, retry delay and daily cap. It requires Ava selected, an empty composer and the generation lock.
- Conversation activity in either tab discards an in-flight journal entirely. Only this request is aborted; no global stop-generation call.
- A 150-second provider deadline and journal-only exponential retry delay (2–30 minutes) prevent rapid retries. Nothing alters initiation backoff.
- Journal output uses trailing user-role instruction, temperature 0.95 and request-local 1,600-token allowance. The active preset is not modified. No visible user turn, no entry in the transcript, no model tools executed.
- Title comes from the same request. Valid title: 3–6 words without punctuation. Missing/malformed TITLE uses the first five body words, unchanged. Body must be 150–250 words; a word-count failure receives one identical fresh request, then fails if still invalid. Output is never rewritten.
- The last three titles plus the latest final one or two sentences enter ordinary Ava conversation only. No injection into initiations, groups, other characters or quiet tasks.

## Storage and access

Server-relative files: `data/<handle>/user/files/ava-log-YYYY-MM-DD.md`, then `-2.md`, `-3.md`, etc. The UI shows the actual handle. Uses `/api/files/verify`, then `/api/files/upload`. Check and upload are not atomic, as accepted. The journal Web Lock prevents competing journal tabs, but an unrelated external writer could still race the upload endpoint.

Frontmatter: journal date, actual writing time with offset, timezone, title, avatar, chat ID and actual UTC writing timestamp. Backfilled entries retain yesterday as journal date.

Files are registered under Data Bank → Character and added to `disabled_attachments`. They remain accessible and known to ST cleanup while excluded from retrieval. ST's settings-save success event is checked, because its save function catches HTTP failures internally. Failed registration retains pending state for retry. An uncertain upload is recovered only when its recorded filename and exact bytes match.

The panel lists the latest 20, ordered by date and numeric suffix. It opens the actual file. Download all entries fetches the VPS files and produces one Markdown backup containing all entries and their original filenames. The index can be rebuilt from registered files after browser storage is cleared.

VPS files are not a backup. Container loss, a rebuild or deletion can remove them. Download a copy to separate storage weekly.

## Context and backfill mechanism — review this explicitly

The preferred context snapshot is the actual outgoing ordinary Ava prompt, captured after ST assembles its card, World Info and memory-extension context. The real completed assistant response is appended to the snapshot, never to the transcript. Request credentials and API request bodies are not saved in these snapshots.

For an existing/open chat without a captured normal request, ST's native `Generate('quiet', ..., true)` assembles a fallback snapshot without a paid generation or transcript write. World Info and card notes are included. ST skips generation interceptors during dry-runs; this fallback therefore cannot promise freshly recomputed interceptor memory. Subsequent ordinary chat requests supply the full normal pipeline.

Snapshots and activity records are private, in browser IndexedDB, partitioned by ST user. They retain today and yesterday only. Stored entries remain on the VPS; the private snapshot cache is not exported in this package and is not shared with Danny.

If yesterday's snapshot was never captured, the extension can assemble it when the recorded chat is opened and has no newer messages. If newer messages are already present, it leaves backfill pending rather than pretending current context is yesterday's. A closed/suspended app cannot guarantee a timed run; backfill also requires retained activity/context. This is a real limit, not a claim of guaranteed daily delivery.

Snapshots pin source/model/connection URL identity. If a different connection is currently selected, backfill waits for the original connection. No credentials are cached. Backfill supplies target date/timezone and the complete previous entry as JSON data, then Danny's exact journal instruction. Ordinary read-back remains small.

A day containing several Ava chats uses its most recently active recorded chat; it does not merge private conversations. CharMemory settings and written-memory tools are untouched. This reflective journal is not an exhaustive factual conversation log, and the small read-back is not full archive retrieval.

## Separation from initiation

No Ava Initiation file or stored state was modified. The checked published initiation head remains a7be5c928fbf733ca0e431ae0550d26f65e99d5e (0.1.9). Its live installation remains unconfirmed.

The journal takes its own Web Lock and, only while assembling/generating/saving, the existing initiation execution mutex `ava-initiation:v1:<handle>`. This coordinates concurrent provider access; it never reads/writes initiation timers, budgets, logs, rate limits, backoff or prompts. ST's send-state flag is held during this private operation and released in finally.

Optional Telegram notice uses the token and chat ID already saved in Ava Initiation, read-only. Default off. Notification text: `Ava wrote a journal entry.` No title or body is transmitted. A failed ping never rolls back a saved entry. No live bot call has been made in testing.

## Fixed content inventory

Only two model-instruction strings are authored by Danny. Both are in content.mjs and immediately preceded by the exact marker `// FIXED CONTENT — do not edit`.

| String | Source line | UTF-8 bytes | SHA-256 |
| --- | --- | --- | --- |
| JOURNAL_INSTRUCTION | content.mjs:2 (marker line 1) | 678 | 5a4949d4c6f40e596926dd7609f02597bbe5ab33894bc5ed0488c5a08473d2d6 |
| READ_BACK | content.mjs:11 (marker line 10) | 139 | f865072aa7b0d50ee8d56b376257483f47bc08630b0fbbb940ba7249d690edcc |

The instruction is the amended TITLE version, superseding the earlier prompt. Fixed text is byte-identical to the supplied text, including punctuation and line breaks. Ordinary runtime substitution resolves only `{{user}}`; read-back replaces only `[titles]` and `[beat]`. JSON data labels such as `journal_date` and `previous_journal` are implementation metadata, not added character directions. No card fields or World Info entries are edited.

Independent UTF-8 fixtures in tests/fixtures contain the exact source strings without a trailing newline. Equality is tested against exported runtime constants. Both strings are printed verbatim in the review handover, followed by numbered source.

## Validation

41 tests passed, including source-contract checks against the saved ST 1.19.0 source: daily triggers, DST/calendar boundaries, manual bypass, recorded-chat backfill, numeric suffixes, repeated-event counting, title fallback, exact content, no preset mutation, context budget, file collision/uncertain-upload recovery, Data Bank exclusion, request discard and generic Telegram.

For the earlier 0.1.x release, the browser harness passed at 393px width: storage-check failure blocks generation, then recovers with its temporary file removed; settings rollback; Telegram failure preserves Saved; a competing real generation retains Send lock; one word-count retry with identical request bytes; safe character rebind and restoration with existing journals retained; no paid request during snapshotting; manual second entry; draft preservation; two-tab generation exclusion; discard when conversation resumes in the other tab; no transcript append; inherited preset unchanged; correct Data Bank registration; normal read-back but no initiation injection; reload persistence; index recovery after browser-state deletion; no horizontal overflow; yesterday's actual prompt and memory-interceptor content used after opening another chat, with that chat left selected.

All provider, Telegram and file-server traffic in the browser harness used local fixtures. This is not a live ST/Venice/Telegram smoke test. No private conversation diagnostics were requested or shared.

Run:
`node --test tests/*.test.mjs`
Set `ST_SOURCE` to an ST 1.19.0 checkout for the six source-contract checks.
`node tests/browser.cjs` uses Playwright from `CODEX_PRIMARY_RUNTIME_NODE_MODULES` and `CHROMIUM_EXECUTABLE` (default /tmp/chromium).

## Live validation

Installation and the first real journal generation remain user-side checks. Enable in the intended character’s chat, wait for “Storage verified”, then press Write now once. The generated entry is a real dated journal file and is registered in Data Bank; no transcript message is added. The storage test itself is disposable and removes its own file. Report the panel status if either step fails; private chat diagnostics are not required.
