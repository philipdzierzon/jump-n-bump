# #96 — Assert the two browser pages agree tick by tick

Plan only. Read-only research against `philipdzierzon/jump-n-bump` @ `master` `af04c21`
(`/Users/philipdzierzon/Documents/sbx/jumpnbump/jump-n-bump`). Nothing was edited, built or run.

**Verdict: the premise holds.** All four pieces of #41 exist on `master`, and there is a seam a
Playwright page can read with **no production change at all** — the checksum is a message on the
wire, and the suite already records outbound WebSocket frames.

The whole change is confined to **one file**: `test/browser.test.mjs` (plus one stale sentence in
`CLAUDE.md`, flagged in §5).

---

## 1. The premise, verified

### 1a. `room.checksum` — the room carries a checksum function

`src/net/room.js:86-88`

```js
// What this client hashes its state to for a given tick, or null in a local room, which
// has nobody to disagree with and checksums nothing (#41, #16). Set by the session,
// because the state being hashed is the simulation's and this layer sees none of it.
this.checksum = null;
```

Declared, never assigned inside `Room`. It is a hole the session fills.

### 1b. The session installs it over the packed snapshot

`src/interaction/game_session.js:85-88`

```js
if (!config.local)
    room.checksum = function (t) {
        return checksum_snapshot(pack_snapshot(rnd, objects, t));
    };
```

`config.local` is `!self.room_id()` (`src/interaction/viewmodels.js:563`), so **every networked
page hashes, host included**. `rnd` and `objects` are `var`s the session reassigns on each
`build()`, and the closure reads them at call time — so the function survives a match change and a
repair without being reinstalled.

`pack_snapshot` (`src/game/snapshot.js:62-79`) writes `tick` at `out[0]`, then `rnd.state()`, then
every player (incl. `action_left/right/up`, position, velocity, anim, `bumped[]`), then every object
slot. The tick is *inside* the hash, which is why comparing at equal ticks is the only comparison
that means anything.

### 1c. The client already sends checksum messages on an interval

`src/net/room.js:150-152` and `src/net/room.js:262-270`, inside `Room.step()`:

```js
var CHECKSUM_TICKS = 30;
...
// On the same tick on every client, and from the same point in it: the state
// hashed here is every tick before this one applied and none of this one ...
if (self.checksum && tick % CHECKSUM_TICKS === 0)
    transport.send({ type: "checksum", t: tick, h: self.checksum(tick) });
```

Interval: **every 30 ticks = half a second**, starting at tick 0, suppressed while
`catching_up` (a replayed gap is history the host hashed seconds ago).

`WebSocket_Transport.send` (`src/net/websocket_transport.js`, the `this.send` near the bottom) is
`socket.send(JSON.stringify(msg))` — so the message goes out as literal JSON text:
`{"type":"checksum","t":120,"h":-1183412}`.

The relay's half is `keep_checksum` / `desync` at `server/index.js:836-857` and the eight-deep
window at `server/index.js:45`. **We do not touch it** — `relay.test.mjs:766-990` already covers it.

### 1d. `replay.test.mjs` asserts on the same hash — genuinely the same

`test/replay.test.mjs:474` installs the *identical* expression the session installs:

```js
joiner.room.checksum = (t) => checksum_snapshot(pack_snapshot(joiner.rnd, joiner.objects, t));
```

and `test/replay.test.mjs:512-519` is the pair that proves the hash means what #96 wants it to mean:

```js
assert.equal(joined_hash, host_hash, "a client in the host's state hashes to the host's");
assert.notEqual(checksum_snapshot(decode_snapshot(body)), host_hash,
    "and one 150 ticks behind it does not: a mismatch is the desync");
```

Both sides import `checksum_snapshot` from `src/game/snapshot.js:154-160` — FNV-1a 32-bit over
`pack_snapshot`'s bytes. Same function, same input, same hash.

> **Lookalike warning for the implementer.** `test/replay.test.mjs:39` defines a *different*
> `checksum(objects)` — a hand-rolled FNV over a field list, returning `>>> 0`. It is not the
> checksum #41 shipped and is not what #96 is about. Do not confuse them.

### 1e. **The seam a Playwright page can actually read**

