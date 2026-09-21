# #95 — the level travels as a name, so a stale asset desyncs a room undetected

Plan for `philipdzierzon/jump-n-bump`, branch `master` @ `af04c21`.
All paths absolute under `/Users/philipdzierzon/Documents/sbx/jumpnbump/jump-n-bump/`.

**Bottom line:** seed the existing FNV-1a state checksum with an FNV-1a hash of the ban map.
~8 lines of production code across two files, no new wire message, no relay change, and the
whole detect → report → repair → eject-from-match chain that #41/#42 already shipped is
reused as-is. Rejected: a second hash channel, and shipping level data through the relay.

---

## 1. What the code does today

### 1.1 How a level is chosen and how the name travels

- `src/net/room_config.js:17-31` — `LEVELS` is the allowlist of 13 names. `"default"` is the
  built-in map; the other 12 resolve to `game/levels/<name>/<name>.dat`.
- `src/net/room_config.js:70` — `config_diff()` accepts `wanted.level` **only if it is in
  `LEVELS`**. This is the path-traversal guard and the only validation the level name gets.
- The host stages a config change from the lobby; `server/index.js:926` `begin()` applies
  `room.staged` onto `room.config`, then `server/index.js:984-1000` sends every non-queued
  client `{type:"start", …, settings: room.config}`. The comment there is explicit: *"The
  room's, never the proposer's"* — a client's own proposed settings are ignored (#5, #38).
- `src/net/room.js:105` — the client stores `self.settings = msg.settings` on `start`.
- `src/interaction/game_session.js:189` —
  `get_level(room.settings.level).then(function (level) { if (mine === starting) build(level); })`.

So the wire carries **a string**. Nothing else about the level crosses the network.

### 1.2 How each client resolves that name

`src/interaction/viewmodels.js:241-265`:

```js
function get_level(name) {
    if (name === CUSTOM) …                                    // local rooms only
    if (name === "default") return Promise.resolve(create_default_level());
    if (LEVELS.indexOf(name) < 0) return unavailable(name);
    if (!levels[name])
        levels[name] = fetch("levels/" + name + "/" + name + ".dat")
            .then(r => { if (!r.ok) throw …; return r.blob(); })
            .then(blob => loader.read(blob))
            .catch(err => { delete levels[name]; self.error(…); throw err; });
    return levels[name];
}
```

- `levels` is a per-tab promise cache keyed by **name** (`viewmodels.js:88`). Once a name has
  resolved, that tab never refetches it — a repair (`start` with a snapshot) re-enters
  `on_start`, calls `get_level` again, and gets the same cached, possibly stale level back.
- `viewmodels.js:283-285` `preload()` warms the cache as soon as the lobby names a level.
- A plain `fetch()` with no `cache` option, served by `express.static` (`server/index.js:1206`)
  — ETag/Last-Modified, no `max-age`. A browser, service worker, corporate proxy or CDN edge
  that does not revalidate can serve a body from a previous deploy.

### 1.3 `.dat` → `{ ban_map, image, mask }`

`src/resource_loading/dat_level_loader.js:37-73`. `read_levelmap()` reads `levelmap.txt` out
of the archive index and produces a flat array of ints 0–4, `LEVEL_WIDTH * LEVEL_HEIGHT`
= 22×16 = 352 entries, **plus** a 22-entry sentinel row of `BAN_SOLID` at indices 352–373
(`dat_level_loader.js:68-70`). So a `.dat` ban map is 374 long. `self.flip` mirrors x.

`src/asset_data/default_levelmap.js:5-27` `default_ban_map()` builds the built-in map from a
string literal in the bundle — **352 entries, no sentinel row**, constructed in-process, never
fetched. `create_default_level()` (`default_levelmap.js:30-36`) takes its images from
`<img id="level">` / `<img id="mask">` in `src/jnb.html:76-77`.

### 1.4 What the simulation actually reads

