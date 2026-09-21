# Findings for the maintainer

Everything below was confirmed by an independent plan-review or code-review agent against source,
not merely asserted by the agent that found it. None of it is in scope for the issue that surfaced
it — each needs a tracker write the maintainer should approve.

## A. Corrections to issue bodies (CONFIRMED)

1. **#83 AC6's rationale is factually wrong.** It says `test/replay.test.mjs` "steps the simulation
   by hand and never enters the loop". It *does* enter it — `:269` calls `behind.game.start()` and
   the next line asserts `room.now() === 38` synchronously. The criterion is right, the reason is
   not, and the wrong reason points at a tick-count bound that would break that assertion.
   **Already filed** as a comment on #83 (issuecomment-5760406257).
2. **#85's second premise does not hold.** "The same happens when the `Connection lost` overlay takes
   focus" — there is no `.focus()` anywhere in `src/`, and `.reconnecting` is `pointer-events: none`
   (`jnb.html:63`) with no `tabindex`/`autofocus`/`<dialog>`. Recorded in PR #100's body.
3. **#88's suggested rung for item D is wrong.** The issue says the relay's `(left)`/`(AI)`/
   `(out of sync)` labels "are used only by the scoreboard". They are not: `display_names()` feeds
   both the scoreboard heads **and** `match_result`, so a `(host)` suffix would print
   "Dott (host) wins with 3 bumps." — a shape `router.test.mjs:93-96` pins. The relay must send
   `host_seat` instead.
4. **#89 says the resuming flag is cleared on three paths. It is four** — `viewmodels.js:475`, `:604`,
   `:672` and `:889`. `lost_connection` (`:889`) genuinely needs the clear.
5. **#89's "Quick Join" is loose.** The landing Quick Join button opens no socket; the socket is
   **Take the seats** (`jnb.html:191`). The fix binds the right button.
6. **#93's "dropped-frame count" is a triage paraphrase.** `client.dropped` is a **boolean**. The
   real frame counters (`room.late`/`forged`/`substituted`/`missing[]`) are already on the room and
   already per-match; none of them moves.
7. **#86's "one synchronous catch-up batch" is imprecise.** Three multi-tick runs exist.
   `Room.catch_up()` (the resume replay) sets `catching_up` and samples nothing — it is unaffected.
   The two that sample off a frozen snapshot are both in `pump`.
8. **#92's AC4 hint cannot be followed.** The issue suggests the relay's `late`/`forged` counter
   idiom, but the relay never decodes the snapshot body — the tick rides plaintext for that reason.
   The check belongs on the client.

## B. New bugs found while planning (each needs its own issue)

9. **The relay's `input` case has no `room.started` guard.** `begin` resets `room.due = 0` and
   `room.tick = 0`, so a match-1 frame still in flight when `begin` runs is accepted under match 2,
   sets `room.tick = Math.max(room.tick, 2701)` and is fanned out — dragging every client's high-water
   mark and re-creating the exact flood #84 is about, **from the relay side**. `MAX_CATCH_UP` does not
   catch it (2700 - 0 < 3600). Window is one round trip, independent of the client.
   *Found and confirmed while reviewing #84. Deliberately NOT fixed there.*
10. **A client arriving in a match's final second never reaches the board — two routes.** This is
    #84's deferred AC3 half. (a) A resume build on the match screen has `leaving` set and
    `on_match_start` cancels that walk. (b) A client joining from the lobby never had `leaving` set at
    all (`to_lobby_soon` returns early off the match screen) and is routed to `#play` with a nulled
    board regardless. Both end in a solo continuation of a dead match.
    Related: `game_session.js:253` bails out of `build()` when `room.resume && gap > MAX_CATCH_UP`;
    with #84's `gap()` now reading 0 after a `match_end`, that escape hatch can no longer fire.
11. **Sound players accumulate one per lobby visit.** Separate from #91 (per repair) and much slower,
    but real. *Found while planning #91, confirmed by its reviewer.* After #91 a session that never
    plays a match costs 7 elements where master cost 0.
12. **A stale-cache client would be ejected from every match forever with no way out.** `levels[name]`
    is deleted only on fetch *failure*; a successfully-resolved stale promise is held for the tab's
    lifetime. #95's plan adds one clause to the desync copy ("If it keeps happening, reload the
    page.") to give it an exit — worth checking that lands.
13. **A dropped client that reloads is stuck on its rejoin spinner until the next match.**
    `viewmodels.js:648`/`:651` latch, so the page asks once and sits. Pre-existing; #93 does not add
    a new failure class but makes it more reachable. Overlaps #76.

## C. Contract lines that cannot be tested (must be recorded, not silently skipped)

14. **#92 AC3** — no direct assertion for the bound with *no* snapshot (the reviewer found
    `payload.changes` IS assertable, so only that narrower part is untestable).
15. **#92 AC4** — one console line, browser-only.
16. **#93 AC1's `repairs`/`repaired_at` half** — the whole test turns on `dropped`. Acceptable only
    because the record design makes a partial move structurally unreachable; that is the argument,
    not "covered twice over".
17. **#89 AC2** — with the enable binding in place the second click never reaches `create_room`, so
    `pending.close()` is exercised by nothing.
18. **#86 AC2 is partially met, with two residues**: (a) a key pressed mid-interval before a wakeup
    that owes N ticks still yields N ticks of holding — unfixable clock-free, bounded by #83;
    (b) the `gap() > 0` sprint. What #86 fully closes is AC1.

## D. Process finding: planned assertions that measure nothing

**Twice a planned-and-plan-reviewed browser assertion was vacuous**, caught only by an implementer
running it red:

- **#85** — `deepEqual(sounds, [])` after a blur PASSED without the fix. `movement.js:62,92` restores
  `jump_ready` only on a tick that sees `action_up` false, so a *held* ArrowUp jumps once and is
  silent after. A latched key is as silent as a released one. **Plan and plan review shared the wrong
  assumption.** Fixed by inverting: re-press the held key; a jump can only land if the sim let go.
- **#91** — `assert.ok(bumps <= 1, ...)` PASSED without the fix; `window.__audio` accumulates
  page-wide and `walk()` is five sessions deep by the repair. Fixed as a before/after delta.

A third, pre-existing instance was found and marked in #85's PR: the "muted is silent" assertion at
`browser.test.mjs:~1390` would pass with the mute deleted, for the same `jump_ready` reason.

**Lesson:** in this repo a browser assertion is not trustworthy until seen RED. Plan review catches
wrong *reasoning*; only running catches wrong *measurement*. "Prove it fails first, report observed
vs reasoned" earned its keep twice.

**Third instance, caught by CODE review rather than the implementer (#91):** the second assertion was
*logically implied* by the first — `Sound_Player` is the only `createElement("audio")` site, so
zero-elements-made made zero-bumps-played unfalsifiable. Deleting the loop guard
(`sound_player.js:50`), the entire implementation of AC4, left the whole browser suite green.
Only mutation testing exposed it.

**Reinforced lesson:** "prove it fails first" is necessary but NOT sufficient — an implementer can
see assertion 1 go red and never notice assertion 2 is dead weight. **Mutation-test each acceptance
criterion separately**: delete the specific line that implements it and confirm a specific assertion
goes red. That is what caught this one.
