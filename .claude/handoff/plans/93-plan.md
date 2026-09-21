# #93 — A client's repair allowance resets on reload

Branch to build on: `82-relay-message-authorisation` (worktree
`.claude/worktrees/82`, HEAD `1b109a2`). Every line number below is that tree,
post-#82. Repo root for the port is `jump-n-bump/`.

Ceiling of the whole change: **one `Map` on the room, one helper, six
field-spelling changes, one deletion in `begin`, and one reconnect inserted into
an existing test block.** Nothing new is invented; the counters that exist today
are re-parented from the socket to the token.

---

## 1. What the code does today

### 1.1 The two counters, and where they live

Both live on the **`ws` socket object** (the relay hangs its per-client state
straight on the `WebSocket`), so both die with the socket.

`server/index.js:866-905` — `desync()`, the only writer of the allowance:

```js
function desync(client, t) {
    const room = client.room;
    // A hash held for a host hash that arrived after its sender went is nobody's
    // disagreement any more, and must not spend a repair.
    if (!room.clients.has(client) || client.dropped) return;
    if (!room.snapshot) return void (client.waiting = true);
    const now = Date.now();
    const since = now - (client.repaired_at || 0);
    // Quiet for long enough: the run this client was in is over ...
    if (since > repair_reset_ms()) client.repairs = 0;
    else if (since < repair_cooldown_ms()) return;
    room.desyncs++;
    if (client.repairs >= MAX_REPAIRS) {
        console.log(... "dropped after %d repairs with no let-up" ...);
        return drop_from_match(client);
    }
    console.log(... client.repairs + 1, MAX_REPAIRS);
    client.repairs++;
    client.repaired_at = now;
    client.waiting = true;
    resume(client);
}
```

`server/index.js:917-923` — `drop_from_match()`, the only writer of the flag:

```js
function drop_from_match(client) {
    const room = client.room;
    client.dropped = true;
    client.waiting = false;
    send(client, { type: "match_end", reason: "desync", matrix: last_board(room) });
    // The seat reads `(out of sync)` from here on, which is a change to the room.
    broadcast_state(room);
}
```

Every read of `client.dropped`, exhaustively:

| file:line | what it guards |
| --- | --- |
| `server/index.js:310` | `seat_labels()` — renders `Guest (out of sync)` on the board |
| `server/index.js:778` | `resume()` — refuses to hand the match back |
| `server/index.js:843` | `keep_checksum()` — stops comparing its hashes |
| `server/index.js:870` | `desync()` — a dropped client spends no further repair |

Every read/write of `client.repairs` / `client.repaired_at`: `:877`, `:880`,
`:885`, `:900`, `:903`, `:904` (all inside `desync`) and `:961-962` (inside
`begin`). That is the whole surface. Nothing else in the repo touches any of
the three — `src/` never sees them, and they are never broadcast.

### 1.2 The admit path that mints the fresh record

`server/index.js:512-563`, reached from all three doors — `create()` `:184`,
`join()` `:202`, `quick_join()` `:280`:

```js
function admit(client, room, msg) {
    client.room = room;
    client.arrived = ++arrivals;
    // Identity is a server-minted opaque token, per client rather than per participant ...
    client.token = String(msg.token || "") || randomUUID();
```

`admit` initialises `room`, `arrived`, `token`, `seats`, `queued`, `ready` — and
**not** `repairs`, `repaired_at` or `dropped`. On a reconnect the new socket is a
new object with all three absent, i.e. zero: `undefined >= MAX_REPAIRS` is false,
`!client.dropped` is true, and `now - (undefined || 0)` is larger than any
`repair_reset_ms()` so the first desync zeroes `repairs` outright. A reload
therefore buys a whole fresh five *and* un-ejects the client from the match it
was ejected from. That is the bug in one sentence.

### 1.3 The token

- Minted at `server/index.js:518`: `String(msg.token || "") || randomUUID()` —
  server-minted when absent, **accepted verbatim when the client sends one**.
- Returned to the client on the handshake, `server/index.js:559` (`token:
  client.token` inside the `joined` message).
- Stored client-side in `sessionStorage` under `"jnb:" + roomId`:
  `src/interaction/viewmodels.js:60-76` (`remember` / `recall`), written at
  `:776`, replayed on every join at `:865`, `:900`, `:1025`.
