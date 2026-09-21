# #84 — Room state does not survive a match boundary

Repo `philipdzierzon/jump-n-bump`, branch `master` @ `af04c21`.
Everything that changes is in **`src/net/room.js`** (three edits, ~20 lines net) plus three
new assertion blocks in **`test/replay.test.mjs`**. No relay change, no protocol change, no
change to `src/game/` or `src/interaction/`.

**Concurrent change to land on first.** The sibling branch for #82 removes the
`export var MAX_CATCH_UP = 3600;` declaration and its comment (`room.js:3-8`) and imports
`MAX_CATCH_UP` from `src/net/room_config.js` instead. Nothing else in `room.js` changes.
Line numbers quoted below are `master`'s; after #82 everything from `var CHECKSUM_TICKS`
down shifts up by about five lines. Anchor on the quoted code, not the numbers. None of the
three edits touches the declaration, the import or `MAX_CATCH_UP` itself.

---

## 1. What the code does today

### The shape of a `Room`

`Room(transport, read_input)` (`src/net/room.js:21`) owns four pieces of per-match state and
one high-water stamp:

```js
src/net/room.js:24-39
    var tick = 0;
    var held = [];
    var drivers = [];
    var input_at = {}; // tick -> { seat: frame }
    var drivers_at = {}; // tick -> [ driver message ]
    ...
    var catching_up = false;
    var catch_up_to = 0;
    ...
    var newest = 0;
```

and a match flag:

```js
src/net/room.js:54
    var in_match = false;
```

`in_match` is set true by the `start` case (`room.js:109`) and false by `match_end`
(`room.js:150`). Today it is read in exactly one place — the stats reset at `room.js:108`.

### Bug A — the high-water stamp is never reset

`newest` is written in one place only:

```js
src/net/room.js:156-160
    function schedule_input(t, seats) {
        if (t > newest) newest = t;
        var frames = (input_at[t] = input_at[t] || {});
        for (var seat in seats) frames[seat] = seats[seat];
    }
```

and read in one place only:

```js
src/net/room.js:171-181
    // Where a replay has to end: as far as the relay said, or as far as the frames that have
    // arrived since say, whichever is further on.
    function target() {
        return Math.max(catch_up_to, newest - self.d);
    }

    // How many ticks of history this `start` is asking to be replayed. Zero for one that
    // begins a match at tick 0.
    this.gap = function () {
        return target() - tick;
    };
```

`schedule_input` is reached from three callers: the `input` case (`room.js:144`), the
`msg.inputs` replay inside `start` (`room.js:113-115`), and this client's own stamp in
`step` (`room.js:262`). Over a 3600-tick match `newest` therefore climbs to roughly
`tick + d`.

The `start` case resets everything else and leaves it standing:

```js
src/net/room.js:92-110
            case "start":
                // Zero when a match begins, the snapshot's own tick when this is a
                // mid-match join or a resync: the match is already running, and the state
                // that arrives with it belongs to a tick somewhere in the middle (#40).
                tick = msg.t | 0;
                input_at = {};
                drivers_at = {};
                ...
                in_match = true;
                catch_up_to = Math.max(tick, msg.until == null ? tick : msg.until | 0);
```

So a second `start` on a live `Room` opens at `tick = 0` with `newest ≈ 3600`, and
`gap()` returns thousands. `Game.pump` reads that number:

```js
src/game/game.js:141-144
            if (room.gap() > 0) {
                next_time = now + 1000 / 60;
                continue;
            }
```

— the sprint branch: the loop never yields and never draws until the gap closes, so the
client steps the whole of match 2 synchronously. Each of those steps sends a frame
(`room.js:263`), and the relay raises the room's clock off whatever it is handed:

```js
server/index.js:1102
            room.tick = Math.max(room.tick, msg.t + 1);
```

which the relay fans out, dragging every other client's `newest` up with it. That is the
"flood stamped 2…2700" in the issue.

**The two live paths that keep a `Room` across a `start`.**