`CLAUDE.md` is right that the bundle exports nothing. It does not need to: **the hash is already on
the wire, and the suite already reads the wire.**

`test/browser.test.mjs:154-162`, on the main walk page:

```js
page.on("websocket", (ws) => {
    const n = ++sockets;
    ws.on("framereceived", ({ payload }) => frames.push(`s${n} <- ` + String(payload).slice(0, 200)));
    ws.on("framesent", ({ payload }) => frames.push(`s${n} -> ` + String(payload).slice(0, 200)));
    ws.on("close", () => frames.push(`s${n} closed`));
});
```

`framesent` is Playwright's CDP-level network event. It fires for every text frame the page sends,
including `{"type":"checksum","t":…,"h":…}`, on every socket the page opens (so a reconnect is
picked up too). It does not care that `reconnect()` shadows `window.WebSocket`.

**So: no production seam. Zero non-test lines change.** The tick-keyed hash is read off
`framesent` on each of the two pages.

The second seam, for the fault injection only, is the one the suite already uses twice — a context
init script (`record_audio` at `test/browser.test.mjs:98-111`, the socket keeper at
`test/browser.test.mjs:1578-1590`). Same technique, applied to `WebSocket.prototype.send`.

---

## 2. The change, criterion by criterion

All edits are in **`test/browser.test.mjs`**.

### 2.0 Two helpers, in the `--- helpers ---` section (after `relay_client`, ~line 336)

```js
// Every hash a page handed the relay, keyed by the tick it names (#41, #96). The bundle
// exports nothing to reach into, and it does not have to: a checksum is a message, and the
// room sends one every thirty ticks from a fixed point inside the tick -- every tick before
// it applied and none of it -- so two clients in the same state report the same number for
// the same tick. `framesent` is every socket the page opens, a reconnect included.
//
// ponytail: half-second grain, because that is what the client sends. upgrade path: none
// worth a production hook -- a finer grain would be a seam existing only for a test.
function record_checksums(page) {
    const hashes = new Map();
    page.on("websocket", (ws) =>
        ws.on("framesent", ({ payload }) => {
            const text = String(payload);
            if (!text.includes('"checksum"')) return;
            const msg = JSON.parse(text);
            if (msg.type === "checksum") hashes.set(msg.t, msg.h);
        }),
    );
    return hashes;
}

// Paired by tick and never by time. The two pages run on their own 60 Hz clocks and are
// never on the same tick at the same moment; a hash is stamped with the tick it hashed, so
// the pairing is exact and nothing here ever waits for the two to line up.
const paired = (a, b, from = 0) =>
    [...a.keys()].filter((t) => t >= from && b.has(t)).sort((x, y) => x - y);
const disagreements = (a, b, from = 0) => paired(a, b, from).filter((t) => a.get(t) !== b.get(t));
```

### 2.1 AC1 + AC2 + AC3 — inside `two_pages()`

**(a) Wire up the recorders and the liar.** Replace `test/browser.test.mjs:1071-1072`

```js
    const host = await (await make_context("host")).newPage();
    const guest = await (await make_context("guest")).newPage();
```

with

```js
    const host = await (await make_context("host")).newPage();
    const guest_context = await make_context("guest");
    // A hash that is wrong on purpose, so the assertion below is shown capable of failing
    // (#96). It lies a fixed number of times and then stops by itself: the relay answers a
    // mismatch with a repair, and two disagreements are enough to see without asking for a
    // stream of them. Patched here rather than in the bundle -- the client has no seam for
    // this, and it must not grow one.
    //
    // ponytail: what is diverged is the number on the wire, not the simulation behind it --
    // that the state and the hash move together is `replay.test.mjs:512-519`'s, where a
    // client 150 ticks behind is asserted not to hash to the host's. upgrade path: drop an
    // inbound `input` frame with a key held down, if the relay's own repair ever stops
    // racing the window you would have to read it in.
    await guest_context.addInitScript(() => {
        window.__lies = 0;
        window.__lied = [];
        const send = WebSocket.prototype.send;
        WebSocket.prototype.send = function (data) {
            if (window.__lies > 0 && typeof data === "string" && data.includes('"checksum"')) {
                const msg = JSON.parse(data);
                if (msg.type === "checksum") {
                    window.__lies--;
                    window.__lied.push(msg.t);
                    data = JSON.stringify({ type: "checksum", t: msg.t, h: (msg.h ^ 1) | 0 });
                }
            }
            return send.call(this, data);
        };
    });
    const guest = await guest_context.newPage();
    // Before either `goto`, or the handshake socket is opened before anything is listening.
    const host_hashes = record_checksums(host);
    const guest_hashes = record_checksums(guest);
```

