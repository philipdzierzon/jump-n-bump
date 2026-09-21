# Plan — #82 The relay accepts four message types from any client without checking who sent them

Worktree: `/Users/philipdzierzon/Documents/sbx/jumpnbump/jump-n-bump/.claude/worktrees/82`
(branch `82-relay-message-authorisation`). All paths below are relative to it.

Four files change: `src/net/room_config.js`, `src/net/room.js`,
`src/interaction/game_session.js`, `server/index.js`, plus `test/relay.test.mjs`.
Net new logic: five guards and one helper. Nothing is added that the criteria do not name.

---

## 1. What the code does today

### The message path

`server/index.js:1223` — every socket message is JSON-parsed, then an **outer** switch
(`server/index.js:1232`) handles the four pre-room types and routes everything else into
`relay()`:

```js
            switch (msg.type) {
                case "pong":
                    client.one_way = (Date.now() - msg.at) / 2;      // :1233-1234
                    break;
                case "create": ...
                case "join": ...
                case "quick": ...
                default:
                    if (client.room) relay(client, msg);             // :1245-1246
            }
```

`relay()` (`server/index.js:1055-1165`) is the **inner** switch. What it checks today:

| case | line | check |
| --- | --- | --- |
| `start` | 1058 | `if (!client.host) return;` |
| `ready` | 1074 | none needed — it is the client's own flag |
| `cancel` | 1082 | `if (!client.host \|\| !room.timer) return;` |
| `input` | 1087 | integer `t >= 0`, not queued, `t >= room.due`, per-seat ownership |
| `seats` / `take` / `leave` | 1128-1138 | validated inside `take_seats` / `claim_seat` / `vacate` |
| **`driver`** | **1139** | **none** — `stamp_driver(room, msg.seat, msg.driver)` straight through |
| `snapshot` | 1142 | `keep_snapshot` checks host, started, `t`, body length, matrix shape |
| `checksum` | 1145 | `keep_checksum` checks started and integers |
| `resync` | 1148 | none needed — `resume()` re-derives everything from the room |
| `config` | 1154 | `host_config` checks `client.host` |
| **`match_end`** | **1157** | **none** — `to_lobby(room, msg)` straight through |
| *(no `default`)* | 1164 | an unknown type falls off the end in silence |

### The four holes, traced

**2.1 `input`'s missing upper bound.** `server/index.js:1087-1126`:

```js
        case "input": {
            if (!Number.isInteger(msg.t) || msg.t < 0) return;          // :1088  lower bound only
            if (client.queued.length) return;                            // :1092
            if (msg.t < room.due) return void room.late++;               // :1097
            room.tick = Math.max(room.tick, msg.t + 1);                  // :1102  <-- raised to anything
            ...
            substitute(room);                                            // :1125
```

`substitute()` (`server/index.js:688-732`) then runs
`const limit = room.tick - room.d - 1; while (room.due <= limit) { ... }`, and inside the
loop calls `driver_at()` (`:664`, a linear scan of `room.stamped`) and `holder_of()`
(`:655`, a scan of `room.clients`) **per seat per tick**, plus a `broadcast_frame` per
iteration. `room.tick = 1e9 + 1` is therefore ~1e9 iterations on the single Node process,
inside one event-loop turn: every room on the relay freezes, not just the sender's. The
client-side half of this bound shipped in #80 and lives at `src/net/room.js:134`
(`if ((msg.t | 0) - tick > MAX_CATCH_UP) break;`), which is why the symptom is room-side
tick poisoning rather than a visible desync.