`src/game/game.js:36` — `reset_level()` calls `SET_BAN_MAP(level.ban_map)`.
`src/game/level.js:9-23` — one module-level `ban_map`, read through `GET_BAN_MAP`,
`GET_BAN_MAP_XY`, `GET_BAN_MAP_IN_WATER`. **`level.image` and `level.mask` never reach
`src/game/`** — they go to `Renderer` only. The ban map is the whole of the simulation's
dependency on the level, which is why AC4 is right to name it.

Critically, `src/game/player.js:49-62`:

```js
while (1) {
    s1 = rnd(LEVEL_WIDTH);
    s2 = rnd(LEVEL_HEIGHT);
    if (GET_BAN_MAP(s1, s2) == BAN_VOID &&
        (GET_BAN_MAP(s1, s2 + 1) == BAN_SOLID || GET_BAN_MAP(s1, s2 + 1) == BAN_ICE)) break;
}
```

Spawning is **rejection sampling against the ban map**. A differing tile can change which
draws are accepted, so a differing ban map perturbs the RNG stream itself *before tick 0 runs*.

### 1.5 The build-string check (the shape to copy)

Stamped at build time, `webpack.config.js:28`:
`"process.env.JNB_BUILD": JSON.stringify(String(Date.now()))`, read at
`src/interaction/viewmodels.js:81` and attached to the handshake at `viewmodels.js:753`.

`server/index.js:193-199`:

```js
    // After the password, so a refusal still says nothing about a room the client could not
    // have joined anyway (#8). A client that declares no build is not checked: the headless
    // suites and `smoke.mjs` are clients too, and this catches a tab left open across a
    // rebuild rather than a client that lies about what it is running (#29 owns that).
    if (msg.build && room.build && msg.build !== room.build) {
        console.log("room %s refused build %s, running %s", room.id, msg.build, room.build);
        return send(client, { type: "error", code: "OUT_OF_DATE" });
    }
```

Also `best_room()` filters on it (`server/index.js:247-256`), and it is stored on the room at
`server/index.js:116-119`. It covers the **bundle**; `game/levels/*.dat` are checked-in
runtime assets webpack never touches, so the build string says nothing about them.

### 1.6 The mismatch-reporting mechanism that already exists (#40/#41/#42)

This is the whole point — it is already built, end to end:

| Step | Where |
| --- | --- |
| Client hashes its sim every 30 ticks, sends `{type:"checksum", t, h}` | `src/net/room.js:13`, `src/net/room.js:269-270` |
| The hash is FNV-1a over `pack_snapshot()`'s bytes | `src/game/snapshot.js:154-159` |
| The session wires it up (networked rooms only) | `src/interaction/game_session.js:85-88` |
| Relay keeps the host's last 8 hashes, compares each client's | `server/index.js:836-857` (`keep_checksum`) |
| Mismatch → repair from the host's snapshot, rate-limited, max 5 | `server/index.js:864-913` (`desync`) |
| 5 repairs with no let-up → out of the **match**, keeps its **seat** | `server/index.js:915-923` (`drop_from_match`) → `{type:"match_end", reason:"desync"}` |
| The client says so in words | `src/interaction/scores_viewmodel.js:69-73` |

`src/game/snapshot.js:154-159` today:

```js
export function checksum_snapshot(ints) {
    var bytes = new Uint8Array(ints.buffer);
    var hash = 2166136261;
    for (var i = 0; i < bytes.length; i++) hash = Math.imul(hash ^ bytes[i], 16777619);
    return hash | 0;
}
```

`test/replay.test.mjs:28-34` has a second FNV-1a (`fnv1a`/`checksum`) used for the
determinism golden value. **Do not add a third.** Reuse `checksum_snapshot`.

### 1.7 Honest severity: it is partly self-detecting today

Because `position_player` rejection-samples the ban map (§1.4), **most** differing ban maps
already diverge the packed state at tick 0 and are caught by the existing checksum at tick 0.
What is *not* caught is a tile difference that happens not to change any spawn draw's
accept/reject and that no bunny touches for a while — and that is exactly the case that
"plays through" for seconds or minutes before anyone notices. It is also never *attributed*:
the log says `desync`, not "wrong level".

So the bug is real but narrower than the issue implies, and the fix's value is **unconditional,
immediate, attributable** detection rather than detection-eventually.