**(b) AC1 — the first window.** Replace `test/browser.test.mjs:1159-1161`

```js
    // Long enough for both simulations to have stepped a good many ticks of one match.
    await settle();
    await settle();
```

with

```js
    // --- the two simulations, tick by tick (#41, #96) ---------------------------------
    // Not the final board, which travels with the announcement and would agree even if the
    // two had played different matches: this is each page's own hash of its own state, for
    // the same tick, read off the wire it sends it on. Three of them is a second and a half
    // of match, which is also long enough for both to have stepped a good many ticks.
    await until("three ticks both pages have hashed", () => paired(host_hashes, guest_hashes).length >= 3);
    assert.deepEqual(
        disagreements(host_hashes, guest_hashes),
        [],
        "the two pages hash the same state for the same tick: one match, simulated twice (#41)",
    );
```

**(c) AC2 — the negative control, immediately after (b).**

```js
    // And the assertion is capable of failing: two hashes the guest gets deliberately
    // wrong, and the ticks that disagree are exactly those two.
    await guest.evaluate(() => (window.__lies = 2));
    await until("two hashes the guest got wrong on purpose", async () => {
        const said = await guest.evaluate(() => window.__lied);
        return said.length === 2 && said.every((t) => host_hashes.has(t));
    });
    const lied = await guest.evaluate(() => window.__lied);
    assert.deepEqual(
        disagreements(host_hashes, guest_hashes),
        lied,
        "a client reporting a hash that is not the host's fails this assertion, and nothing else does",
    );

    // Off again, and the two agree for the rest of the match. The relay may answer the lie
    // with a repair of its own -- it needs a snapshot to do it with, and the host's first is
    // two seconds in -- and either way the next ticks both pages hash agree again.
    const after_lie = Math.max(...lied) + 1;
    await until("three more ticks both pages have hashed", () =>
        paired(host_hashes, guest_hashes, after_lie).length >= 3,
    );
    assert.deepEqual(
        disagreements(host_hashes, guest_hashes, after_lie),
        [],
        "and a client that stops lying is back in step with the host",
    );
```

**(d) AC3 — after the repair the #42 block already performs.** No new walk. The existing block at
`test/browser.test.mjs:1163-1206` takes the guest out of the match and back in **twice**, and each
re-entry is a real mid-match repair: `Rejoin the match` / `Take seat (A D W)` make the relay send
`start` carrying the host's snapshot, which `game_session.js:157-160` unpacks over the guest's
simulation and `Room.catch_up` replays forward. While the guest sits in the lobby its game is
paused (`game_session.js:392-413`, `stop()` → `game.pause()`), so it hashes nothing — the two
windows are naturally disjoint.

Insert immediately after the `until("both seats to be the client's", …)` block and before
`watcher.close()` (~line 1206):

```js
    // --- and they agree again after the repair (#40, #41, #96) ------------------------
    // The guest has just been handed the host's packed state twice and replayed the gap
    // between it and now. If a resync landed a client in a state that was nearly the host's
    // it would look right on screen and hash differently, which is the whole reason the
    // hash exists. Measured from where the host is now, so nothing before the repair counts.
    const after_repair = Math.max(...host_hashes.keys()) + 1;
    await until("three ticks both pages have hashed since the repair", () =>
        paired(host_hashes, guest_hashes, after_repair).length >= 3,
    );
    assert.deepEqual(
        disagreements(host_hashes, guest_hashes, after_repair),
        [],
        "a client resumed from the host's snapshot hashes to the host's, tick for tick (#40)",
    );
```

### 2.2 AC4 — delete the stale comment

`test/browser.test.mjs:1065-1068`, remove these four lines outright:

```js
//
// Tick-by-tick agreement of the two simulations is not here. That needs a checksum the
// client does not expose, which is #41; building a feature in order to test it is the wrong
// order round.
```

and extend the block comment above `two_pages()` so the walk still says what it does — replace
`test/browser.test.mjs:1064` (`// token -- and what is asserted is that they *agree*. The room is one thing, seen twice.`)
with:

```js
// token -- and what is asserted is that they *agree*. The room is one thing, seen twice.
//
// Including tick by tick, which needed #41's checksum and now has it: each page hashes its
// own simulation every thirty ticks and hands the number to the relay, so the wire carries a
// tick-keyed hash a test can read without the bundle exporting anything. Sampled three times
// -- early in the match, with a hash deliberately wrong, and again after the guest has been
// repaired out of and back into the match -- and paired by tick, never by wall clock.
```

### 2.3 AC5 — no retries

Nothing to add. There is no retry machinery in this suite and none is introduced; every wait
above is `until()`, which polls for a *condition* (§3), and the one fixed wait in the file
(`settle()`) is not used by any of the new assertions. The two `settle()` calls at
`test/browser.test.mjs:1160-1161` are **replaced** by the `until` in 2.1(b), which is a strictly
stronger wait — it waits for real ticks rather than for 300 ms.

---

## 3. Determinism — why each assertion cannot flake

| Assertion | What makes it deterministic |
| --- | --- |
| **Pairing** (all four) | `paired()` intersects **tick keys**. The two pages are never on the same tick at the same instant and nothing here asks them to be: a hash is stamped with the tick it hashed (`room.js:270`), and `pack_snapshot` puts that tick in `out[0]`, so an equal key is an equal moment of one shared simulation. Wall clock never enters the comparison. |
| **AC1 "three ticks"** | `until()` polls a condition (`paired().length >= 3`) for up to 10 s. Three common ticks is 60 ticks of match = ~1 s, since `Game.pump` catches the sim up to a 60 Hz budget in a `while` loop — a slow client loses *drawn frames*, never ticks. A machine that cannot produce 60 ticks in 10 s fails the walk's existing `on("play")` waits first. |
| **AC1 "all agree"** | The seed, the settings, the driver table and the input stream are all the relay's and identical on both pages (`room.js:on "start"`, and the relay rings a released frame on its own deadline so a missing frame is the same value everywhere, `room.js:283-296`). The only remaining variable is the simulation itself, which is what is under test. |
| **AC2 "two lies"** | The lie count is a counter in the page, not a time window: `__lies = 2` produces exactly two corrupted messages and `__lied` names their ticks. The assertion then waits until the **host** has also reported both of those ticks before comparing, so it never compares against a half-arrived stream. `assert.deepEqual(disagreements(...), lied)` is exact in both directions. |
| **AC2 recovery** | Measured from `max(lied) + 1`, so no lied tick can leak into it. If the relay repairs the guest, the guest pauses, rebuilds and replays — hashing nothing meanwhile — and `until()` simply waits longer. If the relay does *not* repair (the host may not have snapshotted yet, `server/index.js` `desync()` bails when there is nothing to repair with), the ticks arrive sooner. Both outcomes satisfy the same condition. |
| **AC3** | Measured from `max(host_hashes.keys()) + 1` **at the moment the guest is confirmed back in `#play` with both seats** — a tick the guest cannot have hashed, because it was in the lobby with `game.pause()` called on it. The window is therefore strictly post-repair by construction, not by timing. |
| **Fake clock** | Deliberately **not** used here. `page.clock.install()` is per-context and freezes the page until wound (`self_ending_match`, `sound`); two pages in one relay room need two clocks wound in lockstep, which is a harder race than the one it would remove. This walk keeps the real clock and pairs by tick instead — which is why the pairing, not the clock, is what makes it deterministic. |
| **Pinned `Date` / seed** | Also not needed. `sound()` pins `Date.now()` because a *local* room seeds itself from it; a networked room takes the seed from the relay's `start` and both pages get the same one. Whichever seed it is, the two pages get the same seed, and agreement is seed-independent. |