1. *The end-of-match freeze.* `Game_Session` is not torn down at `match_end`; the walk to
   the lobby is a two-second timer, and the session builder cancels it when a `start`
   lands. The comment the issue points at is in `session()` in `viewmodels.js`:

   ```js
   src/interaction/viewmodels.js:600-608
           game.on_match_start = function () {
               ...
               // A match beginning outranks the last one's frozen frame: the hold must not
               // walk this client out of the match it just started.
               clearTimeout(leaving);
               leaving = null;
   ```

   `leaving` is the `HOLD_MS = 2000` timer set by `to_lobby_soon()`
   (`viewmodels.js:483-493`). Until it fires, `self.current_game()` is still the same
   `Game_Session`, holding the same `Room`, and `room.on_start`
   (`game_session.js:158-192`) rebuilds the simulation *in place* — it pauses the old
   `Game`, mutes the old `Sound_Player` and calls `build(level)`. The `Room` is never
   reconstructed.

2. *The reconnect / resync.* `Game_Session.resume()` → `room.request_resume()`
   (`game_session.js:321-323`, `room.js:203-205`) asks the relay for the match in
   progress, and the relay answers with a `start` carrying a snapshot
   (`server/index.js:772-828`). Same `Room`, second `start`. Same for a relay-initiated
   repair (`server/index.js:desync` → `resume`).