---

## 2. The design decision

### 2.1 What is the smallest thing that identifies a ban map?

**A 32-bit FNV-1a over the ban map's ints, computed with the function already in the tree.**

- Not the array itself: 374 ints is ~1.5 KB per check, 60× more wire than a 4-byte hash, and
  the relay would have to compare arrays instead of `!==` on a number.
- Not the level name: AC4 rules that out, and it is exactly what fails today.
- Not a new hashing scheme: `checksum_snapshot` already takes an `Int32Array` and returns a
  signed int32 that JSON carries. `Int32Array.from(ban_map)` feeds it directly, and differing
  lengths (352 for `default`, 374 for a `.dat`) hash differently, which is correct.

### 2.2 Where the check lives

**Nowhere new. Seed the existing state checksum with the ban-map hash.**

```
checksum_snapshot(pack_snapshot(rnd, objects, t), checksum_ban_map(level.ban_map))
```

FNV-1a is a streaming hash, so chaining from a different offset basis is the idiomatic
composition: "this state, hashed *inside* this level". Two clients on the same map keep
hashing identically; two clients on different maps disagree **on every tick, from tick 0**,
whatever the state is.

Why this rung and not the alternatives:

| Option | Cost | Verdict |
| --- | --- | --- |
| **Seed the state checksum** (chosen) | 1 optional parameter in `snapshot.js`, 1 new 3-line export, 2 lines in `game_session.js`. Zero server lines, zero new message types, zero new relay state, zero new failure paths. Detects at **tick 0**. | Take it |
| Client sends a ban-map hash on join | Impossible: the client does not know the level until `start`, and has not fetched it. | No |
| Host's hash in the `start` payload | Impossible: the relay sends `start` *before* any client, host included, has fetched the level. | No |
| New `{type:"level", h}` message, relay compares | ~30 lines: room field, reset in `begin()`, a new handler duplicating `keep_checksum`'s "held one deep" race (host's and guest's can arrive in either order), a `Room.send_level`, a dispatch case, relay test. Detects *later* than the chosen option (both clients must have finished building). | Rung 2 of the ladder says reuse what is here. No — but see §5 |

### 2.3 Refuse or repair?

**Refuse — via the existing eject-from-match path. Repair is structurally impossible.**

A repair is `resume()` → the host's packed snapshot unpacked into this client's sim. It
replaces players, objects and the RNG state. It does **not** replace `ban_map`: that comes
from `level` in `build()`, and `get_level` hands back the same stale cached promise
(`viewmodels.js:247`). So every subsequent `GET_BAN_MAP` read is still wrong and the client
re-diverges immediately. There is no repair for a wrong asset short of refetching it.

The existing path already ends in refusal: 5 futile repairs → `drop_from_match`
(`server/index.js:915`) → `match_end reason:"desync"` → the client keeps its seat, the board
reads `(out of sync)`, and it plays the next match. That is exactly the repo rule *eject from
the match, never from the room*, and `src/interaction/scores_viewmodel.js:69-73` already says
both halves out loud. **Nothing to build for AC2 beyond making the mismatch visible.**

Cost of reusing it rather than short-circuiting: ~12 s and 5 wasted repairs before ejection
(first repair is free — `keep_snapshot`'s `resume(other)` at `server/index.js:761` does not
spend one; then `repair_cooldown_ms` = 2000 × 5). That is the one real corner cut, and it
gets a `ponytail:` comment (§3.5).

### 2.4 Adjudicating "Out of scope: shipping level data through the relay… unless smallest"

**It is not the smallest fix. Do not do it.**

1. Neither the host nor any client has a ban map when `begin()` sends `start` — both fetch
   afterwards. Shipping it would need a *new* round: host builds, host uploads its ban map,
   relay re-broadcasts, everyone waits. That is a new phase in the match-start handshake,
   which is strictly more than a new message type, which is already more than this plan.
2. It only moves the problem: `image` and `mask` still come by fetch, so a mid-deploy client
   gets the host's ban map painted over the wrong picture — a silent visual lie in place of a
   loud desync.
