# Plan review verdict — #84

**VERDICT: APPROVE WITH CHANGES.** All three code decisions (A, B, C) are correct. Two supporting
claims are false, and one test hangs instead of failing.

## MUST FIX

1. **The AC3 test infinite-loops on a red run.** `ending.catch_up(() => replayed++)` passes a `step`
   that never advances `tick`. Without the fix `target()` is 38 and `tick` stays 0, so
   `while (tick < target()) step()` **spins forever**. A regression test must fail, not hang.
   Replace the counter with the room's own step:
   ```js
   ending.catch_up(ending.step);
   assert.equal(ending.now(), 0, "so the replay stops at the end of the match, not past it");
   ```
   (`step` with `catching_up` true sends nothing, so it terminates: 38 today, 0 with the fix. Drop
   `let replayed = 0;`.) The plan's table row "`ending.catch_up` step count: 38" is wrong as written —
   today it does not return.

2. **§1's residual argument cites a guard that does not exist, and the race it dismisses is REAL.**
   There is no `stamp_input` function in `server/index.js`, and the `input` case (`:1087-1126`) has
   **no `room.started` check** — its only guards are `Number.isInteger(msg.t) && msg.t >= 0`,
   `client.queued.length`, and `msg.t < room.due`. `begin` resets `room.due = 0` and `room.tick = 0`
   (`:926-950`), so **a match-1 frame still in flight when `begin` runs is accepted under match 2**,
   sets `room.tick = Math.max(room.tick, 2701)` (`:1102`) and is fanned out — dragging every client's
   `newest` to ~2700 and re-creating the exact flood #84 is about, **from the relay side**.
   `room.js:134`'s `MAX_CATCH_UP` bound does not catch it (2700 - 0 < 3600). Ordered WebSocket
   delivery does not rule it out; the window is one round trip and is independent of the client.
   **Correct §1's text, and file it as its own relay issue** (`if (!room.started) return;` in the
   input case, or bound `msg.t` against `room.tick` after `begin`). Do NOT widen #84 for it — but do
   not leave it asserted as impossible.