**Is resetting `newest` in `start` sufficient?** Yes. `target()` is the only reader, and
`schedule_input` the only writer. Placed inside the `start` case *before* the
`msg.inputs` replay at `room.js:113`, the reset is the last word for a begin-start and the
floor for a resume-start (the payload's own frames legitimately raise it again). The one
residual is a match-1 `input` message arriving *after* match 2's `start` — the bound at
`room.js:134` only rejects a stamp more than `MAX_CATCH_UP` ahead, so a stale 2700 would
get through. It cannot happen in practice: the relay stops fanning out the moment
`room.started` is false (`server/index.js:stamp_input`), `begin` sets the new match up
before broadcasting `start` (`server/index.js:928-1000`), and a WebSocket delivers in
order. Not worth code. See §5.

### Bug B — catch-up steps past the end of the match

```js
src/net/room.js:183-190
    // Replays the gap, one `step` per tick, up to the tick the relay said the room's
    // fastest client is about to step: this client lands where everybody else is playing
    // from rather than a delay ahead of them (#40).
    this.catch_up = function (step) {
        catching_up = true;
        while (tick < target()) step();
        catching_up = false;
    };
```

One caller, and it is synchronous inside a rebuild:

```js
src/interaction/game_session.js:280-289
        if (resumed) {
            var t2 = performance.now();
            unpack_snapshot(resumed, rnd, objects);
            ...
            room.catch_up(game.step);
```

`step` is `game_iteration`, which tests the match limits at the end of every tick:

```js
src/game/game.js:116-123
        var reason = ended ? null : limit_reached();
        if (reason) {
            ended = true;
            ...
            self.pause();
            if (self.on_end) self.on_end(reason);
        }
```

`ended` is the latching flag, and it is what `Game.start` refuses on:

```js
src/game/game.js:159-163
    this.start = function () {
        // Already pumping: a second loop would step the same simulation twice a frame,
        // and every way into the match calls this. A match that reached its limit is over
        // for good -- restarting it would step past the tick the room ended on (#39).
        if (playing || ended) return;
```

**The frozen-session path, end to end.** `room.on_start` fetches the level asynchronously
(`game_session.js:189-191`). A `match_end` can land during that fetch: `Room` sets
`in_match = false` (`room.js:150`), `viewmodels` stores the reason and calls
`to_lobby_soon()`, which — this client being on `#play` — arms the two-second hold rather
than routing immediately. Then the level resolves, `build(level)` runs, and
`room.catch_up(game.step)` replays a match that is already over, past the tick the limit
fell on. `ended` latches. `build` then calls `self.on_match_start()`
(`game_session.js:293`), which *cancels the hold* (`viewmodels.js:605-608`) and routes to
`#play`, where:

```js
src/interaction/viewmodels.js:929-932
        if (route.screen === "play") {
            if (!self.current_game()) return go("room", true);
            self.current_game().start();
        }
```

`Game_Session.start()` → `play()` → `game.start()` → returns on `ended`. No pump, no board,
no further `match_end` to come (it was consumed). Permanently frozen on the match screen.

**So "catch-up stops at the end of the match" is not a condition in the loop and not an
early return — it belongs in `target()`.** Two reasons:

- `in_match` cannot change *during* the loop: JavaScript is single-threaded and `catch_up`
  is synchronous, so "check before" and "check each iteration" are the same check. What
  matters is that it is checked at all.
- The same number drives the sprint. Guarding only the `while` leaves `gap()` returning
  thousands, so `play()` → `game.start()` → `pump()` takes the `room.gap() > 0` branch and
  steps the identical ticks the identical way, tripping the identical flag. One guard in
  `target()` covers `catch_up`, `gap()`, the pump, `build`'s `gap > MAX_CATCH_UP` bail
  (`game_session.js:252-253`) and the "reconnecting" indicator (`game_session.js:343`) at
  once. That is the root-cause placement: every caller routes through it.

**How the flag stops latching.** `Room` never touches `ended`; it stops feeding it. With
`target()` collapsing to `tick` once the match is over, no tick of a finished match is
stepped — not by catch-up, not by the sprint — so `limit_reached()` is never reached on a
session whose match the relay already ended, `ended` stays false, and
`Game_Session.start()` works. `ended` still latches when *this* client's simulation reaches
the limit while playing, which is correct and untouched.

### Bug C — a driver change for a passed tick leaks and is lost

Two writers into `drivers_at`:

```js
src/net/room.js:116-122
                // And the driver changes stamped for a tick this client has not reached:
                // wiped with `drivers_at` above, so the payload hands them back rather
                // than leaving this client the only one in the room that never applies
                // them (#7, #40).
                (msg.changes || []).forEach(function (change) {
                    (drivers_at[change.t] = drivers_at[change.t] || []).push(change);
                });
```

```js
src/net/room.js:146-148
            case "driver":
                (drivers_at[msg.t] = drivers_at[msg.t] || []).push(msg);
                break;
```

One reader, and it collects exactly one key:

```js
src/net/room.js:248-252
    this.step = function () {
        (drivers_at[tick] || []).forEach(function (change) {
            drivers[change.seat] = change.driver;
        });
        delete drivers_at[tick];
```

`tick` only ever advances through `step`, which deletes `drivers_at[tick]` as it goes. So
an entry whose key is `< tick` at the moment it is written is never read and never
deleted: it sits in the object for the rest of the match, and its change is lost.

The relay stamps at `room.tick + 2 * room.d` (`server/index.js:639-640`), which is ahead of
every healthy client — but a client that sprinted (bug A), a backgrounded tab catching back
up, or a client mid-replay can be past it by the time the message is delivered.

**What is lost matters to the simulation, not just to bookkeeping.** `drivers` decides
which seats get a substitute frame:

```js
src/net/room.js:285-294
        drivers.forEach(function (driver, seat) {
            if (driver !== "local" || frames[seat]) return;
            frames[seat] = RELEASED;
```

and the presence of a frame is what decides human-versus-AI in the simulation:

```js
src/game/game.js:60-67
    function update_player_actions() {
        var frames = room.step();
        for (var i = 0; i != player.length; ++i) {
            var frame = frames[i];
            player[i].ai = !frame;
```

A client that missed a `seat → ai` change puts a released frame in for a seat every other
client lets the AI steer. That is a divergence per tick, forever.

**Apply or discard? Apply.** The driver map exists to make a change land on *the same tick
on every client* (`room.js:245-247`, #7). A change for a passed tick cannot do that, so
neither option is free, but they are not symmetric:

- *Discard* leaves the client's driver table permanently wrong. It keeps reading a keyboard
  for a seat it no longer holds, keeps sending frames the relay drops as forged
  (`server/index.js` input case), and keeps simulating a different match every tick until
  something else replaces its state. The issue names this outcome as the harm: "the client
  keeps driving a seat the room has already given to the AI".
- *Apply late* is wrong only for the ticks between the stamped tick and now — ticks the
  client already had the wrong table for, so nothing new is broken — and it **converges**.
  The checksum path (#41) is what cleans up the state those ticks left behind, and the
  resync `start` it summons carries the whole `drivers` table
  (`server/index.js:797-822`).

Converging beats permanently wrong. Apply.

**AC5 is the same fix, not a second one.** Today `step` already collects `drivers_at[tick]`
for every tick it passes, so the *only* entry that can leak is one written for a tick
already stepped. Refuse to write those and every key in the map satisfies `t >= tick` at
write time and is deleted by the `step` that reaches it. The map's size is then bounded by
the relay's stamp lookahead (`2 * d` ticks × 4 seats — single digits), plus whatever is
left when a match ends, which the next `start` wipes at `room.js:98`. No extra code. See
§5.

---

## 2. The change, criterion by criterion

### AC1 + AC2 — a second match on a live `Room` opens with a gap of zero

**File** `src/net/room.js` · **function** the `transport.receive` handler, `case "start"`.

Current:

```js
            case "start":
                // Zero when a match begins, the snapshot's own tick when this is a
                // mid-match join or a resync: the match is already running, and the state
                // that arrives with it belongs to a tick somewhere in the middle (#40).
                tick = msg.t | 0;
                input_at = {};
                drivers_at = {};
```

Replace with:

```js
            case "start":
                // Zero when a match begins, the snapshot's own tick when this is a
                // mid-match join or a resync: the match is already running, and the state
                // that arrives with it belongs to a tick somewhere in the middle (#40).
                tick = msg.t | 0;
                input_at = {};
                drivers_at = {};
                // With them, because it is per-match state exactly as they are. Two paths
                // keep a `Room` alive across a `start` -- a client still on the match
                // screen inside the two-second end-of-match freeze when the host starts the
                // next one, and one that reconnects into a room as a match begins -- and
                // match 1's mark left standing opens match 2 at tick 0 with a gap of
                // thousands: the loop takes its catch-up branch, steps the whole match
                // synchronously without drawing, and floods out frames that drag every
                // other client's mark up after it (#84, #51). Before the payload's own
                // frames are scheduled below, which are what may raise it again.
                newest = tick;
```

`tick` rather than `0`: on a resume-start the room really is at `msg.t`, and the frames the
payload carries raise it from there.

That is the whole of AC1 and AC2. AC2's client is in the freeze path described in §1; it
receives the same `start` as everybody else and now opens on `msg.t` with `gap() === 0`.

### AC3 — catch-up stops at the end of the match

**File** `src/net/room.js` · **function** `target()`.

Current:

```js
    // Where a replay has to end: as far as the relay said, or as far as the frames that have
    // arrived since say, whichever is further on.
    function target() {
        return Math.max(catch_up_to, newest - self.d);
    }
```

Replace with:

```js
    // Where a replay has to end: as far as the relay said, or as far as the frames that have
    // arrived since say, whichever is further on. A match that is over has nowhere to replay
    // to: a `match_end` lands while a joining client is still fetching the level, and the
    // ticks past the one the room ended on trip the simulation's own end-of-match flag --
    // which latches, so `Game.start` no-ops from then on and the session never pumps again
    // (#84, #39). Here rather than in `catch_up`, because `pump` sprints on `gap()` and
    // would step those same ticks the same way.
    function target() {
        if (!in_match) return tick;
        return Math.max(catch_up_to, newest - self.d);
    }
```

`catch_up` and `gap()` are left exactly as they are; the loop condition re-reads `target()`
each iteration, so it inherits the guard for free.

### AC4 + AC5 — a passed-tick driver change is applied, and the map stays bounded

**File** `src/net/room.js` · **new function** `stamp_driver`, beside `schedule_input`.

Add after `schedule_input` (`room.js:156-160`):

```js
    // A change stamped for a tick this client has already stepped is applied now rather
    // than stamped: `step` collects only the tick it is on, so an entry for a passed tick
    // is a change nobody ever applies and an entry nobody ever deletes. Both halves are the
    // same wrong -- the room has handed this seat over, and this is the one client still
    // driving it, reading a keyboard for it and putting a released frame in for it every
    // tick while everybody else lets the AI steer (#7, #84). Refusing to write those keys
    // is also what bounds the map: every other one is deleted by the `step` that reaches
    // it, so what is left is the relay's stamp lookahead and nothing more.
    //
    // ponytail: applied late is still a divergence for the ticks it was late by -- this
    // client had the wrong driver table for them and simulated a different match on it. It
    // converges, which discarding does not. upgrade path: none short of the resync payload,
    // which carries the whole table and is what the checksums already summon (#41).
    function stamp_driver(change) {
        var t = change.t | 0;
        if (t < tick) drivers[change.seat] = change.driver;
        else (drivers_at[t] = drivers_at[t] || []).push(change);
    }
```

Route both writers through it. The `start` case:

```js
                // And the driver changes stamped for a tick this client has not reached:
                // wiped with `drivers_at` above, so the payload hands them back rather
                // than leaving this client the only one in the room that never applies
                // them (#7, #40).
                (msg.changes || []).forEach(stamp_driver);
```

and the `driver` case:

```js
            case "driver":
                stamp_driver(msg);
                break;
```

`step` (`room.js:248-252`) is **not** touched: `< tick` at write time is the whole of it,
because `tick` only ever advances inside `step`, which deletes the key it just applied.

The `| 0` on the key is deliberate: it makes the comparison and the map key agree on one
value, the way the `input` case already normalises `msg.t` (`room.js:134`).

`forEach(stamp_driver)` passes the index and the array as extra arguments; the helper takes
one parameter and ignores them.

---

## 3. Tests

**All three go in `test/replay.test.mjs`.** Justification from how the two files are
written:

- `replay.test.mjs` already constructs `Room` directly against stub transports and asserts
  on exactly this surface: `room.gap()` (`the room is 38 ticks past…`), `room.catch_up`,
  `room.set_driver` mid-match, `room.stats()`, `room.end_match` / `on_match_end`, and
  `room.now()`. It is headless, synchronous and has no server to boot. `Loopback_Transport`
  answers a `start` by echoing one back on the spot (`loopback_transport.js:33-53`) and
  echoes a `match_end` (`:62-66`), so it **can** drive a second `start` on a live `Room`
  and an end-of-match, in two lines, with no await.
- `relay.test.mjs` boots the real relay on a real socket because "the protocol is the thing
  under test". None of these three bugs has a protocol surface: the relay's `begin` already
  resets its own half correctly (`server/index.js:928-950`), and what is wrong is a
  client-side variable. Driving a second match through it would mean seats, a ready gate, a
  countdown and a pile of `await`s to observe `room.gap()`. Wrong file.

**Placement.** Immediately after the `absurd` block (the `a frame stamped past anything this
client could replay is dropped` assertion) and before `let ended = null;`. That region is
`Room`-only. All three cases use a bare `new Room(...)` rather than the file's `start()`
helper, so no `Game` is built and the file's standing hazard — "Last, because building a
`Game` replaces the `player` array" — does not apply.

```js
// --- one Room, two matches (#84) ------------------------------------------------------
//
// A `Room` normally dies with its match: the end routes to the lobby, which tears the
// session down and builds a fresh one. Two paths keep one alive across a `start` -- a
// client still on the match screen inside the two-second end-of-match freeze when the host
// starts the next match, and one that reconnects into a room as a match begins -- so every
// counter a match owns has to be reset by `start` and not merely by construction.
const no_keys = () => ({ left: false, right: false, up: false });

const reused = new Room(new Loopback_Transport(), no_keys);
reused.start({ seed: 1, settings: {}, held: [0] });
for (let tick = 0; tick < 300; tick++) reused.step();
assert.ok(reused.gap() <= 0, "a client alone in its room is never behind it");
reused.start({ seed: 2, settings: {}, held: [0] });
assert.equal(reused.now(), 0, "a second match on a live room opens at tick 0");
assert.equal(
    reused.gap(),
    0,
    "and with no gap: the newest tick match 1 stamped is not match 2's (#84)",
);

// Catch-up replays a gap; it does not replay a match that is over. A `match_end` lands
// while a joining client is still fetching the level, and the ticks past the end are the
// ones that trip the simulation's end-of-match flag -- which latches, leaving a session
// that never pumps again.
const ending_transport = behind_transport(40);
const ending = new Room(ending_transport, no_keys);
ending.start({ seed: 1, settings: {}, held: [0] });
assert.equal(ending.gap(), 38, "a client 38 ticks behind the match it is in");
ending_transport.deliver({ type: "match_end", reason: "time", matrix: [] });
assert.equal(ending.gap(), 0, "and behind nothing at all once that match is over");
let replayed = 0;
ending.catch_up(() => replayed++);
assert.equal(replayed, 0, "so the replay stops at the end of the match, not past it");

// A driver change stamped for a tick this client has already stepped. That tick never comes
// round again, so holding it in the map loses the change and leaks the entry: the seat the
// room gave the AI goes on being driven by the one client that never heard (#7, #84).
const late_transport = {
    receive(fn) {
        this.deliver = fn;
    },
    send() {},
};
const late = new Room(late_transport, no_keys);
late_transport.deliver({
    type: "start",
    t: 0,
    d: 0,
    seed: 1,
    settings: {},
    held: [0],
    drivers: ["local", "local", "ai", "ai"],
});
for (let tick = 0; tick < 10; tick++) late.step();
late_transport.deliver({ type: "driver", t: 3, seat: 1, driver: "ai" });
assert.equal(
    late.step()[1],
    undefined,
    "a seat the room handed the AI seven ticks ago is the AI's here too, not a released frame",
);
```

Why each one fails today:

| case | today | with the fix |
| --- | --- | --- |
| `reused.gap()` after the second `start` | `299` (`newest` from match 1) | `0` |
| `ending.catch_up` step count | `38` — replays a finished match | `0` |
| `late.step()[1]` | `{left:false,…}` — driver still `"local"` | `undefined` — the AI's |

`behind_transport` is already defined above the insertion point and is reused as-is.
`no_keys` is the `read_input` callback; none of the three cases reads a keyboard.

The existing `local.room.set_driver(2, "ai")` block a little further down is the boundary
regression guard for edit 3: the loopback stamps at `current_tick + 2d` with `d = 0`, which
is the tick the room is *on* and not one it has passed, so it must still apply on the next
step. `< tick` and not `<= tick` is what keeps it passing.

**AC5 has no assertion of its own.** `drivers_at` is private and there is no accessor;
adding one so a test can count keys is the kind of thing this repo does not do. The
boundedness is structural and is argued in §1 and stated in the code comment. Flagged in §5.

---

## 4. Risks

**Determinism (`test/replay.test.mjs` must still pass).** `src/net/` runs headless beside
the simulation and the suite hashes the simulation field by field. None of the three edits
changes what `step()` returns for a tick of a healthy match:

- `newest` is not read by `step`; only by `target()`.
- `target()` is not read by `step`; only by `gap()` and `catch_up`.
- `stamp_driver` changes behaviour only for `t < tick`, which the existing tests never
  produce (the loopback stamps at `current_tick`, which is the tick the room is on).

Checked against every existing assertion that reads these numbers:

- `behind.room.gap() === 38` — a fresh `Room`, `newest` set by `input` messages delivered
  *after* the `start` handler has returned. Unchanged.
- the joiner's `catch_up` to `HALF * 2` and then to `HALF * 2 + 30` — `newest` is raised by
  the `msg.inputs` replay, which runs *after* the reset in the same handler, and by later
  `input` messages. `in_match` is true throughout. Unchanged.
- `absurd.room.gap() <= 0` — fresh room, in match. Unchanged.
- `local.room.set_driver(2, "ai")` — stamped for the current tick, not a passed one.
  Unchanged.
- `local.room.end_match(...)` sets `in_match = false` through the loopback echo, but
  nothing reads `local.room.gap()` after it.

The one way to get edit 1 wrong is to put `newest = tick;` *after* the `msg.inputs` replay
at `room.js:113-115`. That wipes the frames a resume-start is replaying towards, collapsing
`target()` to `until` and landing the joiner short of the room. Place it with `input_at` and
`drivers_at`.

The one genuine determinism trade is bug C, argued in §1: applying a passed-tick change late
means this client's driver table differs from the room's for the ticks it was late by. It is
a *converging* divergence, and the ticks behind it are the checksum path's (#41) — which is
the same machinery that would otherwise have to clean up after the permanent divergence
discarding leaves. Marked with the `ponytail:` comment in edit 3. That is the one place in
this change warranting one.

**The relay's view of a client that now behaves differently.** Strictly quieter, and no
relay edit:

- The frozen-freeze client used to flood thousands of frames stamped 2…2700 into
  `stamp_input`, which raises `room.tick` off any stamp it is handed
  (`server/index.js:1102`) and therefore `room.due`, after which every *other* client's real
  frames miss the deadline and are dropped and counted late
  (`server/index.js:1094-1096`). It now stamps `tick + d` like everybody else.
- A client whose catch-up now stops sends nothing new: `catching_up` already suppresses
  both the input frame and the checksum (`room.js:254-271`), so the relay sees no frames for
  a replay either way. Afterwards the match is over and `stamp_input` returns on
  `!room.started` regardless.
- `set_driver` and the wire format of a `driver` message are untouched.

**The browser suite.** `test/browser.test.mjs` walks the flow through a real Chromium and
touches none of this directly — it sends one `match_end` (`:715`) and never reads `gap()`.
Its match-ends-by-itself walk fast-forwards the one-minute limit on a local room over
`Loopback_Transport`, where `d = 0` and `newest === tick - 1` throughout, so edit 1 is a
no-op there and edit 2 only fires after the `match_end` echo, by which point the page is
already routing to the lobby. No expected change. Run the whole of `npm test` (it builds
first, and `npx playwright install chromium` is needed once).

**Formatting.** Prettier is pinned exact and `.githooks/pre-commit` checks the whole tree:
`npm run format` before committing.

---

## 5. Deliberately not doing

- **No separate code for AC5.** Refusing to write a passed-tick key is what bounds the map;
  every other key is deleted by the `step` that reaches it. Flagged rather than dropped: if
  a reviewer wants AC5 ticked by its own edit, say so — but a sweep in `step` would be the
  same behaviour for more lines.
- **No test asserting the map's size.** `drivers_at` is private and exposing it to count
  keys is more surface than the bug.
- **Not bounding `msg.t` on a `driver` message** the way #80 bounds it on an `input`. Only
  the relay stamps driver ticks, and a relay that lies is a different issue.
- **Not guarding against a match-1 `input` arriving after match-2's `start`.** Ordered
  delivery and `room.started` already rule it out; a guard would be dead code.
- **Not clamping `tick` forward when catch-up stops early.** The `Room` is left where the
  match really ended, which is the honest number, and the next `start` resets both ends of
  the comparison anyway.
- **Not touching `game_session.js` or `viewmodels.js`.** In particular **not**
  `on_match_start`'s `clearTimeout(leaving)` (`viewmodels.js:605-608`), which cancels the
  walk to the lobby for a *resume* build as readily as for a new match — so a client
  resumed into a match that has already ended loses its board even with this issue fixed.
  That is a fourth bug in a different layer; **flagging it for its own issue**, not widening
  this one. AC3's "reaches the board" is met here in the sense that matters — the session is
  no longer frozen and plays the next match — but the board itself depends on that separate
  fix in the one ordering where `match_end` beats the level fetch.
- **No relay change.** Every one of the three is client-side `Room` state.
