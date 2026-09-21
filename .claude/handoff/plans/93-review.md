# Plan review verdict — #93

**VERDICT: APPROVE WITH CHANGES.** The design is right and every cited line number lands where the
plan says. One claim about the test is factually wrong and must be corrected.

## MUST FIX

1. **§4's "regression test for forgetting `other.allowance = allowance_of(...)` in `begin`" is
   WRONG.** The plan says that with only `clear()`, "no `start` arrives, `awaited` rejects at 2 s and
   the suite fails." **It does not.** `begin`'s send loop (`server/index.js:988-990`) is:
   ```js
   for (const other of room.clients)
       if (!other.queued.length)
           send(other, { type: "start", ... });
   ```
   No `dropped` test, no allowance test — the `start` goes to every non-queued client regardless.
   Assertion 2 (`test/relay.test.mjs:915-917`) passes either way.
   The assertion that **does** catch a missing re-point is **3**, `:918-919` — `seat_labels` reads
   `client.allowance.dropped`, so an orphaned `dropped: true` record keeps the label at
   `Guest (out of sync)` forever. And it catches it by **hanging, not failing**: `connect().until()`
   (`:81-88`) has **no timeout**, unlike `awaited()` (`:727-742`).
   Correct the prose to name assertion 3 and the hang. (Not asking for a bounded wait — `:918` has
   that hazard today and adding one is machinery this change doesn't need.)

## SHOULD FIX

2. **The room-literal placement claim is optimistic.** `desyncs: 0` is `:148`, the `stamped` comment
   block is `:149-155`, `stamped: []` is `:156`. Inserting after `:148` puts the new field *between*
   `desyncs` and the `stamped` comment — **directly adjacent to what #92 edits**, not "away from" it.
   Either say "expect a context conflict here too", or park the field after `forged: 0` (`:165`),
   further from #92 and still among the per-match counters.
3. **Reuse `lobby_token`.** `test/relay.test.mjs:87` already has
   `const lobby_token = async (client) => (await client.until((m) => m.type === "joined")).token;`
   (used at `:1440`). Edit T1 should be `const chk_token = await lobby_token(chk_guest);`, not a
   hand-rolled `(await lobby(chk_guest)).token`.
4. **AC1's `repairs`/`at` half ships UNTESTED — say so rather than implying otherwise.** §3/AC2
   claims the behaviour "falls out of AC1 twice over", but the entire test turns on `dropped`; a fix
   that moved only `dropped` into the Map and left `repairs`/`repaired_at` on the socket passes the
   whole suite. That is acceptable **because the record design makes the partial move structurally
   unreachable** (all three fields are one object, assigned once in `admit`) — but *that* is the
   argument to write down. Declining the mid-run test is defensible, though it is a margin call: the
   sequence would fit inside `REPAIR_RESET_MS = 400` (steps are ~100-190 ms apart today).
   **Name the gap in the PR body.**
5. **Trim the 12-line room-literal comment** — six lines carry it; no other field in that literal
   gets twelve. **Keep the `ponytail:` note** — it matches the documented form and records a real,
   deliberate ceiling.

## VERIFIED CORRECT (do not re-derive)

- **Claim 1 exact.** Writers: `desync` `:877-904`, `drop_from_match` `:919`, `begin` `:960-962`.
  Readers of `dropped`: `:310`, `:778`, `:843`, `:870` — nothing else. `admit` `:512-533` sets
  `room`, `arrived`, `token`, `seats`, `queued`, `ready` and **none of the three**.
  `room.clients.add` exists only at `:533`; `drop_from_match` is called only from `:893`.
  **The surface is closed.**
- **Claim 2 right — and the ISSUE's wording is wrong.** `client.dropped` is a **boolean**. No
  per-socket frame counter exists at all; `room.late`/`forged`/`substituted` (`:357-359`, reset
  `:949`) and `room.missing[]` are all on the room and correctly per-match. **None of them moves.**
  Say this in the PR rather than working around the issue text.
- **Claim 3 — the trap is real.** `:877` is `now - (client.repaired_at || 0)`, `:880` zeroes
  `repairs` when `since > repair_reset_ms()`. On a fresh socket `since === Date.now()`, so **moving
  `repairs` alone is a silent no-op.** Also confirms the bonus: a mid-match joiner's `client.repairs`
  is `undefined` today and only escapes `undefined++` because that branch fires first.
- **Claim 4 — `Map` is right** for the reason given: `admit:518` takes `String(msg.token || "")`
  verbatim, and `allowances["__proto__"] = rec` on an object literal sets the prototype rather than
  an own key. **`client.allowance` as an alias earns its place**: all five sites have `room` in
  scope, so the alternative is five `allowance_of(room, client.token)` calls — a *mutating getter in
  read paths* like `seat_labels` — versus one assignment plus one re-point in `begin`.
- **Claim 5** — `begin`'s `clear()`-then-re-point is AC3 and the cleanup in one; `clear()` must
  precede the loop. A token that never returns is dropped at the next `begin`; **a reload inside a
  match never passes through `begin`, so no reset is reintroduced.** Growth bounded by
  admits-during-one-match; forgery-driven growth is #47's.
- **Claim 6 — AC4 needs NO code.** `drop_from_match` `:917-923` touches no seat;
  `test/relay.test.mjs:882-888` and `:904-919` already assert the seat and the next match.
- **Claim 7** — `:518` accepts `msg.token` verbatim; seats are reserved by token (`:127-131`,
  `:520-527`), so a forged token arrives **seatless**. The framing is right, and the deterrent is
  **stronger** than the plan says: a seatless forger lands in `queued`, and `resume` `:782` refuses
  queued clients, so it gets no repairs either. In a room with a spare seat, evasion is free —
  exactly as stated.
- **AC5 determinism sound.** `:870` returns before the `repair_reset_ms()` branch at `:880`, so
  nothing resets `dropped` on a timer; the assertion cannot be flipped by reconnect duration.
  `joined` spreads `room_view` (`:373-396`), so it carries `labels` and `held`. T3's re-point list is
  exact. **Re-pointing does not weaken the existing assertions** — each tests the same thing about a
  socket that is now the reconnected one, which is strictly more.
- **Red before green confirmed.** Unfixed, the reconnected socket has `dropped` absent, seat 1 is
  `online` with `drivers[1] === "local"`, so T2's label assertion reads `"Guest"` and fails outright.
- **Close-then-reconnect ordering is not a new risk** — `test/relay.test.mjs:305-307` already does
  `socket.close()` immediately followed by `connect({ ..., token })` and asserts `held: [1]`.
- **§5.2 accurate and acceptable to name rather than fix.** `viewmodels.js:648`
  (`if (resuming || ...) return;`) with `resuming = true` at `:651` latches, so the page asks once
  and sits — already the state of a dropped client that *doesn't* reload. **PR-body material, not
  work for #93.**
- Formatting: longest helper line ~93 chars, inside `printWidth: 100`.