**2.2 `driver` is unauthenticated.** `server/index.js:1139-1141` hands `msg.seat` and
`msg.driver` to `stamp_driver` (`:639-651`) unexamined. `stamp_driver` writes
`room.drivers[seat] = driver` (`:649`), pushes to `room.stamped` (`:645`), broadcasts, and —
for `"local"` — clears `room.missing[seat] = 0` (`:643`), which is the AI-takeover counter
`substitute()` increments at `:716`. So a peer can (a) hand another player's bunny to the
AI mid-match, (b) permanently disable AI takeover for a seat whose holder has really gone,
(c) write the driver table at an arbitrary property (`seat: "toString"`), (d) set a driver
value nothing in the room understands. The legitimate senders are `Room.set_driver`
(`src/net/room.js:207`), called only from `Room.release` (`:235`) over the client's **own**
`held` seats with `"ai"` — so an ownership check breaks no real client.

**2.3 `match_end` is unauthenticated.** `server/index.js:1157-1163` calls `to_lobby(room, msg)`,
which ends the match for the room and re-broadcasts the message verbatim (`:361-367`) —
final board included. The comment above it already says the board is relayed "exactly as the
host sent it"; host-only was the intent, the check is simply absent.

**2.4 malformed `pong` → `NaN` delay for the match.** `server/index.js:1234` sets
`client.one_way = (Date.now() - msg.at) / 2` with no finite guard. `input_delay()`
(`:626-634`) does `worst = Math.max(worst, client.one_way)` then
`Math.min(10, Math.max(2, Math.ceil(worst / TICK_MS) + 1))` — and `Math.max(2, NaN)` is
`NaN`, `Math.min(10, NaN)` is `NaN`. `begin()` fixes `room.d = input_delay(room)` once
(`:934`) for the whole match. Consequences: `substitute()`'s
`limit = room.tick - room.d - 1` is `NaN`, so `while (room.due <= limit)` never holds and
**no frame is ever substituted for the whole match**; and `d` serialises as `null` on
`start` (`:991`), so every client stamps with zero delay. Unplayable until the room is remade.

### The two siblings

**Password type asymmetry.** Three sites, two coercions, one `!==`:

```js
server/index.js:115    password: msg.password || null,                       // create: no coercion
server/index.js:190    if (!room || room.password !== (msg.password || null)) // join: no coercion
server/index.js:1035   if ("password" in msg) room.password = String(msg.password) || null;  // config
```

`create` with `password: 1234` stores the number `1234`; a join with `"1234"` compares
`1234 !== "1234"` → `ROOM_UNAVAILABLE`, for everyone including the host. `create` with
`password: {}` stores `{}` and nothing can ever equal it. The room is permanently unjoinable
and there is no way to fix it (`config` is host-only, and the host cannot get in).

**No `default` on the relay switch** (`server/index.js:1164`): an unknown type is dropped
with no trace at all.

### Where the shared constants are today

- `src/net/room.js:3-8` — the comment plus `export var MAX_CATCH_UP = 3600;`. Consumers:
  `src/net/room.js:134` and `src/interaction/game_session.js:19,253`. The relay has no
  equivalent.
- The driver values `"local"` / `"ai"` / `"off"` exist only as string literals:
  `src/net/room.js:235,242`, `src/net/loopback_transport.js:50`, `server/index.js:980,643,694,794,1113`
  region, `test/replay.test.mjs:349`, `test/relay.test.mjs:579`. There is no list anywhere.
- `server/index.js:19` already imports from `src/net/room_config.js`, and
  `test/relay.test.mjs:1270-1271` asserts only that the relay imports nothing from
  `../src/game/` — `src/net/` is fine.

### The stale comment

`server/index.js:72-77`, inside the `repair_reset_ms` comment block:

```js
// The premise #41 was written on -- that the relay substitutes a missing frame, so every
// client plays the same input stream and a desync can only be a determinism bug -- is not
// true yet: #17's substitution is #42's to build. Until it is, a client whose frames arrive
// later than `d` diverges continuously, and no number of repairs fixes that (#68).
//
```

Substitution shipped: `substitute()` at `:688` is called from the `input` case at `:1125`,
and `test/relay.test.mjs:1069-1100` proves it. The paragraph is false.

---

## 2. The change, criterion by criterion

### AC5 (first, because two others depend on it) — the ceiling and the driver list, defined once