3. It would change `build()`'s contract (`level` would no longer be one object from
   `get_level`) and `Dat_Level_Loader.read`'s single return value.

The hash is ~8 lines. Shipping data is a protocol change. Verdict: hash.

---

## 3. The change, criterion by criterion

### 3.0 New: `checksum_ban_map` — `src/game/snapshot.js`

Add the optional seed parameter and the named ban-map hash, immediately after the existing
`checksum_snapshot` (around `src/game/snapshot.js:154`):

```js
// FNV-1a 32-bit over the packed bytes, which is the desync check (#41). It hashes the
// serializer's own output rather than a field list of its own: a field this file packs is a
// field the checksum covers, and one it does not is one neither the resync nor the check
// ever needed. Signed, because that is what JSON carries back out of `| 0`.
//
// `seed` is the offset basis to chain from, which is how the level gets into a hash of a
// state (#95): FNV is a streaming hash, so starting it at the ban map's own hash is "this
// state, inside this level" rather than a second number to compare. Defaulted, so a caller
// with no level -- the replay suite -- hashes exactly what it always did.
//
// ponytail: 32 bits, so one desync in four billion hashes to the host's and is missed. The
// next check is 30 ticks later, and a desync is permanent. upgrade path: a wider hash if a
// room ever runs long enough for that to be the thing that went wrong.
export function checksum_snapshot(ints, seed) {
    var bytes = new Uint8Array(ints.buffer);
    var hash = seed === undefined ? 2166136261 : seed;
    for (var i = 0; i < bytes.length; i++) hash = Math.imul(hash ^ bytes[i], 16777619);
    return hash | 0;
}

// The level, as far as the simulation is concerned (#95). `image` and `mask` never leave
// `src/interaction/`; the ban map is the whole of what a tick reads, so it is the whole of
// what has to match -- and the name does not, because the name is what travels between
// clients while the bytes behind it are each client's own fetch.
//
// The same FNV-1a, deliberately: one hashing scheme in this tree, not two. A `.dat` map is
// 374 entries (22x16 plus the solid sentinel row `dat_level_loader.js` appends) and the
// built-in one is 352, and two different lengths hashing differently is the right answer.
export function checksum_ban_map(ban_map) {
    return checksum_snapshot(Int32Array.from(ban_map));
}
```

That is the entire production-side mechanism. Everything below wires it in.

### 3.1 AC1 — two clients are guaranteed to be simulating the same ban map, or it is detected

`src/interaction/game_session.js`. Three edits:

**(a)** import, at `game_session.js:10-17`:

```js
import {
    bump_matrix,
    checksum_ban_map,
    checksum_snapshot,
    decode_snapshot,
    …
```

**(b)** a module-scope-of-the-session variable, beside `objects` / `rnd` (`game_session.js:96-97`):

```js
    // The ban map of the level this match is being played on, hashed once when it is built.
    // Every tick's checksum chains from it, so two clients that resolved one level name to
    // two different `.dat` bodies -- a stale cache, a CDN edge mid-deploy -- disagree on
    // every hash from tick 0 rather than on the first tick a bunny touches the tile that
    // differs (#95). Zero until a level is built, which is before any tick is stepped.
    var level_hash = 0;
```

**(c)** `room.checksum` at `game_session.js:85-88` becomes:

```js
    if (!config.local)
        room.checksum = function (t) {
            return checksum_snapshot(pack_snapshot(rnd, objects, t), level_hash);
        };
```

and in `build(level)`, immediately after the two early-return guards at `game_session.js:253`
(so a `start` this client refuses to build never leaves a stale hash behind):

```js
        var t1 = performance.now();
        level_hash = checksum_ban_map(level.ban_map);
        rnd = make_rnd(room.seed);
```

Ordering is safe: `build()` sets it before `room.catch_up(game.step)` (`game_session.js:287`)
and before `play()` arms the pump; and `room.step` sends no checksum while `catching_up`
(`src/net/room.js:269`).

Nothing else changes. `server/index.js` compares `reference.h !== msg.h`
(`server/index.js:844`) and does not care what went into either number.

