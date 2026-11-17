# Calendar acceptance before live installation

This is a review build, not an instruction to update the live VPS now. Keep the
existing initiation scheduler paused. Preserve the current image and all volumes.

## Isolated acceptance environment

1. Back up the actual config, data, plugins and extension volumes, along with the
   Compose file and current image ID. The November 11 backup screenshot is not
   evidence of a current backup. Restore into an isolated test instance first.
2. Use a separate ST 1.19.0 container with separate named volumes and a private
   test hostname. Never point its mounts at the live volumes. Use synthetic Ava
   chats and a test account; no real character/chat data is needed for acceptance.
3. Put this exact reviewed repository revision in the test plugins directory as
   `ava-calendar`; its `package.json.main` is `arc/server.mjs`. No `npm install` is
   required. Install the UI copy at the same revision using ST's extension path.
4. In the test config enable server plugins and disable server-plugin auto-update
   so the tested revision stays pinned. Restart only the test container. Confirm
   logs initialize `ava-calendar`; check authenticated requests and CSRF protection
   using the normal ST session. Unauthenticated calls must not reach the routes.
5. Open the synthetic Ava chat. In Journal → Ava’s calendar, Check server,
   explicitly confirm Ava, set Europe/London and a cycle start date giving day 13.
   Create. Reload and reconnect from a second test browser/device. Both should
   show the same state and use the same record.

## Browser and provider checks

- At a 393-pixel mobile width, expand all calendar sections. Check labels,
  buttons, select controls, date field, keyboard use and readable error messages.
  Confirm the existing journal panel still works and the page does not overflow.
- Make a synthetic ordinary Ava request. Capture its outgoing request in the test
  environment: exactly one current tagged calendar block, no stale duplicate.
  Perform a private journal request, including one while another character is
  selected. Confirm owner isolation and absence of the calendar event tool in
  private journal requests. Ríona/Eve/Marnie and group requests get no state block.
- Block the calendar endpoint temporarily in the test browser: Ava generation
  must stop before the model call. Other characters remain usable. Restore access.
- Begin one encounter using the control. Verify repeated completion calls and
  reloads reuse the same result. A tool cannot open a new encounter. A stale tab
  trying to begin with the old revision receives a conflict and must refresh.
- With Joe's chosen Venice model, explicitly verify native function calling is
  enabled and the provider accepts the schema. Use a synthetic scene established
  as eligible; observe one tool call/result and the follow-up state block. Do not
  change the model or infer support from the ST switch alone. If tool calling is
  unsupported, keep the manual completion path and report the limitation.
- Test a pregnancy at day 273 and then a manual jump to day 287. Birth should be
  recorded once, with postpartum day 0 and the date retained after reload. Test
  the direct birth stage override. Clearing its override must not undo birth.
- Check time-away catch-up with a synthetic pregnancy starting more than 287 days
  ago. Birth falls within the allowed historical window; postpartum/cycle state
  derives from that date, not the login date. The automated suite tests exact
  random outcomes and DST without changing the host clock.
- Day/stage overrides continue advancing from their anchors. At postpartum day
  84, cycle day 1 begins; first eligibility is cycle day 10/postpartum day 93.
- Download the JSON calendar record and compare with the test server record.
  Verify the independent volume backup includes `ava-calendar/state.json` under
  the authenticated user's root, then restore it into the isolated instance.

## Live rollout and recovery

Only after acceptance, take a fresh live backup and install matching reviewed
client/server revisions. Inspect the current Compose service/container name;
restart that existing container cleanly without pulling a new image. Joe chooses
the real Ava binding, arc type, timezone and start date in the panel.

Keep a copy of pre-change config and both installed revisions. If rollback is
needed, stop new generations, restore the prior client/server revisions and
configuration, then restart. Preserve the calendar JSON and all data volumes.
Do not erase records or restore the entire live VPS just to remove the calendar;
that would also discard unrelated newer chats. Do not offer a “disconnect” switch
that silently permits Ava requests to proceed without her configured clock.

Server code does not run narration or push notifications while a browser is
closed. Lazy catch-up preserves the calendar dates; proactive messaging remains
the separate initiation project.