**File: `src/net/room_config.js`.** Add to the header paragraph (after the line ending
`...and the relay broadcasts (#8).`, i.e. after `src/net/room_config.js:11`):

```js
// Two constants that are not settings live here for the same reason: the catch-up ceiling
// and the list of drivers are numbers the client and the relay have to agree on, and one
// definition is what stops them disagreeing (#82).
```

Append after `LIMITS` (`src/net/room_config.js:50`), keeping the comment that is moved off
`src/net/room.js:3-7` and extending it with the relay's half:

```js
// The most ticks a client may be asked, or may ask a room, to catch up by. A minute of them
// costs a few hundred milliseconds to replay; more than that is a host that stopped
// snapshotting rather than a gap worth closing, and a client that replayed it would land
// minutes behind the room and consume every frame late (#51). A gap this size is a match not
// joined, not one joined short: the caller checks `gap()` and stays in the lobby (#40).
//
// Both halves of one ceiling: the client drops a frame stamped further ahead than this
// (#80), and the relay refuses to raise the room's clock to one in the first place (#82).
export var MAX_CATCH_UP = 3600;

// Who may be driving a seat: the client holding it, the AI, or nobody at all when the room
// disabled it (#7, #37). An allowlist like `LEVELS` -- it is what stops a peer writing
// something the room has never heard of into the relay's driver table (#82).
export var DRIVERS = ["local", "ai", "off"];
```

**File: `src/net/room.js`.** Delete lines 3-8 (the comment and the `export var`) and add a
first line above `var RELEASED = ...` (the file has no imports today):

```js
import { MAX_CATCH_UP } from "./room_config.js";
```

`src/net/room.js:134` is unchanged and now reads the shared constant.

**File: `src/interaction/game_session.js:19`.** Replace

```js
import { MAX_CATCH_UP, Room } from "../net/room.js";
```

with

```js
import { MAX_CATCH_UP } from "../net/room_config.js";
import { Room } from "../net/room.js";
```

> Re-exporting from `room.js` would have saved this line, but a re-export is an indirection
> for nothing: two honest import lines cost the same and read as what they are.

**File: `server/index.js:19`.** Widen the existing import:

```js
import { DRIVERS, MAX_CATCH_UP, config_diff, default_config } from "../src/net/room_config.js";
```

### AC1 — an `input` too far ahead is rejected and does not advance the room's tick

**File: `server/index.js`, `relay()`, `case "input"`.** Insert immediately after the `late`
check (`server/index.js:1097`) and therefore before `room.tick = Math.max(...)` at `:1102`:

```js
            // And the other end of the same clock: a tick further ahead than any client
            // could catch up to is not a frame, it is a number. The line below raises the
            // room's tick to it, and `substitute` then walks every tick in between -- a
            // scan per seat per tick and a frame broadcast each -- which is the whole
            // process, and every room on it, for as long as the arithmetic takes (#80, #82).
            // ponytail: one frame may still legitimately push the room's clock a whole
            // minute ahead, which is 3600 substituted ticks in one turn of the event loop.
            // upgrade path: a bound of a few ticks past `room.tick + room.d`, if a client
            // whose clock raced ever turns out not to need the slack.
            if (msg.t - room.tick > MAX_CATCH_UP) return void room.forged++;
```

Counted as `forged` rather than dropped uncounted, exactly like `late` on the line above:
`server/index.js:156-158` promises that the silent drops are counted per room and read from
the match's log line, and a third silent drop with no counter would make that comment false.

### AC2 — `driver` is rejected unless the sender holds the seat and the driver is a known one

**File: `server/index.js`, `relay()`, `case "driver"` (`:1139-1141`).** Replace with:

```js
        case "driver":
            // A seat's driver is its holder's to change, exactly as its input is. The seat
            // has to be one this client holds -- which is also what makes it a seat index
            // rather than an arbitrary property to write the driver table at -- and the
            // value has to be one the room knows: `local` for a seat somebody else holds
            // clears that seat's missing-tick counter, which is AI takeover itself switched
            // off (#7, #42). Counted as forged and answered with nothing, like a forged
            // frame is (#82).
            if (!client.seats.includes(msg.seat) || !DRIVERS.includes(msg.driver))
                return void room.forged++;
            stamp_driver(room, msg.seat, msg.driver);
            break;
```

