# Plan review verdict — #85

**VERDICT: APPROVE WITH CHANGES.**

## MUST FIX

1. **"a session is built per match" is wrong — and the plan ships that claim in a source comment.**
   `Game_Session` is built **per lobby entry**: `apply_route` calls `end_match()` for any route != `play`
   (`viewmodels.js:909`, which nulls `current_game` at `:544`) and then `session()` for route `room`
   (`viewmodels.js:928` — its own comment reads "A session from the lobby on"). It is built again on
   every reconnect-into-match (`viewmodels.js:791`).
   So sessions are strictly *more* frequent than per match — every bounce into the lobby, match or no
   match. **Change the comment to**: "a session is built on every entry to the lobby and again on
   every reconnect". The conclusion (bare assignment, not `addEventListener`) is unchanged and in
   fact **stronger**.

## SHOULD FIX

2. **The overlay refutation's second leg only covers half the overlay.** `connection_text`
   (`viewmodels.js:209-213`) is non-empty for `disconnected()` **or** `reconnecting()`; the repair
   path (`viewmodels.js:202`, `!!game && game.reconnecting()`) shows the same div while the session
   and its `Keyboard` are very much alive — so "`lost_connection()` discards the keyboard" does not
   answer it.
   **The refutation still holds on the first leg alone**: no `.focus()` anywhere in `src/`, and
   `.reconnecting` is `pointer-events: none` (`src/jnb.html:63`) with no `tabindex`/`autofocus`/
   `<dialog>`. Put THAT in the PR body, not the discarded-keyboard argument.
3. **The new `deepEqual(sounds, [])` runs unmuted; its existing twin does not.** The assertion at
   `browser.test.mjs:1359-1363` is backstopped by `if (!muted) play(audio)` (`sound_player.js:43`).
   The new one has no such backstop. Reachable sources for a stationary lone bunny were checked:
   `sfx.fly` has **no call site at all**; `sfx.splash` needs water (`movement.js:248`); `sfx.spring`
   (`movement.js:213`) is the `BAN_SPRING`-tile bounce and fires with no input. Looping `bump.mp3` is
   safe (the recorder pushes only on `.play()`, `browser.test.mjs:105-109`).
   Sound on the pinned seed — but **if it ever flakes, narrow to**
   `assert.ok(!(await sounds(sound_page)).includes("jump.mp3"), ...)` rather than total silence.
4. **Line citations drifted** (implementers navigate by them): `end_match` is `viewmodels.js:520`,
   not `:214`; `session()` is `:547-625`, not `:527-568`; M/P are `:427`/`:438`.
   (`game_session.js:449-457`, `:452`, `:455`, `lost_connection` `:880`, `jnb.html:128`,
   `browser.test.mjs:1350`/`:1352` are all exact.)
5. `Room.step()` sends "every tick, unconditionally" **inside `if (!catching_up)`** (`room.js:254`).
   Immaterial to the fix — catch-up ticks are replayed history — but don't quote it as branchless.

## VERIFIED CORRECT (do not re-derive)

- `keys_pressed` is **fully private**: repo-wide grep hits only `src/game/keyboard.js:14,23,24,25,30,34`
  (the `prototype/touch/*.html` hits are prose in comments). AC4 is about the flush not becoming a
  leak, exactly as the plan says.
- Latch->wire path confirmed end to end: `game_session.js:75-80` read fn -> `room.js:255-263`
  `read_input`/`schedule_input`/`transport.send` -> `game.js:60-70` `update_player_actions` writes
  `action_left/right/up`. No branch between the map and the wire.
- `game_session.js:452-457` really are bare assignments, and they are the file's **only** DOM
  registrations — `addEventListener` appears nowhere in `game_session.js`, only at
  `viewmodels.js:936` (hashchange) and `:1132` (names-screen jump key), neither touching the map.
- **M/P really fire from `onKeyUp`**: `keyboard.js:34-37` runs
  `key_function_mappings[String.fromCharCode(evt.keyCode)]`, and `game_session.js:427`/`:438`
  register `"M"`/`"P"`. A `release_all` that looped `onKeyUp` **would toggle mute and the
  scoreboard**. The plan's sharpest call is right — do NOT loop `onKeyUp`.
- **Layering/determinism clear**: `src/game/keyboard.js` is DOM-free by construction — it takes
  `{keyCode}` plain objects, and `replay.test.mjs:91` drives it from node with `new Keyboard([])`.
  `new Keyboard` exists at exactly two sites (`game_session.js:72`, `replay.test.mjs:91`); nothing in
  `src/game/` would call `release_all`. Reassigning the `var` is safe — all three methods close over
  the binding. The FNV-1a checksum cannot move.
- `window.onblur = keyboard.release_all` as a **bare reference is safe**: `release_all` reads no
  `this` and takes no argument, and the file is closure-style throughout. A synthetic
  `new Event("blur")` dispatched on `window` **does** invoke an assigned `window.onblur`
  (target-phase; `bubbles` irrelevant, `isTrusted` unread), and `document.onvisibilitychange` is a
  real IDL handler attribute. Element blur will **not** reach it — `blur` does not bubble and an
  assigned handler is non-capturing — so the `is_typing` text fields are not a false-flush hazard.
- Test rig at the insertion point is exactly as described: local room, `clock.install` +
  `pauseAt(1748051689473)` (`:1281-1282`), AI off on empty seats (`:1336`), `ArrowUp` **held** not
  pressed (`:1343-1344`), `jump.mp3` the one observable for the one bunny.
- **The `up`/`down` restore is genuinely load-bearing**: without it the existing `:1359-1363`
  "muted is silent, not quiet — five seconds of held jump" assertion passes **vacuously**, since the
  flushed map means nothing was jumping.
- **It goes RED on `af04c21`**: no `blur`/`visibilitychange`/`onblur` handler exists anywhere in
  `src/`, so the held `ArrowUp` survives the synthetic event and five wound seconds produce repeated
  `jump.mp3`.
- The `ponytail:` comment is warranted — real ceiling (proves the handler, not that Chrome fires blur
  on alt-tab), concrete upgrade path, matching the existing one at `browser.test.mjs:227-228`.
- **Nothing widened**: AC1/AC2 two lines, AC3 genuinely free, AC4 three lines, AC5 one walk. No
  teardown API, no `document.hidden` guard, no wrappers, no `pagehide` — each declined for a stated
  reason that holds.