3. **AC3 is knowingly half-met; say so on the issue and file the follow-up before closing.**
   Traced: a mid-match joiner sits on `#room`, so `to_lobby_soon()` (`viewmodels.js:485-493`) takes
   the `go("room")` branch — hash already `#room`, no `hashchange`, no `apply_route`, no
   `end_match()`. The level resolves, `build()` runs, `on_match_start` (`:597-615`) zeroes the board
   and `go("play")`s into a match that is over. With the fix the session is no longer frozen
   (`ended` never latches, `Game.start` pumps, the next `start` builds a fresh `Game` so it plays
   match 2 — **AC3's second half is met**), but **it never reaches the board**: it plays a solo
   continuation of a dead match until its own `limit_reached()` fires with no host to announce it.
   Record AC3's "reaches the board" as **deferred to the follow-up, not ticked**.

## SHOULD FIX

4. **§4's "the one way to get edit 1 wrong" does not hold.** Putting `newest = tick;` *after* the
   `msg.inputs` replay is behaviourally identical to before it, for every payload the relay produces:
   `until = Math.max(room.snapshot.t, room.tick - room.d - 1)` (`server/index.js:806`) and the ring's
   newest stamp is `room.tick - 1`, so `newest - d <= until` always, and `target()` is `catch_up_to`
   either way. The existing joiner assertions pass under both orderings. **Keep the placement** — it
   is the honest floor and robust if `until`'s formula changes — but **drop the "lands the joiner
   short" rationale**, which a reader will try to reproduce and fail.
5. **AC5 DOES have an assertion — the bug-C test is it.** "The change was applied" and "no key was
   written for a passed tick" are the same branch: `late.step()[1] === undefined` fails if the entry
   was stamped instead. **Re-label it** rather than adding an accessor. No new code.
6. **Sharpen the bug-C `ponytail:` comment by one clause.** Convergence is of the *driver table*, not
   of state, and two clients that passed tick `t` at different moments apply the change at different
   ticks, so they transiently disagree with each other as well as with the room. The comment should
   not read as if applying late were free of cross-client cost.

## VERIFIED CORRECT (do not re-derive)

- `newest`: written only at `room.js:157` (`schedule_input`), read only at `:174` (`target`). Three
  `schedule_input` callers (`:114`, `:144`, `:262`).
- `in_match`: written at `:109`/`:150`, read only at `:108` today. `game_session.js:130`'s `in_match`
  is a separate field.
- **`target()` is the right placement for bug B**: `game.js:141` sprints on `room.gap() > 0`, so
  guarding only the `while` leaves the pump stepping the same ticks; `ended` is `game.js:118`'s and
  latches `Game.start` at `:163`. One guard also covers `game_session.js:253` (`gap > MAX_CATCH_UP`)
  and `:343` (reconnecting).
- **`in_match` cannot change mid-loop**: `catch_up` is synchronous, and `room.step()` sends nothing
  while `catching_up`, so no transport re-entry is possible. "Check before" and "check each
  iteration" are identical.
- **Bug C — APPLY is right.** The `[t, b)` divergence exists under both options (B had not received
  the change), so applying adds nothing there; from `b` on, applying restores agreement with the
  room's table, while discarding leaves `drivers[seat] === "local"` forever, feeding `room.js:285-294`
  a `RELEASED` frame for a seat every other client gives the AI (`game.js:63-64`) — a fresh
  divergence every tick, plus forged frames the relay counts and drops. The "all clients past `t`"
  case that would make discarding self-consistent is **not reachable**:
  `t = room.tick + 2d ~= fastest_tick + 3d + 1`, so the fastest client cannot be past it.
  Converging beats permanently wrong.
- **AC5's boundedness**: `step` deletes `drivers_at[tick]` unconditionally every tick (`:252`), so
  refusing `t < tick` at write time makes every key reachable and deleted; residue at match end is
  wiped by the next `start`'s `drivers_at = {}` (`:98`).
- **`< tick` and not `<= tick`**: the loopback stamps at `current_tick + 2*0`, which after five
  `game.step()`s is exactly the room's tick — so the existing `local.room.set_driver(2, "ai")`
  assertion (`replay.test.mjs:183-188`) is the boundary guard, and it still passes.
- Routing `start`'s `msg.changes` through `stamp_driver` is a no-op against the real relay
  (`server/index.js:756` prunes `room.stamped` to `change.t > msg.t`), but it is the shared write
  path — **keep it**. The helper earns its four lines over two inlined copies of the same comment.
- **Bug A's live path**: `viewmodels.js:607-608` is `clearTimeout(leaving); leaving = null;` inside
  `game.on_match_start`, and `leaving` is the `HOLD_MS = 2000` timer from `to_lobby_soon`
  (`:483-493`) — same `Game_Session`, same `Room` (`game_session.js:162-192` rebuilds in place, never
  reconstructs the `Room`).
- **Test placement is right**: `replay.test.mjs` already builds bare `Room`s against stub transports
  (`delayed_room`, `behind`, `absurd`) and asserts `gap()`, `catch_up`, `set_driver`, `end_match`,
  `now()`. `Loopback_Transport.send` calls `to_client` synchronously for `start` and `match_end`.
- **No determinism risk to the checksum suite**: all three blocks use bare `new Room(...)` — no
  `Game`, so the `player`-array hazard does not apply; no writes to `global.window`; `local.room` is
  not read after `:307`. New names do not collide. `behind_transport` is at `:244`, above the
  insertion point.
- Arithmetic: `reused.gap()` is `299` today / `0` fixed; `ending.gap()` 38 then 0; `late.step()[1]`
  `RELEASED` today / `undefined` fixed. **All three fail today.**
- **No conflict with #82**: it touches only `room.js:3-8`; the three edits are at the `start` case,
  `target()`, and `schedule_input`/`driver`. Different hunks, no overlap.