`client.seats` only ever holds integers `0..SEATS-1` (`seat_client` at `server/index.js:416`
slices `free_seats()`; `claim_seat` at `:474,490` pushes `msg.seat | 0` after a range check),
and `Array.prototype.includes` is strict about type — so `includes(msg.seat)` is
simultaneously the ownership check, the "is a seat index" check and the "is not an arbitrary
property" check. One expression, three criteria; no separate range test.

### AC3 — a `match_end` from a non-host is rejected

**File: `server/index.js`, `relay()`, `case "match_end"` (`:1157-1163`).** Add one line
before `to_lobby`, and extend the existing comment:

```js
        case "match_end":
            // The host's to announce, as the start was (#22, #37). It ends the match for
            // everybody and the board rides on it verbatim -- the relay cannot read the
            // simulation, so it could not compute one (#19) -- which is exactly why a peer
            // must not be able to send one: it would end everyone's match and dictate the
            // result. The client's board-shape guard bounds the shape, not the right (#82).
            if (!client.host) return;
            // The announcement is over with it, so an arrival is told about a room and not
            // about a match nobody is running.
            to_lobby(room, msg);
            break;
```

### AC4 — a non-finite `pong` is ignored; the delay is always a finite integer in its clamp

**File: `server/index.js`, the outer switch in `start_server` (`:1233-1235`).** Replace with:

```js
                case "pong":
                    // The only number a client sends before it is even in a room, and the
                    // one every room's input delay is derived from. `NaN` walks straight
                    // through `input_delay`'s clamp -- `Math.max(2, NaN)` is `NaN` -- and
                    // the delay is fixed for the match at `begin`, so one malformed pong
                    // stops substitution comparing at all and serialises as `null` on
                    // `start`, leaving every client stamping with no delay (#34, #82).
                    if (Number.isFinite(msg.at)) client.one_way = (Date.now() - msg.at) / 2;
                    break;
```

This single guard is the whole of AC4, second half included: `client.one_way` starts at `0`
(`server/index.js:1215`) and is now only ever assigned a finite number, so in `input_delay`
`worst` is finite, `Math.ceil(worst / TICK_MS) + 1` is an integer, and
`Math.min(10, Math.max(2, …))` puts it in `2..10` — a client claiming to be in the future
gives a negative `one_way` that loses to `worst`'s `0`, and one claiming 1970 gives a huge
one that `Math.min(10, …)` eats. **No second guard in `input_delay`**: it would be a check
for a value that can no longer reach it.

### AC6 — a room created with a non-string password is joinable with it

**File: `server/index.js`.** One coercion for all three sites, placed immediately above
`create` (`:107`):

```js
// The room's password, as it is stored and as every join is compared against it. One
// coercion for both sides, because the comparison is `!==`: a room created with something
// that is not a string could never be joined again -- by the host as much as by anybody --
// and the host's own config handler coerced while the create handler did not (#8, #82).
// Absent, empty or null is no password at all, which is also how a host clears one.
const password_of = (msg) => (msg.password == null ? null : String(msg.password) || null);
```

Then, three call sites:

- `server/index.js:115` → `password: password_of(msg),`
- `server/index.js:190` → `if (!room || room.password !== password_of(msg))`
- `server/index.js:1035` → `if ("password" in msg) room.password = password_of(msg);`

Coercing the join side as well as the create side is what makes the criterion's "joinable
with that password" literally true rather than true-only-for-a-string-retry; and it is the
root-cause shape — the bug is the *asymmetry*, so the fix belongs in the one thing all three
callers route through, not in `create` alone.