**Nothing here is left non-deterministic.** The one honest gap is stated in §5, and it is a gap in
*what is injected*, not in *when things are read*.

---

## 4. Risks — what could go red for a real reason

1. **This may turn `master` red, and that is the point.** Every desync #81 found is currently
   unprovable in CI; this is the assertion that would prove one. If `disagreements(...)` comes back
   non-empty on an unmodified `master`, **that is a finding, not a test bug.** The implementer
   should: capture the failing ticks and both hashes, keep `trace-host.zip` / `trace-guest.zip`,
   **file an issue against the simulation** referencing #81, and **not** weaken the assertion, add
   a retry, or exclude the offending window to get green. The issue's own out-of-scope list says
   fixing the desyncs this makes visible is somebody else's ticket.
2. **Most likely place for a real red: the post-repair window (AC3).** A resync that lands a client
   in a nearly-right state looks perfect on screen and hashes differently. That is exactly what the
   hash is for, and the two re-entries in the #42 block are the hardest thing in the suite.
3. **Second most likely: the `action_*` fields.** `pack_snapshot` includes `action_left/right/up`,
   set from the input frames. They should be identical at the hash point (state after tick `T-1`,
   both clients having applied the same frame for `T-1`), but if a real off-by-one exists between
   when a frame is applied and when the hash is taken, this assertion is the first thing that will
   ever have said so. Again: a finding.
4. **A repair provoked by the AC2 lie could disturb the walk.** Mitigated by lying exactly twice
   and by placing the lie *before* the #42 block, at the calmest point of the walk, with a
   recovery wait between the two. It may well provoke nothing at all — the host's first snapshot is
   two seconds into the match and `desync()` declines to repair before it has one.
5. **Wall-clock budget.** Three new `until` windows add roughly 1–2 s of match each, ~5 s to a walk
   that already runs several seconds. No timeout in the file needs raising (`until` is 10 s).
6. **Low risk:** `framesent` payload parsing. Every frame the transport sends is
   `JSON.stringify`d, so `JSON.parse` on a payload containing `"checksum"` is safe; the
   `includes` pre-filter keeps the hot path off the parser.

---

## 5. Deliberately not doing

- **No production change of any kind.** The seam is the wire, which Playwright already reads — the
  client grows no `window.__*` hook, no export, no debug flag. Flagging this explicitly because the
  issue's framing ("a checksum the client does not expose") invites one; it is not needed.
- **AC2 diverges the reported hash, not the simulation.** Flagged, not dropped. It is the honest
  negative control for the seam the assertion actually reads, and it carries a `ponytail:` comment
  saying so. Diverging the *state* would mean dropping an inbound `input` frame while a key is held
  and then racing the relay's own repair to observe it — more machinery, a timing dependency, and
  `replay.test.mjs:512-519` already asserts the state-to-hash link headlessly. **If the reviewer
  wants the real thing, say so and it becomes a separate deterministic walk, not a bolt-on here.**
- **No third walk for AC3.** The `two_pages` walk already performs two mid-match repairs
  (`Rejoin the match`, `Take seat`). Reusing them is three lines; the socket-drop walk
  (`reconnect()`, line 1576) is one page and cannot compare two simulations, so it is the wrong
  walk to extend.
- **No assertion on every tick.** The client hashes every 30th; anything finer needs a production
  seam. "Several ticks through a match" is satisfied by three windows spanning the match.
- **No change to `snapshot.js`, `room.js` or `server/index.js`** — #41 is shipped and out of scope.
- **No AI-bunny load test** — #52 blocks it and it is out of scope.
- **No fix for anything this makes visible** — each desync gets its own issue.
- **No retries, no `settle()`-based waits, no widened timeouts.**
- **One line outside the test file, flagged for approval:** `CLAUDE.md`'s last paragraph still says
  *"Nor do the two pages agree tick by tick: that needs a checksum the client exposes to a test,
  which it does not (#41)."* AC4 names only `test/browser.test.mjs:1066`, but this sentence becomes
  false with the same commit. Replace it with one sentence saying the two pages are now compared by
  tick-keyed hash read off the wire, sampled three times across a match including after a repair.
  Leaving it would be shipping a known-wrong line of documentation.
