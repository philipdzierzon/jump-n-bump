# Plan review verdict — #86

**VERDICT: APPROVE WITH CHANGES.** Mechanism right, file right, size right. Two things must be
answered before it ships.

## MUST FIX

1. **AC2 has TWO residues, not one — say so ON THE ISSUE.**
   §2/§3 ("AC2 — No code") is sound only under the narrow reading *"held across the **whole**
   batch"*. The plan's own §1(b) contradicts the broad reading: *"Press `right` 10 ms before a
   wakeup that owes 60 ticks and you get 60 ticks — one second — of running."* That **is**
   multiplication beyond the wall clock the key was actually held, and it is precisely the
   player-visible symptom the issue names ("the bunny lurches in the direction they were last
   holding"). §6 correctly says only timestamps fix it and AC3 forbids those — so it is genuinely
   unbuildable here, but it is a **second** residue and the plan lists only the `gap()` sprint.
   **Mark AC2 partially met**, and record **both** residues on the issue itself (not only the PR
   body): (a) the mid-interval press inside an overrun batch — unfixable clock-free, bounded by #83;
   (b) the `gap() > 0` sprint — §5's reason. **What #86 fully closes is AC1.**

2. **The latch is cleared only by a read, and reads stop when the match stops — the plan never says
   what happens in the gaps.**
   `Game_Session` installs `document.onkeydown` in its constructor (`game_session.js:452-457`), and
   `session()` is built when the route enters **the lobby** (`viewmodels.js:928`), not when the match
   starts. No `room.step()` runs until the match begins — so **a control key tapped in the lobby
   latches and is delivered on the match's first tick**: a spurious jump/step at match start that
   does not happen today (today the keyup leaves `keys_pressed` false and tick 0 reads false).
   Same shape for a held seat handed to the AI (`Room.release` leaves the seat in `held` but
   `drivers[seat] !== "local"`, so `read_input` is never called for its scheme and **its latch is
   permanent**) and for a local pause.
   **Fix: one line — call `keyboard.release_all()` (#85's method) where the session starts a match —
   or state the window and accept it explicitly. It needs a decision, not silence.**
   (The names screen is safe: `session()` only exists from the `"room"` route on, so `jump_scheme`'s
   add-participant keydown at `viewmodels.js:1132` never reaches `Keyboard`.)

## SHOULD FIX

3. **Test duplication.** The couch block re-inlines a stub nearly identical to `batch_transport`.
   Parameterise `batch_transport(d, held, drivers)` and reuse — cuts ~20 of ~45 test lines.
4. **§5's refutation is STRONGER than stated.** `gap() > 0` fires on ordinary +/-1-tick peer jitter
   in *any* networked room, so the sprint branch is normally a **1-tick** run taken constantly, not a
   rare multi-tick one. One line; it hardens the "unsafe discriminator" argument and right-sizes the
   residue.
5. **Two imprecisions.** §1's table is introduced as "three kinds" and lists four rows. §5 writes
   `gap()` as `newest - d - tick`; it is `Math.max(catch_up_to, newest - d) - tick`
   (`src/net/room.js:172-181`). Conclusion unaffected.

## VERIFIED CORRECT (do not re-derive)

- **Three multi-tick runs, and `Room.catch_up` is unaffected.** `catching_up` gates the entire
  read/stamp block (`room.js:186-190`, `254-271`); both sampling runs are the `continue` at
  `game.js:141-144` and the fall-through at `:145-155`. **The issue's "one synchronous catch-up
  batch" is imprecise; the plan is right to correct it.**
- **Mechanism is clock-free and DOM-free.** `tapped` is a plain `evt.keyCode` map beside
  `keys_pressed`; `replay.test.mjs:91-92` drives `new Keyboard([])` with bare `{ keyCode }` objects
  under node and keeps working.
- **The landmine is REAL.** `held.forEach(function (seat, scheme) { if (drivers[seat] === "local")
  seats[seat] = read_input(scheme); })` (`room.js:256-258`) — up to four `input_frame` calls per
  tick. Wholesale clearing would let seat 0's read eat seat 1's tap.
- **Per-scheme clearing is sufficient.** `free_scheme()` (`viewmodels.js:1085-1091`) guarantees
  distinct `CONTROL_SCHEMES` indices per participant, so no two held seats share a key triple.
- **§5's `gap()` refutation holds.** A peer one tick ahead stamps `tick+3`; `newest - d = tick+1`, so
  `gap() === 1`. Gating input on that would blank a normally-jittery client. **Stamping `RELEASED`
  during the sprint is indeed wrong.**
- **AC5 parity.** `Keyboard` sees neither `d` nor the transport; `Room.step` calls `read_input`
  identically on both. `d` only moves where the pulse is stamped.
- **AC3 bit-identical.** `replay.test.mjs:116-124` emits exactly one `onKeyDown` **or** one
  `onKeyUp` per key per tick and then steps, so it can never produce down->up-without-a-read — the
  only sequence the latch changes. Checksum unchanged; `drive_right`, `local`, `delayed_room`,
  `behind`/`repaired` blocks all unaffected (they fire no key events at all).
- **Test expectations are arithmetically right.** `d=0` -> `up: [true,false,false,false]`,
  `right: [true,true,true,true]`; `d=2` -> first two ticks `RELEASED`, tick 2 carries the pulse.
  **The couch case does catch the wholesale-clear regression.**
- **Placement is safe.** Bare-`Room` blocks build no `Game`, so inserting after `delayed_room`
  (~`:233`) does not disturb the module-global `player` later blocks depend on.
- **#85 merge point correct.** `tapped` is `var`-declared, so `release_all`'s `tapped = {};`
  reassignment matches `keys_pressed = {}`.
- **Scope clean.** No pointer/touch handlers anywhere in `src/`; `CONTROL_SCHEMES` and `jump_scheme`
  untouched.
- **Ponytail rung correct**; the `ponytail:` comment (latch, not count) names a real ceiling with a
  real upgrade path.