> Behaviour change to be aware of: `{ type: "config", password: null }` used to set the
> literal password `"null"` (`String(null)`), and now clears it. That is what a client
> sending `null` meant; no client sends it today (the field comes from a text input).

### AC7 — an unknown message type is handled explicitly

**File: `server/index.js`, end of the `relay()` switch (after `case "match_end"`, before the
closing brace at `:1164`):**

```js
        default:
            // A type this relay has no case for: a newer client against an older
            // deployment, or a bot. Dropped -- the relay answers nothing it did not
            // understand -- but said so once per client rather than once per message.
            // ponytail: the type itself is never logged and the second unknown type from
            // the same client is silent, because `msg.type` is unbounded client input and
            // nothing rate-limits an established socket (#47). upgrade path: log the type
            // once payload caps exist.
            if (!client.unknown_type) {
                client.unknown_type = true;
                console.log("room %s dropped a message type it does not know", room.id);
            }
```

### AC8 — tests

See §3.

### AC9 — the stale substitution comment

**File: `server/index.js`.** Delete lines 72-77 (the `The premise #41 was written on …`
paragraph and the bare `//` separator line that follows it), leaving the
`repair_reset_ms` comment as: the "quiet period" paragraph, then the existing
`// ponytail: a client that needs a repair just less often than this …` paragraph.

---

## 3. Tests — `test/relay.test.mjs`

One new section. Insert it immediately **before** the line

```js
// The relay runs no simulation of its own, and the cheapest way to keep it that way is to
```

(`test/relay.test.mjs:1268`). Everything it needs is already defined above that point:
`connect`, `lobby`, `awaited` (`:727`), `until_seen` (`:1029`), `two_seats` (`:1046`),
`pressed_key` (`:1065`). Add `MAX_CATCH_UP` to the existing `room_config` import at
`test/relay.test.mjs:8`:

```js
import { LEVELS, MAX_CATCH_UP, config_diff, default_config } from "../src/net/room_config.js";
```

Room ids must be five characters of `A-Z` minus `I` and `O` (`src/net/room_id.js:8`) and
unused elsewhere in the file: **`FRGZX`**, **`PNGXZ`**, **`PWDXZ`**. (`FORGE` and `PONGX`
contain an `O` and would be refused — a five-minute trap.)

