# Plan review verdict — #92

**VERDICT: APPROVE WITH CHANGES.** Designs A/B/C are sound in principle and every line number checks
out against the worktree. Four blocking items — three code, one test.

## MUST FIX

1. **Deleting `MAX_RING` removes the only hard bound on `room.inputs`; a tick-window floor is not a
   bound in bytes.** The `input` case does no dedup on `t`: a client resending the same `t` forever
   passes both guards (`msg.t >= room.due` holds because `room.due` trails `room.tick - d - 1`, and
   `msg.t - room.tick` is 0), and each message pushes a ring entry. Today `MAX_RING` caps that at
   2000 regardless of client behaviour; with the floor alone it is **unbounded** — process memory,
   and an unbounded `inputs:` array serialised into the next `resume` (`server/index.js:827`).
   Honest worst case: `MAX_CATCH_UP` x (4 client frames + <=1 substituted) ~= 18k entries, ~1-2 MB
   of JSON per resume — fine. **Adversarial worst case: unbounded — not safe.** This is a trust
   boundary (client input the relay stores), so **the ceiling stays**:
   ```js
   const MAX_RING = MAX_CATCH_UP * (SEATS + 1); // the honest ceiling, not the semantic bound
   ...
   while (room.inputs.length > MAX_RING) room.inputs.shift();
   ```
   The net-deletion claim survives (four lines out, one in); the "no count cap at all" claim does not.
2. **The refusal burns a repair in `desync()` and eventually drops the client from the match.**
   `desync` (`server/index.js:894-905`) does `client.repairs++; client.repaired_at = now;
   client.waiting = true; resume(client)`. If `resume` now returns silently, the budget is spent with
   nothing sent, and after `MAX_REPAIRS = 5` (`:77`) the client hits `drop_from_match` **having never
   received a repair**. That is exactly why `desync` already has
   `if (!room.snapshot) return void (client.waiting = true)` at `:875`. One line, same shape:
   ```js
   if (!room.snapshot || room.tick - room.snapshot.t > MAX_CATCH_UP)
       return void (client.waiting = true);
   ```
   Keep the `resume()` guard as well (the `resync`/`keep_snapshot` callers need it).
3. **`prune`'s `while (room.inputs[0].t < floor) shift()` is NOT equivalent to the filter it
   replaces — the ring is not sorted by `t`.** Frames from different clients arrive in any order
   (`msg.t` only has to be `>= room.due`), so `[{t:100},{t:98}]` is reachable. The prefix loop stops
   at the first entry `>= floor`, so pre-snapshot frames survive into the resume payload, and pruning
   **stalls entirely** while an out-of-order high `t` sits at the front. "Semantics are preserved
   exactly" is false. Use a prefix *guard* + filter *body*:
   ```js
   if (room.inputs.length && room.inputs[0].t < floor)
       room.inputs = room.inputs.filter((frame) => frame.t >= floor);
   ```
   (In steady state the floor is constant between snapshots, so the guard is false on almost every
   frame — the filter is not on the hot path.) **The `stamped` branch is fine as written**; `stamped`
   really is ascending, for the reason the plan gives.
4. **Test case 2 HANGS: `socket.receive` replaces the listener, and the inline polls have no
   timeout.** `WebSocket_Transport.receive` is `listener = fn`
   (`src/net/websocket_transport.js:53-55`), so the moment case 1 calls
   `thr_guest.socket.receive(...)` the `connect()` recorder stops filling `events` and every later
   `thr_guest.until(...)` — including case 2's wait on `msg.t === MAX_CATCH_UP + 1` — never resolves.
   **There is no test runner under this suite, so that hangs `npm test` forever.** The plan notices
   the hazard ("do not mix the two on one client") and then mixes them.
   Install one collector on the guest for both cases and wait with the file's existing
   `awaited(seen, type)` (`test/relay.test.mjs:726-740`, hoisted) plus a small predicate variant.
   **Never write `new Promise((resolve) => {/* poll */})` with no reject arm** — `awaited`'s 2s
   reject exists precisely so this suite fails instead of hanging.