### 3.2 AC2 — refused or repaired rather than left desyncing

**No code.** §2.3: the mismatch enters `keep_checksum` → `desync` → up to 5 repairs →
`drop_from_match` → `match_end reason:"desync"` → `match_result(…, "desync")`
(`src/interaction/scores_viewmodel.js:69-73`) tells the player, and the seat stays theirs.

The one addition is the honesty comment at the point of the compromise, in
`src/interaction/game_session.js` beside `level_hash` (§3.5).

### 3.3 AC3 — a deploy that swaps a level asset under a running match does not silently desync it

**Covered by 3.1, with a caveat worth writing down in the PR.**

A client that reloads after the deploy fetches the new `.dat`; one that did not, holds the old
one in `levels[name]` for the tab's lifetime. Their `level_hash` differs, so their per-tick
checksums differ from tick 0 of the next match (or from the resume tick of a mid-match join),
and the relay ejects the stale one from the match with a reason.

Caveat: today the client, the relay and `game/levels/` ship in **one image**
(`Dockerfile`, `server/index.js:1203-1208`), so a deploy restarts the relay and every room
dies with it — and `JNB_BUILD` is `Date.now()` per build (`webpack.config.js:28`), so a tab
left open is refused `OUT_OF_DATE` on rejoin anyway. The window AC3 names is only open behind
a CDN/reverse proxy, or when the same-origin cache serves a body from a previous deploy. The
hash closes it either way; do not claim the build string was doing nothing.

### 3.4 AC4 — the check covers the ban map specifically, not the level's name

Satisfied by construction: `checksum_ban_map(level.ban_map)` hashes the array `SET_BAN_MAP`
is called with (`src/game/game.js:36`) — the exact object `GET_BAN_MAP*` read from
(`src/game/level.js:15-29`). `level.image` and `level.mask` are deliberately **not** hashed:
they never reach `src/game/`, and hashing a decoded `Image` would drag the DOM into
`src/game/`, which `src/game/env.js:3-4` exists to prevent.

`room.settings.level` — the name — is not involved in the check at all.

### 3.5 The `ponytail:` comment

One is warranted, at `src/interaction/game_session.js` beside `level_hash`, naming the
ceiling from §2.3:

```js
    // ponytail: the relay cannot tell a wrong ban map from a determinism bug, so a client on
    // a stale level is repaired five times from a snapshot that cannot fix it -- about twelve
    // seconds -- before it is dropped from the match. upgrade path: a `level` message of its
    // own that the relay compares at match start and answers with one refusal, if that window
    // ever turns up in a log.
```

The existing `ponytail:` at `src/game/snapshot.js:151-153` (32-bit collision) still stands and
is not widened by this change.

---

## 4. Tests

### 4.1 `test/replay.test.mjs` — AC5, the two-client case

This is where two real simulations already exist (`start()` at `test/replay.test.mjs:90-107`,
and the host/joiner pair at lines 415-480). Two changes:

**(a)** give `start()` a ban map parameter, defaulting to today's value
(`test/replay.test.mjs:90` and `:103`):

```js
function start(seed, settings, held, transport = new Loopback_Transport(), ban_map = default_ban_map()) {
```
```js
        { ban_map },
```

**(b)** a new block at the end of the file, next to the existing checksum section
(`test/replay.test.mjs:505-520`). Import `checksum_ban_map` alongside `checksum_snapshot`
(`test/replay.test.mjs:18-24`):