```js
// --- message authorisation (#82) -------------------------------------------------------
//
// Four message types the relay used to take from any client without asking who sent them.
// It runs no simulation and cannot tell a legal input from a clever one (#6) -- but it does
// know which client holds which seat and which client is the host, and that is the whole of
// what these four needed.

const forged = await two_seats("FRGZX");

// A tick further ahead than any client could catch up to is not a frame. Unchecked it raised
// the room's clock to itself, and substitution then walked every tick in between -- a scan
// per seat per tick, a broadcast each -- which is the single process and every room on it.
forged.guest.socket.send({ type: "input", t: MAX_CATCH_UP + 1, seats: { 1: pressed_key } });
forged.guest.socket.send({ type: "input", t: 0, seats: { 1: pressed_key } });
const after_forged = await until_seen(
    forged.host_saw,
    (msg) => msg.type === "input" && msg.t === 0,
    "a frame for tick 0 after the forged one",
);
assert.deepEqual(
    after_forged.seats,
    { 1: pressed_key },
    "the room's clock stayed put, so the next real frame is not already past its deadline",
);
assert.ok(
    !forged.host_saw.some((msg) => msg.type === "input" && msg.t > MAX_CATCH_UP),
    "and the tick a minute past the room's was never fanned out",
);

// A seat's driver is its holder's to change: a peer that could set one handed another
// player's bunny to the AI mid-match, and `local` for a seat it did not hold cleared that
// seat's missing-tick counter -- AI takeover switched off for a holder who really has gone.
forged.guest.socket.send({ type: "driver", seat: 0, driver: "ai" });
forged.guest.socket.send({ type: "driver", seat: 1, driver: "pogostick" });
await new Promise((resolve) => setTimeout(resolve, 100));
assert.ok(
    !forged.host_saw.some((msg) => msg.type === "driver"),
    "neither another client's seat nor a driver the room has never heard of is stamped",
);
assert.deepEqual(
    forged.host_saw.filter((msg) => msg.type === "room").pop().labels,
    ["Steady", "Quiet", null, null],
    "and the board still says both bunnies are being driven by the clients holding them",
);

// The host announces the end and the final board rides on it verbatim, so a peer that could
// send one ended everyone's match and dictated the result (#19, #22).
forged.guest.socket.send({ type: "match_end", reason: "lobby", matrix: [[9, 9, 9, 9]] });
await new Promise((resolve) => setTimeout(resolve, 100));
assert.ok(
    !forged.host_saw.some((msg) => msg.type === "match_end"),
    "a match_end from a client that is not the host ends nothing",
);
assert.equal(
    forged.host_saw.filter((msg) => msg.type === "room").pop().started,
    true,
    "and the match it tried to end is still running",
);
forged.host.socket.close();
forged.guest.socket.close();

// The delay the whole match is played at is derived from the trips the relay measured and
// fixed at `begin`, so a pong it could not read used to fix it at `NaN`: no substitution for
// the match, and a `null` on the wire that leaves every client stamping with no delay.
const bent = connect({ type: "create", id: "PNGXZ" });
await lobby(bent);
await bent.seats(["Bent"]);
const bent_saw = [];
bent.socket.receive((msg) => bent_saw.push(msg));
bent.socket.send({ type: "pong", at: "in a bit" });
bent.socket.send({ type: "start", seed: 7, settings: {} });
const bent_start = await awaited(bent_saw, "start");
assert.ok(
    Number.isInteger(bent_start.d) && bent_start.d >= 2 && bent_start.d <= 10,
    "a pong the relay cannot read is ignored, and the delay stays a whole number in its clamp",
);
bent.socket.close();

// The password is compared with `!==`, so a room created with one that is not a string was
// permanently unjoinable -- by the host as much as by anybody (#8).
const numeric = connect({ type: "create", id: "PWDXZ", password: 1234 });
await lobby(numeric);
const digits = connect({ type: "join", id: "PWDXZ", password: 1234 });
assert.equal((await lobby(digits)).type, "joined", "a room created with a number is joinable");
const mistyped = connect({ type: "join", id: "PWDXZ", password: 9999 });
assert.equal((await lobby(mistyped)).code, "ROOM_UNAVAILABLE", "and by that number only");
digits.socket.close();
mistyped.socket.close();
numeric.socket.close();
```

Notes for the implementer:

- The forged-tick assertion is the one that proves "the tick is not advanced": without the
  fix the relay raises `room.tick` to 3602, `substitute()` runs `room.due` up to ~3599, and
  the following `t: 0` frame is then dropped as *late* — `until_seen` rejects after 2s with
  a readable message. Use `MAX_CATCH_UP + 1`, not `1e9`: a billion iterations would block
  the event loop and hang the suite (the relay is in the same process as the test) instead
  of failing it.
- No substitution can fire in `FRGZX` during this block — only two frames ever arrive and
  `room.tick - room.d - 1` stays negative — so the "no driver message at all" assertion is
  not racing an AI takeover.
- `two_seats` names its clients `Steady` (seat 0, host) and `Quiet` (seat 1), which is where
  the `labels` assertion's strings come from.
- The `pong` must be sent on the same socket immediately before `start`: messages are
  ordered, and the transport answers the relay's real ping every second
  (`src/net/websocket_transport.js:24-27`), which would otherwise overwrite `one_way` with
  a sane number before the match begins.
- No test for the `default` case. AC8 names four rejections and this is not one of them; a
  test asserting a log line would be testing the log.

Run: `node --no-warnings test/relay.test.mjs` from the worktree (needs the
`server/node_modules` symlink per `CLAUDE.md`), then `npx prettier --check .`.
`npm test` also runs `replay`, `router` and `browser`.

---

## 4. Risks / what this could break

