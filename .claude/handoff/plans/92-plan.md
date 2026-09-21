# #92 — Snapshot and input-ring bookkeeping: a hole on resume, an unbounded array, a discarded tick

Branch `92-snapshot-input-ring`, based on `82-relay-message-authorisation` (**not** master).
All line numbers below are post-#82 (`1b109a2`), in
`/Users/philipdzierzon/Documents/sbx/jumpnbump/jump-n-bump/.claude/worktrees/92`.

Files touched: `server/index.js`, `src/interaction/game_session.js`, `test/relay.test.mjs`.
Nothing else. No new files, no new constants, one constant **deleted**.

---

## 1. What the code does today

### The three structures

The relay keeps three per-room things that a mid-match joiner needs
(`server/index.js:137-154`):

```js
        seed: 0,
        snapshot: null,
        inputs: [],
        ...
        stamped: [],
```

- `room.snapshot` — `{ t, matrix, body }`, the host's packed state. The body is never
  decoded by the relay (deliberate, #12).
- `room.inputs` — **the input ring**: every frame fanned out since that snapshot.
- `room.stamped` — **the stamped-frame array**: `{ t, seat, driver, was }` driver changes.

### Fault A — the ring can lose frames the snapshot still needs

**The ring and its fixed size** — `server/index.js:35-41`:

```js
// The input ring: every frame the relay has fanned out since the host's last snapshot, so
// a client joining mid-match gets the gap between that state and now (#40). The host
// snapshots every 2s, which is ~120 ticks of frames from up to four clients.
// ponytail: a hard cap on entries rather than on bytes, in case a host stops snapshotting
// -- the ring then holds the newest ~500 ticks and the oldest fall off the front. Upgrade
// path: drop the room's snapshot and stop ringing at all if that is ever a real state.
const MAX_RING = 2000;
```

The existing `ponytail:` comment **already names this bug** and calls it hypothetical
("in case a host stops snapshotting"). It is not hypothetical: a backgrounded tab's
`setInterval` is throttled to ~1/min.

**The two push sites, each with the count cap** — `server/index.js:731-732` (substituted
frames) and `server/index.js:1133-1134` (relayed frames):

```js
        room.inputs.push({ t, seats });
        if (room.inputs.length > MAX_RING) room.inputs.shift();
```

```js
            room.inputs.push({ t: msg.t, seats });
            if (room.inputs.length > MAX_RING) room.inputs.shift();
```

**The prune — only on snapshot arrival** — `server/index.js:745-762`:

```js
function keep_snapshot(client, msg) {
    const room = client.room;
    if (!client.host || !room.started) return;
    ...
    room.snapshot = { t: msg.t, matrix, body: msg.body };
    // The frames and the driver changes that state already accounts for are the ones
    // nobody will ever ask for again: what both lists are for is the gap between it and
    // now, and the snapshot's tick is where that gap starts.
    room.inputs = room.inputs.filter((frame) => frame.t >= msg.t);
    room.stamped = room.stamped.filter((change) => change.t > msg.t);
    for (const other of room.clients) if (other.waiting) resume(other);
}
```

**The resume path that serialises snapshot + following frames** —
`server/index.js:773-829`, ending:

```js
    const until = Math.max(room.snapshot.t, room.tick - room.d - 1);
    ...
        t: room.snapshot.t,
        until,
        ...
        snapshot: room.snapshot.body,
        inputs: room.inputs,
    });
```

**The trace.** The host snapshots from `setInterval(push_snapshot, SNAPSHOT_MS)` with
`SNAPSHOT_MS = 2000` (`src/interaction/game_session.js:27, 372`), packing at its own tick
(`src/interaction/game_session.js:314-318`). A backgrounded tab's interval is throttled to
roughly one a minute. Its *simulation* is not throttled to the same degree — `pump()` in
`src/game/game.js:124-145` sprints while `room.gap() > 0`, so the host's tick stays with
the room; only the snapshot stops arriving.

So between two throttled snapshots the room advances ~3600 ticks while
`room.snapshot.t` stays put. The ring takes one entry per client frame plus one per
substituted tick — with four seats that is ~500 ticks before `MAX_RING` starts shifting
the oldest off the front. `room.inputs[0].t` is then ~3100 ticks *after*
`room.snapshot.t`, and `resume()` ships both, untouched, with that hole between them.

**Nothing detects it.** The joiner replays the hole as released keys —
`src/net/room.js:280-289`:

```js
        drivers.forEach(function (driver, seat) {
            if (driver !== "local" || frames[seat]) return;
            frames[seat] = RELEASED;
            // Not the first d ticks, where every seat is substituted for by definition, and
            // not a replayed gap, whose holes are the relay's ring rather than this
            // client's lateness (#70).
            if (catching_up || tick < self.d) return;
```

`if (catching_up ... ) return;` — a hole inside a replayed gap is not even counted. The
comment already knows the ring digs them. The client's only other guard is
`gap > MAX_CATCH_UP` in `build()` (`src/interaction/game_session.js:255`), which is about
the *size* of the gap, not about holes in it.

### Fault B — the stamped-frame array is unbounded

Pushed on every driver change — `server/index.js:641-652`:

```js
function stamp_driver(room, seat, driver) {
    const t = room.tick + 2 * room.d;
    if (driver === "local") room.missing[seat] = 0;
    broadcast_frame(room, { type: "driver", t, seat, driver });
    room.stamped.push({ t, seat, driver, was: room.drivers[seat] });
```

Pruned in exactly one place — `server/index.js:758`, inside `keep_snapshot`. Reset only at
`begin()` (`server/index.js:942`). So a host that stops snapshotting means it grows for the
rest of the match.

**Cost 1 — the reverse scan, per seat per tick** (`server/index.js:666-671`, called at
`server/index.js:696`):

```js
function driver_at(room, seat, t) {
    let driver = room.drivers[seat];
    for (let i = room.stamped.length - 1; i >= 0; i--)
        if (room.stamped[i].seat === seat && room.stamped[i].t > t) driver = room.stamped[i].was;
    return driver;
}
```

```js
        for (let seat = 0; seat < SEATS; seat++) {
            if (driver_at(room, seat, t) !== "local") continue;
```

Four full passes over `room.stamped` on every tick `substitute()` covers. The existing
`ponytail:` comment on `substitute` (`server/index.js:686-689`) already names it:
"`holder_of` and `driver_at` are linear scans run per seat per tick".

**Cost 2 — the whole array serialised on resume** (`server/index.js:803-806, 825`):

```js
    const ahead = room.stamped;
    const drivers = room.drivers.slice();
    for (let i = ahead.length - 1; i >= 0; i--) drivers[ahead[i].seat] = ahead[i].was;
```

```js
        changes: ahead.map(({ t, seat, driver }) => ({ t, seat, driver })),
```

Note lines 804-805 are **the same loop as `driver_at`, un-specialised for one seat**. The
helper the fix needs already exists in this file, inline, one function away.

### Fault C — an unpacked snapshot's tick is discarded

`unpack_snapshot` reads the tick out of the buffer and returns it
(`src/game/snapshot.js:86-105`):

```js
export function unpack_snapshot(ints, rnd, objects) {
    var at = 0;
    var tick = ints[at++];
    ...
    return tick;
}
```

The one caller drops it — `src/interaction/game_session.js:283`:

```js
            unpack_snapshot(resumed, rnd, objects);
```

The room's tick comes independently, off the message — `src/net/room.js:91`:

```js
                tick = msg.t | 0;
```

which the relay filled from `room.snapshot.t` (`server/index.js:816`). Two numbers for one
tick, never compared. (The only other call is `test/replay.test.mjs:476`, which is a
headless replay fixture and also discards it — leave it.)

---

## 2. The design decision for A

AC1 offers a choice. **Both, and they are the same expression** — that is what makes this
cheap.

The ring is capped by *entry count* today, which has nothing to do with what a resume
needs. What a resume needs is *ticks*: everything from `room.snapshot.t` to now. And there
is already a ceiling on how many ticks a resume may ever be: `MAX_CATCH_UP = 3600`, moved
into `src/net/room_config.js` by #82 and enforced on both halves — the relay refuses to
raise the room clock past it (`server/index.js:1100`) and the client refuses a gap past it
(`src/interaction/game_session.js:255`).

So:

> **Floor the ring at `max(room.snapshot.t, room.tick - MAX_CATCH_UP)`** — it then keeps
> exactly what the snapshot needs, bounded, with no count cap at all. `MAX_RING` is
> deleted.
>
> **Refuse a resume when `room.tick - room.snapshot.t > MAX_CATCH_UP`** — the one case
> where that floor cannot cover the snapshot, which is also exactly the case where the
> client would refuse the payload anyway.

Why this and not "refuse only":

- **Refuse-only fails AC2.** A backgrounded host's throttled interval makes the ring drop
  frames within ~8 seconds, but the snapshot only refreshes once a minute. A refuse-only
  relay would turn away every joiner for ~52 seconds out of every 60 — an unserviceable
  resume, which is the thing AC2 names. With the floor the resume is serviceable the whole
  time.
- **The refusal condition falls out for free.** It needs no ring inspection and no new
  constant: `room.tick - room.snapshot.t > MAX_CATCH_UP` is both "the floor cannot reach
  the snapshot" and "the client would refuse the replay". One `if`.
- **It is a net deletion.** `MAX_RING` goes, both `if (… > MAX_RING) shift()` lines go,
  both `filter` lines in `keep_snapshot` go, and one `prune()` replaces all five.
- **Ejection rule respected.** The refusal is not an ejection: `resume()` is only ever
  called with `client.waiting` already `true` (`server/index.js:762`, `905`, `1172`), so a
  bare `return` leaves the ask standing and the *next* snapshot answers it — exactly the
  existing behaviour for a client that asked before the host had snapshotted at all
  (`server/index.js:875`, `1170-1173`). The client keeps its seat, stays in the room, and
  plays the next match either way.

Memory ceiling of the change: the ring can now reach `MAX_CATCH_UP` ticks × ~5 entries
≈ 18k entries (~1 MB of JSON on the resume that follows), against ~400 KB before. That
only happens when a host has stopped snapshotting for a minute, and it is the price of the
joiner being servable at all. It gets a `ponytail:` comment (see §3).

---

## 3. The change, criterion by criterion

### AC1 + AC2 — the ring keeps what the snapshot needs, and the resume is refused when it cannot

**(a) Delete `MAX_RING` and its comment** (`server/index.js:35-41`) — replaced by the
`prune` helper's comment below.

**(b) Add `prune`, next to `keep_snapshot`** (put it just above `keep_snapshot`, ~line 739,
so it reads before its callers):

```js
// Everything the next resume could need and nothing older: the frames and the driver
// changes between the host's last snapshot and now. A count cap stood here instead, and a
// host whose tab is in the background has its snapshot interval throttled to about one a
// minute -- thousands of ticks, far more than the cap held -- so the frames the next
// snapshot would still need had already fallen off the front of the ring, and the resume
// after it shipped a state with a hole behind it. A joiner replays a hole as released keys
// and lands desynced, and nothing counts it: a gap's holes are not this client's lateness
// (#40, #70, #92).
//
// Without a snapshot to anchor on -- a host that has stopped sending them altogether --
// the catch-up ceiling is the anchor, because a gap wider than that is a resume nobody
// could replay (#51, #82).
//
// ponytail: a room whose host goes quiet for a minute therefore holds a minute of frames,
// ~18k entries, and serialises all of them into the next resume. upgrade path: merge the
// frames stamped for one tick into one entry, which is four fifths of that, if a relay
// ever runs short of memory.
function prune(room) {
    const floor = Math.max(room.snapshot ? room.snapshot.t : 0, room.tick - MAX_CATCH_UP);
    while (room.inputs.length && room.inputs[0].t < floor) room.inputs.shift();
    // A prefix test before the copy, because this runs on every frame the relay fans out
    // and a driver change is rare.
    if (room.stamped.length && room.stamped[0].t <= floor)
        room.stamped = room.stamped.filter((change) => change.t > floor);
}
```

**(c) Both push sites lose the cap and gain the call.** `server/index.js:731-732`:

```js
        room.inputs.push({ t, seats });
        prune(room);
```

`server/index.js:1133-1134`:

```js
            room.inputs.push({ t: msg.t, seats });
            prune(room);
```

**(d) `keep_snapshot` loses its two filters** (`server/index.js:754-758`):

```js
    room.snapshot = { t: msg.t, matrix, body: msg.body };
    // The frames and the driver changes that state already accounts for are the ones
    // nobody will ever ask for again: what both lists are for is the gap between it and
    // now, and the snapshot's tick is where that gap starts.
    prune(room);
```

Semantics are preserved exactly: floor `= room.snapshot.t` keeps `frame.t >= msg.t` and
`change.t > msg.t`, as before.

**(e) The refusal in `resume()`** — insert after the `client.queued` guard
(`server/index.js:782`) and **before** `client.waiting = false` (line 783):

```js
    if (client.queued.length) return void (client.waiting = false);
    // Further back than the ring can reach: the frames between the snapshot and now are
    // what close the gap, and past the catch-up ceiling there are not all of them any more
    // -- a payload with a hole behind the state, which the joiner replays as released keys
    // (#92). Left standing rather than refused: `waiting` is already set by every caller,
    // so the host's next snapshot moves the floor up and answers this ask, exactly as it
    // answers one made before there was any snapshot at all (#40). The client keeps its
    // seat and its place in the room -- being out of a match is never being out of the
    // room (#41, #42).
    //
    // ponytail: a host that never snapshots again leaves the ask standing for the rest of
    // the match, silently, which is what a room with no snapshot at all already does.
    // upgrade path: tell the client, if a room ever sits in that state long enough for
    // anybody to ask why.
    if (room.tick - room.snapshot.t > MAX_CATCH_UP) return;
    client.waiting = false;
```

`MAX_CATCH_UP` is already imported at `server/index.js:19`.

### AC3 — the stamped array bounded, and the lookup not scanning per seat per tick

**One idea, two edits.** The array is the cost, so (i) bound it — done already by `prune`
above, which is the *same* floor and the *same* call sites, no extra work; and (ii) stop
multiplying the scan by four seats and by every tick of a catch-up run. (ii) is a deletion:
the loop it needs is already written inline in `resume`.

**(a) Replace `driver_at` with `drivers_at`** (`server/index.js:663-671`):

```js
// The driver table as it was on a tick the room has not finished with. The table itself is
// updated the moment a change is stamped, but the change lands 2d ticks later, so the ticks
// in between are still the old driver's -- and substituting for a seat the room has not
// handed to the AI yet is exactly what those ticks need (#7, #42).
//
// All four seats in one pass. It answered a seat at a time, which was this scan four times
// on every tick of a catch-up run, over an array that only shrank when a snapshot landed
// (#92). `resume` had the same loop written out inline; it calls this now.
function drivers_at(room, t) {
    const drivers = room.drivers.slice();
    for (let i = room.stamped.length - 1; i >= 0; i--)
        if (room.stamped[i].t > t) drivers[room.stamped[i].seat] = room.stamped[i].was;
    return drivers;
}
```

**(b) `substitute` seeds once and walks forward** (`server/index.js:690-696`). Current:

```js
function substitute(room) {
    const limit = room.tick - room.d - 1;
    while (room.due <= limit) {
        const t = room.due++;
        const seats = {};
        for (let seat = 0; seat < SEATS; seat++) {
            if (driver_at(room, seat, t) !== "local") continue;
```

becomes:

```js
function substitute(room) {
    const limit = room.tick - room.d - 1;
    if (room.due > limit) return;
    // The table as of the first tick still to cover, and the changes that land inside the
    // run bucketed by the tick they land on: one pass over the stamped changes for the
    // whole run instead of one per seat on every tick of it (#92). A change stamped from
    // inside this loop -- the AI taking a seat over below -- is for `room.tick + 2d`, which
    // is past `limit`, so it lands after the run either way.
    const drivers = drivers_at(room, room.due);
    const landing = {};
    for (const change of room.stamped)
        if (change.t > room.due) (landing[change.t] = landing[change.t] || []).push(change);
    while (room.due <= limit) {
        const t = room.due++;
        for (const change of landing[t] || []) drivers[change.seat] = change.driver;
        const seats = {};
        for (let seat = 0; seat < SEATS; seat++) {
            if (drivers[seat] !== "local") continue;
```

Everything below that line is unchanged. Two load-bearing facts, both true today:
`room.stamped` is ascending in `t` (`room.tick` is monotonic within a match and `room.d`
is fixed at `begin`), so a bucket's push order is chronological; and `stamp_driver` called
from inside the loop stamps past `limit`, so it cannot land inside the run — which is what
`driver_at` did too (it returned the `.was` of any change stamped later).

**(c) `resume` reuses the helper** (`server/index.js:803-806`):

```js
    const ahead = room.stamped;
    const drivers = drivers_at(room, room.snapshot.t);
```

(the three-line inline loop goes; `ahead` stays for `changes` at line 825.)

**Honest limit.** `drivers_at` is still O(`room.stamped`), once per `substitute` call
rather than four times per tick. That is enough for AC3's wording and for the numbers —
after `prune` the array is bounded by the snapshot interval (a handful of entries in
normal play). An O(1) lookup needs a persistent due-time table plus a cursor that survives
pruning, which is real machinery for a bounded array. Add to the `drivers_at` comment:

```js
// ponytail: still a scan of the array, once per substitute call rather than four times a
// tick. upgrade path: a table kept alongside `room.due` and advanced with it, if a room
// ever holds enough stamped changes for the pass to show up.
```

### AC4 — the unpacked tick compared against the tick it arrived with

`src/interaction/game_session.js:281-284`. Current:

```js
        if (resumed) {
            var t2 = performance.now();
            unpack_snapshot(resumed, rnd, objects);
```

becomes:

```js
        if (resumed) {
            var t2 = performance.now();
            var packed_t = unpack_snapshot(resumed, rnd, objects);
            // Two numbers for one tick: the packed state carries the tick it was taken on,
            // and the relay carried the same tick in plaintext beside the body because it
            // never decodes one (#12). Until now the packed one was read out of the buffer
            // and thrown away, so a body and a tick from different moments would have
            // replayed the gap from the wrong end of it with nothing to say so (#92).
            //
            // ponytail: reported and then played anyway -- nobody has ever seen one, and
            // refusing would put a client out of a match over a log line. upgrade path:
            // refuse the payload, the way a body that will not decode is refused above, if
            // one ever turns up.
            if (packed_t !== room.now())
                console.log(
                    "snapshot packed at tick %d arrived as tick %d",
                    packed_t,
                    room.now(),
                );
```

`room.now()` is the tick the payload arrived with: `src/net/room.js:91` sets it from
`msg.t` on `start`, and nothing steps the simulation between `start` landing and `build()`
running (`on_start` pauses the outgoing game, `src/interaction/game_session.js:169`).

**Flagged deviation from the brief.** The brief points at the relay's `late`/`forged`
counters and `report_match`'s log line. That idiom cannot host this check: the relay never
decodes the body (`server/index.js:739-744`, and it is the reason the tick and the matrix
ride plaintext beside it), so the disagreement is only visible where the body is unpacked
— on the client. The idiom reused is the client's own, which is the same shape one layer
out: `report_repair` and `report_match` in the same file each print one `console.log`
line, and the `ponytail:` comment above `report_match`
(`src/interaction/game_session.js:215-218`) already records that the console is where this
client's diagnostics go. No new counter, no new message type, no new UI.

---

## 4. Tests

All in `test/relay.test.mjs`, appended to the `--- snapshot, mid-match join and resync
(#40) ---` block that ends at line ~700 (after `third.socket.close()`). Same harness:
`connect()`, `client.until(matches)`, `socket.receive(fn)`.

**There are no retries in this suite by design** (repo `CLAUDE.md`), so neither case may
depend on a timer for its result.

### Case 1 (AC5, AC1, AC2) — a resume after a throttled snapshot interval

Determinism comes from the fact that **the relay's clock is driven entirely by the `t` on
`input` messages** (`server/index.js:1113-1116`), not by any wall clock. A throttled
snapshot interval is simulated by *not sending a snapshot* while sending frames — no fake
clock is needed, and none exists in this file (`browser.test.mjs` has one for the match
time limit; nothing here does).

```js
// A host whose tab went to the background: the browser throttles its snapshot interval to
// about one a minute, so one snapshot is followed by thousands of frames and no second
// one. The ring used to hold a fixed 2000 entries, so the frames the snapshot still needed
// fell off the front of it and the joiner after that was handed a state with a hole behind
// it -- replayed as released keys, desynced on landing, with nothing counting it (#92).
const thr_host = connect({ type: "create", id: "THRTL" });
await lobby(thr_host);
await thr_host.seats(["Chief"]);
thr_host.socket.send({ type: "start", seed: 7, settings: {}, held: [] });
const thr_guest = connect({ type: "join", id: "THRTL" });
await lobby(thr_guest);
thr_host.socket.send({ type: "snapshot", t: 0, matrix, body: "THROTTLED-BODY" });
const FRAMES = 2200; // past the 2000 the ring used to cap at
for (let t = 1; t <= FRAMES; t++) thr_host.socket.send({ type: "input", t, seats: { 0: pressed } });
// Waited on rather than slept off: the relay handles one socket's messages in order and
// fans each frame out as it goes, so the guest seeing the last one proves every one before
// it was rung. The `resync` that follows is a different socket, and ordering between two
// sockets is not a thing to assume.
await thr_guest.until((msg) => msg.type === "input" && msg.t === FRAMES);
const thr_saw = [];
thr_guest.socket.receive((msg) => thr_saw.push(msg));
thr_guest.socket.send({ type: "resync" });
const served = await ... // see note below
assert.equal(served.t, 0, "the snapshot is still the one the host took");
assert.equal(
    served.inputs[0].t,
    1,
    "and the ring still starts at it: no hole between the state and the frames after it",
);
assert.equal(served.inputs.length, FRAMES, "every frame since, none shifted off the front");
```

Notes:

- `matrix` and `pressed` are already defined in this file (`matrix` at line 624; `pressed`
  is used from line 627 onward and defined earlier in the file).
- Seats 1-3 are the AI's in a one-seat room (asserted at line 663), so `substitute` adds
  nothing to the ring and the counts above are exact.
- The guest takes no seat, so `client.queued` is empty and `resume` serves it — the same
  shape as the existing `early_guest` case at line 715.
- For `served`, the cleanest race-free wait is the `until`-style poll the file already has
  at lines 726-740; or keep using `thr_guest.until(...)` and skip `socket.receive` — but
  note `until` *splices* consumed events, so do not mix the two on one client.

**Without the fix this fails deterministically**: `inputs[0].t` is 201 and
`inputs.length` is 2000.

### Case 2 (AC1, AC2) — past the ceiling: refused, then answered by the next snapshot

Continues in the same room, so no second setup:

```js
// Past the catch-up ceiling the ring cannot cover the snapshot at all, and a payload with
// a hole in it is not one to send. The ask is left standing rather than refused, and the
// host's next snapshot answers it -- which is what a room that had not snapshotted yet
// already does (#40, #92). The client keeps its seat and its place in the room throughout.
thr_host.socket.send({ type: "input", t: MAX_CATCH_UP + 1, seats: { 0: pressed } });
await thr_guest.until((msg) => msg.type === "input" && msg.t === MAX_CATCH_UP + 1);
const refused = [];
thr_guest.socket.receive((msg) => refused.push(msg));
thr_guest.socket.send({ type: "resync" });
// Two messages, one socket, handled in order: the room update the second one provokes
// cannot arrive before the answer to the first, so it having arrived is proof there was
// no answer. No timer, and nothing to flake.
thr_guest.socket.send({ type: "ready", ready: true });
await new Promise((resolve) => { /* poll `refused` for type === "room", as lines 726-740 */ });
assert.ok(
    !refused.some((msg) => msg.type === "start"),
    "a resume the ring cannot cover is not served with a hole in it",
);
thr_host.socket.send({ type: "snapshot", t: MAX_CATCH_UP + 1, matrix, body: "SECOND-BODY" });
await new Promise((resolve) => { /* poll `refused` for type === "start" */ });
const late_answer = refused.find((msg) => msg.type === "start");
assert.equal(late_answer.snapshot, "SECOND-BODY", "the next snapshot answers the ask standing");
assert.equal(late_answer.t, MAX_CATCH_UP + 1, "on the tick the host took it");
```

`MAX_CATCH_UP` is already imported at `test/relay.test.mjs:8`.

Why the tick arithmetic works: `#82` bounds a single frame to `msg.t - room.tick <=
MAX_CATCH_UP` (`server/index.js:1100`), so the room is walked there in two steps — case 1
leaves `room.tick` at 2200, and `MAX_CATCH_UP + 1 - 2200` is well inside the bound. After
it, `room.tick - room.snapshot.t` is `3601 - 0`, one past the ceiling, which is the
refusal. `ready` is unconditionally answered with `broadcast_state`
(`server/index.js:1077-1083`), and `broadcast` reaches a seatless client
(`server/index.js:88-90`) — unlike `broadcast_frame`.

Cost: one `substitute` run of ~1400 ticks, which is the run #82 deliberately allows once.
Every seat's holder has `last_t` past it, so it emits nothing.

### Not tested

- **AC3** has no assertion of its own. The bound is the same `prune` the two cases above
  exercise, and `drivers_at` is covered by the existing `payload.drivers` / `later.drivers`
  assertions at lines 661-698, which are exactly the table-at-a-tick answers it computes.
  Adding a "the array is short now" assertion means asserting on relay internals the
  protocol does not expose. Flagged, not silently dropped.
- **AC4** is a `console.log` on the client, reachable only through `browser.test.mjs`.
  A test would have to forge a snapshot body with a mismatched tick through a real socket
  into a real Chromium to assert one console line. Flagged as not worth it; see §6.

---

## 5. Risks / unknowns

- **Not reproduced.** This is one of the two issues in the chain whose failure mode has
  not been observed. Everything above is traced from the source. What reading establishes
  firmly: the ring is capped by entry count and pruned only on snapshot arrival
  (`server/index.js:41, 732, 757, 1134`); `resume` ships `room.inputs` verbatim beside a
  snapshot that may be thousands of ticks older (`:798-827`); the joiner fills missing
  seats with `RELEASED` and explicitly does not count it during a replay
  (`src/net/room.js:280-289`). What reading does **not** establish: the actual throttled
  interval of a backgrounded tab in the browsers people use (the "one a minute" figure is
  the issue's, and browsers differ), and whether a real desync follows in practice rather
  than a cosmetic divergence. Test case 1 makes the *mechanism* reproducible on a socket,
  which is as close as this repo gets without a real backgrounded tab.
- **The bigger resume payload.** ~1 MB in the pathological case, against ~200 KB today.
  `ws` has no send-side cap, and a client that cannot afford the replay already refuses it
  on `gap > MAX_CATCH_UP`. Named in the `prune` ponytail comment with its upgrade path
  (merge same-tick frames).
- **`room.stamped` is bounded by age, not by rate.** A seated client can still send
  `driver` messages as fast as its socket allows; each one passes #82's ownership check,
  pushes an entry and broadcasts. That is the un-rate-limited socket #47 owns, already
  ponytail'd in the `default:` clause at `server/index.js:1191-1196`. Out of scope here —
  this issue's unboundedness is "pruned only when a snapshot is kept", which `prune` fixes.
- **Ascending `room.stamped`.** `substitute`'s bucket order relies on it. True while
  `room.tick` is monotonic within a match and `room.d` is fixed at `begin`
  (`server/index.js:936-937`), both of which hold today. If `room.d` ever becomes
  adaptive mid-match the bucket needs a sort — worth a comment, not a guard.
- **`room.now()` as "the tick it arrived with" (AC4).** Correct because nothing steps the
  simulation between `start` landing and `build()` running. If a future change makes the
  level fetch overlap a running pump, the comparison would start reporting false
  disagreements. The check only logs, so the blast radius is a log line.
- **Formatting.** Prettier is pinned and `.githooks/pre-commit` gates the whole tree;
  run `npm run format` in the worktree before committing. `npm test` builds the client and
  opens Chromium — `npx playwright install chromium` must have been run.

---

## 6. Deliberately not doing

- **A no-op guard in `stamp_driver`** (skip when the driver is unchanged) — it would bound
  the spam vector, but it also skips `room.missing[seat] = 0` on a seat reclaimed while
  still `"local"`, which is AI takeover firing on a client that just came back. Not worth
  the risk for a rate limit that is #47's.
- **Merging same-tick frames into one ring entry** — four fifths of the memory, but the
  frames arrive out of order across clients so it is not a one-liner. Upgrade path in the
  `prune` comment.
- **An O(1) driver lookup** (persistent due-time table + cursor reconciled with the prune)
  — real machinery for an array that `prune` now keeps small. Upgrade path in the
  `drivers_at` comment.
- **Telling the client its resume was refused** — no message type exists for it, and a
  room with no snapshot at all is already silent in the same way. Upgrade path in the
  `resume` comment.
- **Refusing a snapshot whose packed tick disagrees (AC4)** — AC4 says *reported*, not
  *refused*. Refusing would eject a client from a match over a condition nobody has seen.
- **A test for AC4** — one `console.log` line, reachable only by forging a body through a
  real browser. Flagged rather than dropped: if it must be covered, the cheapest place is
  a direct `unpack_snapshot` assertion in `test/replay.test.mjs`, which already has the
  pack/unpack fixture at `:476`, but that tests the return value and not the caller.
- **Anything from the issue's Out of scope** — confirmed none of it creeps in. Snapshot
  *contents* are untouched (`src/game/snapshot.js` is read-only in this plan; AC4's edit is
  in the caller). The level still travels as a name in `room.config` (#95's). No
  server-side simulation: the relay still decodes nothing — the AC4 comparison is done on
  the client precisely because the relay cannot.