```js
// --- the level is in the hash (#95) ---------------------------------------------------
//
// The level travels between clients as a name and each one resolves it by fetching, so a
// stale cache or a CDN edge mid-deploy gives two clients different ban maps under one name.
// The build string covers the bundle, not `game/levels/*.dat`. Chaining the state hash from
// the ban map's own is what turns that into the checksum mismatch the relay already repairs
// and, failing that, drops a client from the match for (#41, #95).
const same_map = default_ban_map();
const other_map = default_ban_map();
// One tile of open air turned solid: a whole different set of collisions, and exactly the
// kind of difference a bunny may not touch for minutes.
other_map[7 * LEVEL_WIDTH + 11] = BAN_SOLID;

assert.notEqual(
    checksum_ban_map(same_map),
    checksum_ban_map(other_map),
    "one tile is a different ban map",
);
assert.equal(
    checksum_ban_map(default_ban_map()),
    checksum_ban_map(default_ban_map()),
    "and the same map is the same map: the hash is of the tiles, not of the array object",
);

// The mechanism, isolated: one identical state, two levels, two hashes. This is the half the
// simulation cannot show on its own -- a differing ban map perturbs the spawn draws, so the
// states diverge too, and asserting on diverged states would prove nothing about the level.
const one_state = pack_snapshot(joiner.rnd, joiner.objects, 0);
assert.notEqual(
    checksum_snapshot(one_state, checksum_ban_map(same_map)),
    checksum_snapshot(one_state, checksum_ban_map(other_map)),
    "two clients in the same state on different ban maps do not hash the same",
);
assert.equal(
    checksum_snapshot(one_state),
    checksum_snapshot(one_state, 2166136261),
    "and an unseeded hash is the offset-basis one, so nothing that had no level changed",
);

// Two clients, one seed, one input log, two ban maps: they disagree on the very first hash
// they send, which is tick 0 (#95). `player` is a module global that building a Game
// replaces, so the first client's hash is taken before the second is constructed (#5).
function hashed_after(ticks, ban_map) {
    const client = start(1234, { no_gore: false }, [0, 1], new Loopback_Transport(), ban_map);
    client.room.checksum = (t) =>
        checksum_snapshot(pack_snapshot(client.rnd, client.objects, t), checksum_ban_map(ban_map));
    for (let tick = 0; tick < ticks; tick++) client.game.step();
    return client.room.checksum(client.room.now());
}
assert.equal(hashed_after(0, same_map), hashed_after(0, same_map), "two clients on one map agree");
assert.notEqual(
    hashed_after(0, same_map),
    hashed_after(0, other_map),
    "and two on different ban maps disagree on tick 0, before a bunny has touched the tile",
);
```

Import `BAN_SOLID` and `LEVEL_WIDTH` — `LEVEL_WIDTH` from
`../src/asset_data/default_levelmap.js` (already imported for `default_ban_map`), `BAN_SOLID`
from `../src/game/level.js`.

**Check the chosen tile first.** In `default_levelmap.js:7-22` the rows are listed top to
bottom starting at index 0; row 7 is `"1000000000000000000011"` and index 11 of it is `'0'`
= `BAN_VOID`, so flipping it to `BAN_SOLID` is a real change. Re-count before writing the
test — if that index is already solid the assertion passes for the wrong reason.

### 4.2 `test/relay.test.mjs` — the relay half

**No new test is required and none should be invented.** The relay compares two opaque int32s;
that two differing hashes end in `match_end reason:"desync"` while the client keeps its seat is
already asserted at `test/relay.test.mjs:766-1000`, and the "still in the room" wording at
`test/router.test.mjs:80-89`.

Do add two lines of comment at `test/relay.test.mjs:1017-1023` (the level-file-existence loop)
pointing at #95, so the next reader knows the allowlist is not the guarantee:

```js
// A level name is resolved by fetching `levels/<name>/<name>.dat` beside the page, so the
// list is only an allowlist while every name in it is really there (#38) -- and only a name:
// that the bytes behind it are the same bytes on every client is the ban map's own hash, in
// every tick's checksum (#95, `checksum_ban_map`).
```

### 4.3 What does not change

`npm run format` before committing (`.prettierrc`: tabWidth 4, printWidth 100), and
`npm test` runs all four suites.

---

## 5. Risks / unknowns

1. **Not reproduced.** I could not establish, by reading, that a stale `.dat` is ever actually
   served under an unchanged build string in this deployment. Everything in §1.2 is a
   *mechanism* argument (no `max-age`, a per-tab promise cache that never refetches, a
   fetch that a proxy or service worker may answer from cache). **What would settle it:**
   `server/index.js` honours `CLIENT_DIR`, so a Playwright case in `test/browser.test.mjs`
   could boot two origins over two `game/` copies whose `caves.dat` differ in one tile, point
   two browser contexts at them and watch the room. That is a real reproduction and a real
   regression test — and it is a chunk of work well past this fix. Flagging, not building.
2. **The bug is narrower than the issue states** (§1.7): spawn rejection-sampling already
   catches most differing ban maps at tick 0 today. The fix's value is making detection
   unconditional and immediate for *any* tile, including one no bunny touches for minutes.
   Say this in the PR rather than letting a reviewer discover it.
3. **Determinism risk to `test/replay.test.mjs`: none.** The `seed` parameter defaults to
   `2166136261`, so the four existing call sites (`replay.test.mjs:434, 474, 479, 516`) and the
   file's own golden `checksum()` (`replay.test.mjs:37-66`, a separate FNV) are byte-identical.
   `src/game/` gains no clock, DOM or URL read; `checksum_ban_map` is a pure function of an
   array of small ints. Prove it by running `npm test` before *and* after the `game_session.js`
   edit — `replay.test.mjs` must produce the same result both times.
4. **`Int32Array.from` on a sparse array** yields `0` for a hole. Neither producer leaves holes
   (`dat_level_loader.js:52-70` fills 0–373; `default_levelmap.js:24-26` fills 0–351), so this
   is safe today — but a future loader that did would hash a hole and a `0` alike. Not worth a
   guard; worth knowing.
5. **The ~12 s / 5-repair ejection window** (§2.3) is a product judgement I cannot make from
   reading. If a reviewer says it must be one prompt refusal, the upgrade is §2.2's `level`
   message and the `ponytail:` comment already names it.
6. **Custom levels are already out of the networked path**, so there is nothing to do:
   `CUSTOM` (`viewmodels.js:53`) is offered only when `!self.room_id()`
   (`viewmodels.js:177-178`) and `config_diff` drops it because it is not in `LEVELS`
   (`room_config.js:70`). It still gets hashed, harmlessly, because `build()` hashes whatever
   level it is handed.
7. **`self.flip`** (`dat_level_loader.js:8, 62`) mirrors a ban map on load. It is never set to
   `true` anywhere in `src/`, so it cannot desync a room today — but if it were ever driven by
   anything client-local, this hash is what would catch it.
8. The workspace `CLAUDE.md` describes a `deploy-to-gh-pages.yml`; this checkout has only
   `.github/workflows/ci.yml` and a Docker deploy. Treat the gh-pages description as stale
   when reasoning about cache headers.

---

## 6. Deliberately not doing

- **A `{type:"level", h}` message and a relay-side comparison** — 30 lines, a new protocol
  message, and a duplicate of `keep_checksum`'s pending-hash race, to detect *later* than a
  seeded checksum does. Named as the upgrade path in the `ponytail:` comment.
- **Shipping ban maps through the relay** — adjudicated in §2.4: a new phase in the match-start
  handshake, and it leaves `image`/`mask` unverified. Not the smallest fix.
- **Hashing `level.image` / `level.mask`** — never read by `src/game/`; hashing them would pull
  the DOM into the simulation layer that `src/game/env.js:3-4` exists to keep DOM-free, and a
  wrong picture is a cosmetic bug, not a desync.
- **Refetching the level with `cache: "reload"` on a repair** — a plausible *actual* repair for
  a stale asset, and pure speculation until §5.1 reproduces one. YAGNI.
- **Cache-busting the `.dat` URLs with the build string** — would make AC3 mostly moot, but it
  is a deploy change that does not cover the per-client stale-cache case at all, and the hash
  covers both. Mention in the PR as a cheap belt-and-braces follow-up, do not build it.
- **A third FNV-1a implementation** — `checksum_snapshot` is reused verbatim.
- **A new `match_end` reason or any new UI** — `"desync"` already says the right thing
  (`src/interaction/scores_viewmodel.js:69-73`), and #41's rule stands: a desync correction and
  a lag correction look alike from the inside.
- **Touching the build-string check** — explicitly out of scope, and §3.3 shows it is doing
  real work.