- **`src/net/room.js` gains its first `import`.** It is loaded by `test/replay.test.mjs:16`,
  by webpack via `game_session.js`, and now pulls in `room_config.js`. That module is pure
  data and pure functions, no DOM, no clock, no randomness — `src/game/` still imports
  nothing from `src/interaction/`, and `test/replay.test.mjs`'s determinism is untouched.
  `room_config.js` is already in the browser bundle via `src/interaction/viewmodels.js:10`,
  so the bundle gains nothing.
- **`test/relay.test.mjs:1270-1271`** asserts only that `server/index.js` imports nothing
  from `../src/game/`. Importing two more names from `../src/net/room_config.js` is fine.
- **The existing driver test still passes.** `test/relay.test.mjs:296` sends
  `{ type: "driver", seat: 1, driver: "ai" }` from `other`, which holds seat 1 — it satisfies
  both halves of the new guard. Grepped every other sender: the only client-side producer is
  `Room.set_driver` (`src/net/room.js:207`), called only by `Room.release` (`:235`) over the
  caller's own `held` seats with `"ai"`. `src/interaction/game_session.js` never calls it
  directly. Server-side `stamp_driver` callers (`:426`, `:724`, `:794`) do not go through
  the switch and are unaffected.
- **The existing `match_end` tests still pass — checked, all three senders are hosts.**
  `test/relay.test.mjs:247` is `host_room.end_match` on `created`, which `:128` asserts is
  the host of `QMFTX`; `:439` is `gate`, whose `cancel` and `start` at `:416`/`:425` already
  only work for a host; `:910` is `chk_host`, the creator of its room. `:960` only *reads*
  for a `match_end`, it sends none.
- **Password coercion touches `join` and `quick_join`.** `quick_join` funnels into `create`
  (`:277`) and `best_room` only reads `!room.password` (`:253`), so listings and Quick Join
  are unaffected. The password tests at `:104-121` and `:588-606` use strings and are
  unchanged.
- **Cross-match stale frames.** `begin()` resets `room.tick = 0` (`:933`), so an in-flight
  frame from a previous match longer than a minute is now rejected by the new bound instead
  of poisoning the new match's clock — strictly better than today, but a behaviour change
  worth knowing.
- **A client whose clock genuinely races 3600 ticks ahead** loses that frame instead of
  dragging the room. That is the ceiling the shared constant names, and the client already
  drops the mirror-image frame (`src/net/room.js:134`).

---

## 5. Deliberately not doing

- **A separate seat-range check on `driver`.** `client.seats.includes(msg.seat)` is already
  the range check and the arbitrary-property check; a second one would be a guard for a
  value that cannot reach it.
- **A `Number.isFinite` guard inside `input_delay`.** The `pong` guard is the trust boundary;
  one guard where all callers route through beats one per consumer.
- **Replacing the `"local"` / `"ai"` / `"off"` literals across `src/net/room.js`,
  `src/net/loopback_transport.js` and `server/index.js` with `DRIVERS[n]`.** `DRIVERS` is an
  allowlist for validating client input, like `LEVELS`; turning readable literals into index
  arithmetic makes every one of those sites worse.
- **Logging the unknown `msg.type` string.** Unbounded client input on a socket with no rate
  limit (#47) — a log flood dressed as observability.
- **An error reply to any of the four rejections.** The relay answers a forged frame with
  nothing today (`server/index.js:1107-1109`); these are consistent with it, and a reply per
  rejected message is an amplification path.
- **Restricting `driver` to `room.started`.** Not in the criteria, and a client does release
  its seats on the way out of a match.
- **Validating the *shape* of `msg.seats` frames, `msg.reason`, or the forged board's
  contents.** Not in scope: #47 owns payload caps, and the client already bounds the board
  shape it renders.
- **Rate limiting, the reaper, room caps** — #47, explicitly out of scope.
- **Any change to the client's own `MAX_CATCH_UP` bound** — shipped in #80, and only its
  definition moves.
