# Journal requests during conversation — 0.3.0-alpha.3

This review build gives a character one optional `write_own_journal` tool. Ava can
call it when she wants to record a meaningful moment, or when Joe asks during a
chat. It uses the existing journal writer and saved instructions. It does not
change her character, world, initiation scheduler or calendar event tool.

## What Joe will use

In Ava's one-to-one chat, open **Journal → Allow journal requests during chats**.
The setting defaults off and belongs to that character. Enabling it checks journal
storage and registers the tool. Automatic journalling can remain on or off.
Scene hold does not suppress an explicitly requested entry, matching Write now.

With compatible, enabled native tool calling, Joe can say, for example:

> Ava, put what we just talked about in your journal, please.

Ava can also choose the tool herself during an ordinary reply. The tool accepts
only a short optional focus, not a full entry, ID, character selection, calendar
edit or arbitrary instruction. The model decides whether to call it; actual
Venice support and correct live behavior remain to be verified. No keyword
detector rewrites Joe's messages. **Write now** remains the manual fallback.

The tool returns **queued**, not **saved**. After the conversational reply ends,
the existing writer runs when there is no draft, competing generation or initiation
request. There is no 90-minute wait or eight-message threshold for this path.
The panel shows queued, saved, failed or cancelled; failed entries have Retry and
pending entries have Cancel. It does not append a fabricated chat message saying
the entry was saved. Existing optional Telegram notices remain unchanged.

## Context and duplicate behavior

- A request freezes the ordinary ST-assembled context at the moment of the call,
  including the current user message, character and available memory context.
  It can wait through continued chatting without replacing that moment with a
  later topic. The subsequent conversational reply is not required for the entry.
- The writer receives the brief focus as structured request data alongside the
  existing journal instruction. The 150–250-word format and validation remain.
  Private writing disables tool calling and rejects unsolicited tool-call output.
- One request is identified by avatar, chat ID, user-message position and parsed
  send timestamp. Regeneration, swiping and tool follow-up generations reuse it.
  The model cannot mint a new ID. A later user turn can request another entry.
- One outstanding requested entry per character. Further calls while it is queued
  or failed coalesce into that request; persistent links keep those turns from
  becoming fresh requests upon regeneration. Retry/cancel resolves a failed one.
- Requested entries can be additional entries on the same day. Existing numbered
  filenames prevent an existing entry being overwritten. As with Write now, a
  saved entry satisfies the ordinary once-per-day automatic check; no second
  automatic daily entry has been added.
- The request waits for its recorded character/chat and connection. Other
  characters and group chats cannot execute it or receive its snapshot. Quiet,
  impersonation, automatic initiation and private journal generations do not offer
  this tool. Each character must be explicitly enabled separately.

## Durability and failure handling

The request and frozen context live in the existing per-user browser IndexedDB
store. Reloading the same browser resumes them. Saved entries live on the VPS
through ST's existing authenticated file API and Data Bank registration. Each
requested file includes a `journal_request_id` field for saved-entry recovery.

Existing browser locks coordinate tabs and the initiation provider mutex. This
feature does not create a server-wide journal queue or solve simultaneous writes
from different devices. Pending requests do not migrate to a second phone and can
be lost if browser storage is cleared; completed VPS files remain separate.

If conversation activity interrupts writing, discard the unfinished output and
keep the request queued for a later safe opportunity. Provider/validation failures
wait for an explicit Retry. If the file upload completed but registration failed,
recover the same pending file rather than generating another. Cancellation is
disabled once a file is being saved; finish or recover that save first.

Turning the opt-in off pauses queued requests; Joe can cancel them or enable it
again. A cancelled request stays cancelled on regeneration of that user turn.
Completed/cancelled request records release their stored context snapshot.

## Acceptance before release

The journal-request feature needs only the UI extension update; it does not require
the optional calendar server plugin. It remains on a review branch, with no live
installation or API calls performed. Main remains unchanged.

Automated tests exercise the real boot adapter, tools, queue and writer callbacks:
extra same-day entries, busy/draft waiting, reload recovery, frozen context, repeated
turns, coalescing, other-character isolation, opt-in rollback, explicit retry,
interruption/cancellation and recovery after an uncertain save. Existing journal
and calendar tests pass. This is behavioral validation, not rendered UI acceptance.

Before release, in an isolated ST 1.19 instance:

1. Verify the mobile checkbox/status/retry/cancel controls and storage check.
2. Use Joe's chosen Venice model with native tool calling enabled. Ask for a
   journal entry; observe `write_own_journal` and a queued response, then a saved
   file after the reply. Verify the file's text and requested moment.
3. Regenerate that turn and reload: no extra entry. Send a new user turn asking
   for another entry: a distinct numbered file is saved.
4. Keep a draft open, switch chats and simulate a provider failure. Verify waiting,
   isolation and explicit retry. Test a spontaneous tool choice separately; do not
   infer provider support or model reliability from a registration switch.
5. Keep requests disabled on Eve, Ríona and Marnie. Confirm no tool leakage and that
   the existing journal and memory features still work.

This permits a choice during a model turn. It does not run Ava continuously or
write/notify autonomously while the browser is closed. Server initiation remains
separate work.