## SHOULD FIX

5. §4 arithmetic off by one: after `input t = MAX_CATCH_UP + 1`, `room.tick = 3602`, so
   `room.tick - room.snapshot.t` is **3602**, not 3601. Outcome unchanged.
6. Memory figures contradict: §2 says "~400 KB before", §5 says "~200 KB today". Pick one, and state
   the 18k/1 MB figure as the **honest-client** ceiling.
7. **AC3 is not as untestable as claimed**: `payload.changes` is `room.stamped` serialised verbatim
   (`server/index.js:825`), and the suite already deep-equals it at `:690-697`. A one-line assertion
   on `served.changes` in case 1 beats the "asserts on relay internals" excuse. The genuinely
   unobservable part is the bound with *no* snapshot — say that instead.
8. Add a step: **post the AC4 gap (and the AC3 caveat) as a comment on #92 via `gh api`.** An
   untestable contract line belongs on the issue.
9. Case 2's `refused.find((msg) => msg.type === "room")` can match a room update that arrived before
   the `resync`. Record `refused.length` before sending and search from that index.
10. The `prune` comment is 12 lines of prose for a 6-line function. Trim to ceiling + upgrade path.

## VERIFIED CORRECT (do not re-derive)

- `MAX_RING` is an **entry** cap, not a byte cap (`server/index.js:41, 732, 1134`); pruning against
  the snapshot happens **only** in `keep_snapshot` (`:757-758`); reset only at `begin` (`:941-942`).
- **`client.waiting` survives a bare `return`** placed after the `queued` guard and before `:783` —
  no caller clears it (`:762, 875, 905, 1172`), and `keep_snapshot` re-drives `resume` for every
  waiting client *after* updating `room.snapshot`. Confirmed (with MUST FIX 2 as the one hole).
- `resume`'s `:804-805` loop really is `driver_at` un-specialised, and
  `drivers_at(room, room.snapshot.t)` is equivalent: `resume` only proceeds when
  `room.tick - room.snapshot.t <= MAX_CATCH_UP`, so `floor === room.snapshot.t`.
- **`substitute`'s seed-and-walk is tick-for-tick equivalent to `driver_at`**: seed applies changes
  `<= room.due`, `landing[t]` applies those in `(room.due, t]`, total `<= t`. A `stamp_driver` fired
  inside the loop lands at `room.tick + 2d > limit`, so it cannot land inside the run. The early
  `if (room.due > limit) return;` keeps the common zero-tick call free. **The `landing` map is 4
  lines and commented — not 3am cleverness.**
- **AC3's wording is satisfied**: the lookup is once per `substitute` call, not per seat per tick.
  (`holder_of` is still per seat per tick, but AC3 names the *driver* lookup, and the existing
  `ponytail:` at `:686-689` already owns it.)
- **The relay genuinely cannot host the AC4 check**: `keep_snapshot` stores `msg.body` as an opaque
  bounded string and never decodes it — the tick rides plaintext for that reason. **The deviation
  from the issue's hint is justified.**
- `room.now()` is the tick the payload arrived with at the AC4 comparison point (`room.js:91` sets
  `tick = msg.t`; `on_start` pauses the outgoing game and clears the snapshot timer; nothing advances
  `tick` except `step()`). No false positives — `push_snapshot` packs and sends the same `t`.
- Relay clock driven purely by `t` on `input` (`:1116`); no fake clock in `relay.test.mjs`;
  `MAX_CATCH_UP` already imported at `:8`; `pressed` at `:277`; `matrix` at `:624`.
- Case 1's wait works: `broadcast_frame` excludes only *queued* clients (`:97-99`), and
  `broadcast_state` reaches everyone (`:398-400`). **The test does fail without the fix** —
  `inputs[0].t === 201`, `inputs.length === 2000`.
- Scope clean: `src/game/snapshot.js` untouched, level still travels as a name, no relay decoding.
  **No collision with #82** — the edits at `:1133-1134` and `:1191` sit beside #82's `forged`
  counters, not on them.
- The unreproduced part is fairly declared, and **no proposed code depends on it**.