- What the relay keys off it: **seat reservation only** today — `room.seats[i]`
  is `{ token, name }` (`server/index.js:127-131`), reclaimed at `:522-527`,
  freed at `:503-504`; plus the away-host restore at `:545-549` and the
  reservation timer at `:589-596`.

So the token already *is* the "survives a reload" identity, and it already
carries something valuable (the seat). It is the right key; §5 says what it costs.

### 1.4 The match boundary

`begin()`, `server/index.js:928-1007`. It is the single entry to a match —
reached from `relay()`'s `"start"` case `:1066`, from the ready collapse `:1082`,
and from `countdown_zero()` `:1021`. What it already resets:

```js
    room.tick = 0;
    room.d = input_delay(room);
    room.started = true;
    room.seed = msg && msg.seed;
    room.snapshot = null;
    room.inputs = [];
    room.stamped = [];
    room.checksums = [];
    room.desyncs = 0;
    room.due = 0;
    room.missing = new Array(SEATS).fill(0);
    room.substituted = room.late = room.forged = 0;
    for (const other of room.clients) {
        other.waiting = false;
        other.resync_t = 0;
        other.pending = null;
        // A client dropped out of the last match plays this one: being out of step is the
        // match's state, never the room's (#41).
        other.dropped = false;
        other.repairs = 0;
        other.repaired_at = 0;
        other.last_t = -1;
    }
```

`:960-962` is AC3 already implemented — for *connected* clients. Note it walks
`room.clients`, so a token whose seat is merely reserved is missed; that is
harmless today (the counters died with its socket) and must stay harmless after
the change.

### 1.5 The eject path — AC4 is already honoured

`drop_from_match()` (`:917-923`, quoted above) touches **no seat**. It sets one
flag, sends that client alone the `match_end` the host's own walk to the lobby
sends, and re-broadcasts the room. The seat stays in `room.seats`, the board
labels it `(out of sync)` (`:310-318`), and `begin` clears the flag so the next
match is played normally. The behaviour is already asserted:

`test/relay.test.mjs:882-888`

```js
const after_drop = await chk_guest.until((msg) => msg.type === "room");
assert.deepEqual(after_drop.held, [1], "the seat is still the dropped client's to play next match");
assert.equal(
    after_drop.labels[1],
    "Guest (out of sync)",
    "and the board says why nobody is driving it, beside `(left)` and `(AI)` (#13)",
);
```

and `test/relay.test.mjs:904-919` asserts it plays the next match on the same
seat. **AC4: build nothing.** It is the repo's standing rule and #41 already
shipped it.

### 1.6 "dropped-frame count" — what the issue actually means

There is no per-socket frame counter. The issue body is a triage-AI paraphrase
of the parent audit, #81 §7, which is precise:

> **Repair allowance lives on the socket, not the token** — `client.repairs`/`dropped` at `:883-922`; a reconnect mints a fresh client in `admit` `:510-563`.

So the second thing is **`client.dropped`** — a boolean, not a count. The real
frame counters are all on the **room** and are deliberately per-match:
`room.late`, `room.forged`, `room.substituted` (`:158-165`, logged by
`report_match` `:350-358`) and `room.missing[seat]` (`:162`, reset per seat at
`:645`, `:702`, `:719`, `:795`). **None of them moves.** They are room-level
statistics and seat-level gap counts, not a per-player budget, and a seat's gap
count *should* restart when its holder comes back — that is #42's rule at `:795`.

Answer to "same lifetime question or different?" — **the three fields have one
lifetime between them, but for two different reasons**, and one of them is a trap:

- `repairs` + `repaired_at` are one value in two halves. Moving `repairs` and
  leaving `repaired_at` on the socket **does nothing at all**: `:877-880` reads
  `now - (client.repaired_at || 0)`, which on a fresh socket is `Date.now()`,
  always greater than `repair_reset_ms()`, so the very first line of the desync
  path zeroes the carried-over `repairs`. They must move together or the fix is
  a no-op that still passes a careless test.
- `dropped` is the half that makes an *ejection* stick. Without it a permanently
  desynced client reloads and `resume()` hands it the match back at `:778`,
  whatever the repair count says. It is also the half that is immune to the
  clock — `desync()` returns at `:870` before the quiet-period branch — which is
  what makes the test in §4 deterministic.

---

## 2. The design decision

**One `Map` on the room, keyed by token, holding one record per player; each
client holds a reference to its own record.** Emptied at `begin`.

```js
allowances: new Map(),          // token -> { repairs, at, dropped }
client.allowance = allowance_of(room, client.token);   // in admit
```

Why this rung and not a lower one:

- **Not "keep it on the socket and copy it forward".** There is no by-token
  lookup of a departed client — `leave()` `:574` deletes it from `room.clients`
  and the only surviving reference is a `setTimeout` closure `:589`. Copying
  would mean keeping dead sockets addressable, which is more machinery than a
  three-field record.
- **Not on the seat** (`room.seats[i] = { token, name }`). A client can hold two
  seats (the couch, `:418`), and a client can hold **none** and still desync —
  spectators are checksummed (`keep_checksum` has no seat test) and repaired
  (`resume` only excludes `queued` clients, `:782`). The allowance is a
  property of the client, so the seat is the wrong key.
- **A reference, not a copy.** Every existing read/write site keeps working
  unchanged in shape; only the field spelling moves from `client.x` to
  `client.allowance.x`. There is no synchronise-on-write step to forget.
- **A `Map`, not an object literal.** The key is `String(msg.token)` — raw
  client input. `{}` keyed by client input hands a client `__proto__` and
  friends; `Map` does not care. Same size, correct on the edge case.

**Lifetime and cleanup.** The map is emptied in `begin()` and every connected
client is re-pointed at a fresh record in the loop that is already there:

- that *is* AC3, for connected tokens and reserved-but-absent ones alike
  (better than today's `room.clients` walk, which misses the latter);
- it is also the cleanup — the map can only hold tokens that arrived during the
  current match plus the clients in the room, and it dies with the room at
  `:578`;
- and it does **not** reintroduce the reset, because a reload inside a match
  never passes through `begin`. Only the host starting a new match does, and a
  new match is the fresh start AC3 asks for.

Deliberately **not** deleting the record in `vacate()` or when the reservation
expires. Both run 60 s after a disconnect; a client willing to sit out its own
seat reservation to buy five more repairs is the same hole in slow motion, for
extra code. The map's growth is already bounded by the paragraph above.

Field names: `{ repairs, at, dropped }` — `repairs` and `dropped` keep the
spelling every reader already uses, `at` replaces `repaired_at` because the
record makes the prefix redundant.

---

## 3. The change, criterion by criterion

All in `server/index.js` unless stated.

### AC1 — the allowance survives a reconnect on the same token

**Edit 1 — the room literal, `create()`, after `:148`.** Placed next to
`desyncs` (same subject) and away from `inputs` / `stamped`, which #92 is
editing.

```js
        checksums: [],
        desyncs: 0,
        // What each token has spent of its repair allowance, and whether the relay has
        // given up repairing it this match (#41, #93). Keyed by token rather than kept on
        // the socket, because the socket is what a reload replaces: five on a socket counts
        // reloads, not repairs. Each client holds a reference to its own record, so a write
        // through one socket is the write the next one reads -- and `begin` empties the
        // map, which is both the fresh start a new match is and what keeps this from
        // growing for the life of the room. A Map rather than an object: the key is client
        // input, and `__proto__` is not a key an object literal can hold.
        //
        // ponytail: the token is minted here but accepted from the client (`admit`), so a
        // client that wants a fresh allowance can send a fresh token -- at the cost of the
        // seat reservation that same token is what holds. This closes the reload, not the
        // forgery. upgrade path: none short of an identity the client cannot choose, which
        // is not a thing this design has (#7).
        allowances: new Map(),
```

**Edit 2 — the helper, directly above `admit()` at `:512`.**

```js
// One record per token, made on the way in so nothing downstream has to test for it -- and
// found again rather than remade on a reconnect, which is the whole of #93.
function allowance_of(room, token) {
    let spent = room.allowances.get(token);
    if (!spent) room.allowances.set(token, (spent = { repairs: 0, at: 0, dropped: false }));
    return spent;
}
```

**Edit 3 — `admit()`, immediately after `:518`.**

```js
    client.token = String(msg.token || "") || randomUUID();
    // The repair allowance is the player's, not the socket's: a reconnect on the same token
    // comes back to what it has spent rather than to a fresh five (#93).
    client.allowance = allowance_of(room, client.token);
```

**Edits 4-8 — re-spell the five read/write sites.** Mechanical; no logic moves.

`:310` (`seat_labels`):
```js
        if (client.allowance.dropped) for (const seat of client.seats) dropped.add(seat);
```

`:778` (`resume`):
```js
    if (client.allowance.dropped) return void (client.waiting = false);
```

`:843` (`keep_checksum`):
```js
        if (client.allowance.dropped || msg.t <= (client.resync_t || 0)) return;
```

`:919` (`drop_from_match`):
```js
    client.allowance.dropped = true;
```

`:866-905` (`desync`) — one local, then the same arithmetic. The `|| 0` at `:877`
goes, because the record is born with `at: 0`:

```js
function desync(client, t) {
    const room = client.room;
    // The player's record, not this socket's: a reload is a new socket on the same token
    // and comes back to what that token has spent (#93).
    const spent = client.allowance;
    if (!room.clients.has(client) || spent.dropped) return;
    if (!room.snapshot) return void (client.waiting = true);
    const now = Date.now();
    const since = now - spent.at;
    if (since > repair_reset_ms()) spent.repairs = 0;
    else if (since < repair_cooldown_ms()) return;
    room.desyncs++;
    if (spent.repairs >= MAX_REPAIRS) {
        console.log(
            "room %s desync %d at tick %d, dropped after %d repairs with no let-up",
            room.id,
            room.desyncs,
            t,
            MAX_REPAIRS,
        );
        return drop_from_match(client);
    }
    console.log(
        "room %s desync %d at tick %d, repair %d of %d",
        room.id,
        room.desyncs,
        t,
        spent.repairs + 1,
        MAX_REPAIRS,
    );
    spent.repairs++;
    spent.at = now;
    client.waiting = true;
    resume(client);
}
```

(Comments at `:871-883` are unchanged and still correct.)

### AC2 — exhausting it and reloading does not get a fresh allowance

No further code. It falls out of AC1 twice over: the reconnected socket finds
`dropped: true` (so `resume` `:778` refuses and `keep_checksum` `:843` stops
comparing) and `repairs: 5` with a real `at` (so if it were somehow un-dropped,
the next desync would drop it again immediately). The `dropped` half is the one
that carries it, and it is clock-independent.

### AC3 — the allowance still resets at a match boundary

**Edit 9 — `begin()`, replacing `:954-963`.** Net **minus two lines**:

```js
    // Nobody is waiting to be let into a match that has not started yet ...
    // A fresh match is a legitimately fresh allowance -- for the tokens in the room and for
    // the ones whose seat is only reserved alike -- and emptying the map is also what stops
    // it growing for the life of the room (#41, #93).
    room.allowances.clear();
    for (const other of room.clients) {
        other.waiting = false;
        other.resync_t = 0;
        other.pending = null;
        // A client dropped out of the last match plays this one: being out of step is the
        // match's state, never the room's (#41).
        other.allowance = allowance_of(room, other.token);
        // No frame in for a tick of a match that has not been stepped yet (#42).
        other.last_t = -1;
    }
```

`clear()` **must** precede the loop, or the re-pointed records are thrown away
again. Three assignments (`dropped`, `repairs`, `repaired_at`) become one.

### AC4 — ejected from the match, keeps its seat

**Build nothing.** Already true and already asserted — see §1.5. Say so in the
PR body rather than adding code for it.

### AC5 — the test

§4.

---

## 4. Tests

One file: `test/relay.test.mjs`. One reconnect inserted into the **existing**
`--- checksum desync detection (#41) ---` block (starts `:765`), which already
builds a room, exhausts the five and asserts the drop. Nothing new is scaffolded.

Helpers reused, all already in the file:

| helper | line | used for |
| --- | --- | --- |
| `connect(entry)` | `:55` | the reconnecting socket, `{ type: "join", id, token }` |
| `lobby(client)` | `:89` | awaiting `joined` and reading `held` / `labels` off it |
| `awaited(seen, type)` | `:727` | the positive assertions (2 s poll, rejects rather than hangs) |
| `cooled()` / `recovered()` | `:813-814` | the shortened cooldown and quiet period |
| `process.env.REPAIR_COOLDOWN_MS = "60"` / `REPAIR_RESET_MS = "400"` | `:809-812` | already set above the block, never unset |

Existing precedent for the reconnect itself: `:306` (`connect({ type: "join", id:
"ECHZX", token })`) and `:332` (the host restore). The token is read the way
`:270` and `:319` read it.

**Edit T1 — `:780`**, capture the token the block already throws away:

```js
const chk_token = (await lobby(chk_guest)).token;
```

**Edit T2 — insert after `:888`** (after the `(out of sync)` assertion, before
the "Dropped is dropped for the rest of this match" sub-test):

```js
// The allowance is the player's, not the socket's (#93). A reload is a new socket on the
// same token: it comes back to its seat, to the five it has spent and to being out of this
// match -- where before it came back to a fresh five and a relay willing to repair it five
// more times, which made the cap a limit on reloads rather than on repairs.
chk_guest.socket.close();
const chk_back = connect({ type: "join", id: "CHKSM", token: chk_token });
const reloaded = await lobby(chk_back);
assert.deepEqual(reloaded.held, [1], "the reload comes back to the seat the token held");
assert.equal(
    reloaded.labels[1],
    "Guest (out of sync)",
    "and to being the client the relay gave up repairing, which the new socket is not",
);
const back_saw = [];
chk_back.socket.receive((msg) => back_saw.push(msg));
```

**Edit T3 — re-point the rest of the block at the reconnected socket**, `:890`
through `:922`. Purely mechanical: `chk_saw` -> `back_saw` (`:892`, `:899`,
`:906`, `:915`), `chk_guest` -> `chk_back` (`:893`, `:896`, `:907`, `:912`,
`:918`, `:922`). Two message strings gain the point:

- `:890-891` comment: *"Dropped is dropped for the rest of this match, across a
  reload inside it: an ask still in flight, another hash, or a fresh socket on
  the same token must not hand the match back."*
- `:901`: `"a reload is not a fresh allowance -- the relay still will not repair it (#93)"`

That single re-pointing turns three existing assertions into coverage of the new
behaviour, at no extra runtime:

1. `:893-902` — resync + a mismatching hash **on the reconnected socket** is
   refused. **This is AC5's "exhausting the allowance, reconnecting and being
   refused", verbatim.**
2. `:914-917` — the next match's `start` reaches the reconnected socket on seat
   1. This is AC3 *and* it is the regression test for forgetting
   `other.allowance = allowance_of(...)` in `begin`: with only `clear()`, the
   reconnected client keeps an orphaned `dropped: true` record, no `start`
   arrives, `awaited` rejects at 2 s and the suite fails.
3. `:918-919` — the board stops saying `(out of sync)` for it.

**How each is deterministic** — the repo has no retries by design:

- The refusal turns on `allowance.dropped`, which **no timer resets**:
  `desync()` returns at its first guard for a dropped client, before the
  `repair_reset_ms()` branch. So the assertion cannot be flipped by the
  reconnect taking longer or shorter than the 400 ms quiet period. This is why
  the test is written against the exhausted case rather than a mid-run reload.
- The negative assertion uses the same fixed 100 ms settle every other negative
  assertion in this file uses, over an in-process localhost socket with the
  relay in the same event loop.
- The positive assertions use `awaited()`, which polls to a 2 s budget and
  rejects with a message rather than hanging.
- The reconnect lands inside the seat reservation: `RESERVE_MS` is back to its
  60 s default here (the test's own override is deleted at `:377`), so there is
  no race with the reservation timer at `server/index.js:589`.
- No new sleep, no new env knob, no new room.

**Not adding a second test for AC1's mid-run case** (four repairs spent, reload,
fifth repairs, sixth drops): same mechanism, one extra socket, and it would run
the five-repair sequence up against the 400 ms `REPAIR_RESET_MS` — a
timing-dependent test for a path the deterministic one already proves.

`npm test` runs the four suites and builds the client first; `npm run
format:check` is the CI gate (Prettier pinned, `tabWidth: 4`, `printWidth: 100`).

---

## 5. Risks

**5.1 The token is client-supplied, so this does not stop a hostile client —
state it plainly.** `server/index.js:518` takes `msg.token` verbatim. A client
that wants a fresh allowance can send a fresh token and get one, exactly as
before. What it costs is the seat: seats are reserved *by token*
(`:127-131`, `:522-527`), so a forged token arrives seatless and has to find a
free seat — and in a full room there is none. For a spectator, or in a room with
a spare seat, evasion is free.

So the fix is **weaker than the issue implies**: it closes the honest reload —
which is the reported behaviour, the one that happens by accident and the one
that makes the cap meaningless in normal play — and does not close deliberate
forgery. This is a finding, not a reason to skip it: the accidental path is the
one every permanently-desynced client takes, and nothing cheaper closes it. The
`ponytail:` comment in Edit 1 records the ceiling and that there is no upgrade
path short of an identity the client cannot choose. Abuse-by-forgery belongs
with #47's rate limiting, not here.

**5.2 A dropped client that reloads is now stuck for the rest of the match.**
Before: it reloaded back into the match. After: it reconnects, holds its seat,
asks `resync`, and `resume` refuses — the page sits on its "Rejoin the match"
spinner with nothing said, until the host starts the next match. That is #41's
intended behaviour and #76's missing message (out of scope), plus the
`resuming`-latches-forever gap the audit filed as #81 §6.3. **Name it in the PR
body** so it is a known consequence rather than a bug report next week.

**5.3 Two sockets on one token share one record.** A duplicated tab copies
`sessionStorage` (`:519-521` names this case). Both clients then point at the
same allowance. That is arguably correct — it is one player — but it is a
behaviour change worth one sentence in the PR.

**5.4 `client.allowance` is assumed present.** Four readers dereference it
(`:310`, `:778`, `:843`, `:870`). Every client in `room.clients` got there
through `admit`, which is the only writer of `room.clients` besides `begin`'s
re-point, and `relay()` is unreachable without `client.room`. Safe today; it
would TypeError if a future path ever added a client to a room without `admit`.
As a bonus it removes a latent `NaN`: a mid-match joiner's `client.repairs` is
`undefined` today and is only saved from `undefined++` by the quiet-period branch
happening to fire first.

**5.5 Conflict surface with #92**, which lands between #82 and this and touches
the same file (input ring, `room.stamped` pruning, `driver_at` -> `drivers_at`,
the `resume` path). Land #93 **after** #92 and rebase; the overlaps are:

| this change | #92 also touches | how to keep it clean |
| --- | --- | --- |
| room literal, new field after `desyncs: 0` (`:148`) | `inputs` / `stamped` a few lines below (`:150-156`) | keep the new field adjacent to `desyncs`, never to `inputs`/`stamped` |
| `resume()` first guard, `:778` | the body/end of `resume` (a refusal when the ring has a hole) | one line at the top of the function; take both sides |
| `begin()` client loop, `:954-963` | `room.inputs` / `room.stamped` resets at `:941-943`, above the loop | different hunk, but adjacent — expect a context conflict, not a semantic one |
| `test/relay.test.mjs` `:880-922` | a new test after the snapshot block (`~:700`) or appended | different block; check the tail of the file for an appended clash |

Nothing here reads `room.inputs`, `room.stamped`, `driver_at`/`drivers_at` or the
ring, so there is no semantic fight — only text.

---

## 6. Deliberately not doing

- **AC4 — anything at all.** `drop_from_match` (`:917-923`) already leaves the
  seat alone, the board already says `(out of sync)` (`:310-318`), `begin`
  already clears it, and `test/relay.test.mjs:882-888` + `:904-919` already
  assert it.
- **Moving `room.late` / `room.forged` / `room.substituted` / `room.missing[]`.**
  Per-room, per-match statistics and per-seat gap counts, correct where they are;
  a returning holder's gap count *should* restart (`:795`, #42).
- **Deleting an allowance record on `vacate` or reservation expiry.** Would hand
  a client that waits out its own 60 s seat reservation a fresh allowance — the
  same hole, slower — for extra code. The map is emptied at every `begin`.
- **Persisting the allowance across matches or across a relay restart.** AC3 says
  the opposite, and rooms are in-process by design (`server/index.js:10-11`).
- **A second env knob, or making `MAX_REPAIRS` configurable.** Not asked for.
- **Telling the client it was ejected (#76), or any change to the repair
  mechanism itself (#42/#41).** Confirmed out of scope and neither is touched:
  the payload, the cooldown, the quiet period and `MAX_REPAIRS` are all
  unchanged — only where the counter is kept moves.
- **A second test for the mid-run reload (AC1 in isolation).** Same mechanism as
  the AC2 test, and it would be timing-dependent on `REPAIR_RESET_MS`.
