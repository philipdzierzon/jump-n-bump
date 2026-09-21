# Plan — #87: three routing holes (Back out of a match, a room link while seated, the match screen from the lobby)

Repo `philipdzierzon/jump-n-bump`, branch `master` @ `af04c21`.
All three holes are in `apply_route` in `/Users/philipdzierzon/Documents/sbx/jumpnbump/jump-n-bump/src/interaction/viewmodels.js`.

**Headline.** Three holes, **two source files, four small edits** (three in `viewmodels.js`, one
in `game_session.js`). A and C share one flag — `Game_Session.in_match` — so they are not three
independent guards; B is genuinely its own line. Net new production code: ~8 lines plus comments.
Everything else in the change is the test.

---

## 1. What `apply_route` does today

`src/interaction/viewmodels.js:907-934`, verbatim:

```js
907    function apply_route() {
908        var route = screen_of(window.location.hash);
909        if (route.screen !== "play") end_match();
910        if (route.screen === "landing" || route.screen === "browse") leave_room();
911        self.screen(route.screen);
912        if (route.screen === "browse") self.refresh_rooms();
913        if (route.screen === "password" && !self.pending_id()) return go("landing", true);
914        if (route.screen === "room" || route.screen === "play")
915            if (!self.participants().length) {
916                // A reload arrives with the hash and nothing else. The room id and the
917                // token outlived it in `sessionStorage`, so the seats can be reclaimed
918                // rather than asked for again (#7); with neither, the names screen is one
919                // step back rather than a screen with nothing behind it.
920                var last = recall("room").id;
921                if (last && !self.room_id()) return enter(last);
922                return go("names", true);
923            }
924        // A session from the lobby on, so the host's `start` lands on a client that is
925        // already listening for it.
926        // Never on a socket that has gone: the session built here would hold the dead
927        // transport, and the one the reconnect builds would never replace it (#42).
928        if (route.screen === "room" && !self.disconnected()) session();
929        if (route.screen === "play") {
930            if (!self.current_game()) return go("room", true);
931            self.current_game().start();
932        }
933        if (route.room_id) enter(route.room_id);
934    }
```

Branch by branch:

| line | branch | what it does | the hole |
| --- | --- | --- | --- |
| 908 | `screen_of(hash)` (`src/interaction/router.js:11-17`) | Returns `{screen, room_id}`. Seven screen names map to themselves; **anything that normalises to a room id returns `{screen:"join", room_id:id}`** — a room-code hash is a *join route*. Everything else falls back to `landing`. | — |
| 909 | `route.screen !== "play"` → `end_match()` | Tears the local session down: `release_seats()`, `stop()`, board captured, `current_game(null)` (`viewmodels.js:520-545`). Sole caller of `end_match`. | **A**: it never *announces* anything. |
| 910 | `landing`/`browse` → `leave_room()` | `viewmodels.js:424-478`. Sends `{type:"leave"}` (relay `vacate()`s the seats at once, `server/index.js:1134-1137, 497-508`), closes the socket, resets every room observable. | **B**: a `join` route is neither of those two names, so a room-code hash never leaves. |
| 911-913 | screen observable, browse refresh, password fallback | — | — |
| 914-923 | `room`/`play` with an empty couch | Reload recovery: `recall("room").id` from `sessionStorage` → `enter(last)`, else back to `#names`. | — |
| 928 | `room` → `session()` | Builds a `Game_Session` from the lobby on, so the host's `start` lands on a listener (`viewmodels.js:551-625`). | — |
| 929-932 | `play` | Accepted **whenever `current_game()` is truthy**, and line 928 guarantees one from the lobby onward. | **C**: the lobby's own session makes `#play` reachable. `Game_Session.start()` with no `game` built just sets `start_when_ready` (`game_session.js:418-425`) — hence chrome over a blank canvas. |
| 933 | `route.room_id` → `enter(id)` | `viewmodels.js:891-898`. Same room → `go("room", true)`; already-attempted id → `#password`; otherwise `connect({type:"join", …, token: recall(id).token})`. | — |

The counterpart control is `go_lobby` (`viewmodels.js:992-999`):

```js
992    this.go_lobby = function () {
993        // Only the host ends the match for everyone; anybody else is just leaving it, and
994        // their seat goes quiet until the next one (#22).
995        var game = self.current_game();
996        if (host && game && game.game_state() !== Game_State.Not_Started)
997            game.announce_end("lobby");
998        go("room");
999    };
```

bound at `src/jnb.html:116` (`<button class="sm" data-bind="click: go_lobby">Back to the lobby</button>`).
`announce_end` → `Room.end_match` → `{type:"match_end", t, reason, matrix}` → relay `to_lobby()`
(`server/index.js:363-368`) which sets `room.started = false`, resets ready and re-broadcasts.

**So the two paths differ by exactly lines 995-997.** The button announces then routes; the
browser's Back only routes, and routing only calls `end_match`. The one function both should call
is **`end_match`** — it already has the sole-caller position and both operands (`host`, the
session, `played`).

Relevant constants, for B: the reservation window is `reserve_ms()` =
`Number(process.env.RESERVE_MS || 60000)` (`server/index.js:30`), handed to the client on the
handshake and mirrored as `var reserve = 60000` (`viewmodels.js:125`). That 60 s is the "sixty-second
ghost seat".

---

## 2. The change, hole by hole

### Hole A — Back out of a match must say what the button says

**File** `src/interaction/viewmodels.js`, **function** `end_match` (line 520).

Move the announce out of the button and into the one function every way out of a match already
routes through. **It must go above `var reason = ended_because`** — a local room's
`Loopback_Transport` echoes `match_end` back *synchronously* (`src/net/loopback_transport.js:59-63`),
and that echo is what fills `ended_because`/`announced_board`. Announce after the read and the
offline board loses its reason line ("The host ended the match." — asserted at
`test/browser.test.mjs:504-508`).

```js
    function end_match() {
        var game = self.current_game();
        // Only the host ends the match for everyone; anybody else is just leaving it, and
        // their seat goes quiet until the next one (#22). Said here rather than on the
        // button, because the browser's own Back is the same way out of a match: it used to
        // stop the simulation and hand the seats back while the relay went on believing the
        // match was running, so a host pressing Back left everybody else playing a match
        // nothing could end (#87).
        // Above the read below, not beside the button: a local room echoes the announcement
        // back synchronously, and that echo is what names the reason and carries the board.
        if (game && game.in_match && host && game.game_state() !== Game_State.Not_Started)
            game.announce_end("lobby");
        // Read once and forgotten here, before the guard: the reason and the board belong
        // to the match being left, and must not be waiting for the next one.
        var reason = ended_because;
        …unchanged…
```

and the button collapses to a route:

```js
    // Back to the lobby is a route and nothing else: what leaving a match tells the room is
    // `end_match`'s, so this button and the browser's own Back say the same thing (#87).
    this.go_lobby = function () {
        go("room");
    };
```

`game.in_match` is the new term in that guard — see hole C. It is what stops the host announcing
**twice** when the match ended by itself: `on_limit` → `announce_end(reason)` → the broadcast comes
back → `on_match_end` → `to_lobby_soon()` → `go("room")` → `apply_route` → `end_match`. Without the
flag that second pass would announce `"lobby"` over the top of `"time"`/`"bumps"` and break
`self_ending_match()`.

So one more line, in `src/interaction/game_session.js:139`:

```js
    room.on_match_end = function (msg) {
        // Where a session stops being one that is in a match. Every client hears the same
        // message, so this is the one place both readers of the flag agree on: the way out
        // of the match screen, and the announcement that way out makes (#87).
        self.in_match = false;
        if (self.on_match_end) self.on_match_end(msg);
    };
```

This also fixes the same hole on the **landing** route for free (`#play` → `#landing` ran
`end_match` then `leave_room`, so a host walking all the way out stranded the match too). That is
the ponytail root-cause point: `end_match` is the only caller-side chokepoint, and patching only
the path the ticket names would have left the sibling path broken. Grepped callers:
`end_match` — `apply_route:909` only. `announce_end` — `go_lobby:997` and `on_limit:589` only.
`in_match` — `game_session.js:130, 162, 168` only (nothing in `viewmodels.js` reads it today;
`in_match_with` in `viewmodels.js` is a different variable and is not touched).

Ordering is preserved exactly: today `go_lobby` announces, *then* pushes the hash, and `hashchange`
delivers `end_match` a task later. After the change the announce happens at the top of that later
task, still before `release_seats()` / `stop()` and still while `self.screen()` is `"play"`
(line 911 sets the new screen *after* line 909).

### Hole B — a room link while seated must leave the room being left

**File** `src/interaction/viewmodels.js`, **function** `apply_route`, one line after line 910.

```js
        if (route.screen === "landing" || route.screen === "browse") leave_room();
        // A room-code hash is a join route, not one of the two screen names above, so
        // following somebody else's link while seated used to leave the old room holding an
        // empty bunny for the whole reservation window -- a seat and a countdown blocked for
        // everybody still in it (#87). The room being joined is not one to leave: `enter`
        // below answers that with the lobby.
        if (route.room_id && self.room_id() && route.room_id !== self.room_id()) leave_room();
```

Three terms, all load-bearing:

- `route.room_id` — only a code hash, never the bare `#join` typing screen.
- `self.room_id()` — only when a relay room is actually held. Without it, a **cold load** on
  `/#ABCDE` would run `leave_room()`, whose last line is `remember("room", {id: null})`, erasing
  the `sessionStorage` breadcrumb the `#room`/`#play` reload path reads at line 920. An offline
  couch has no `room_id()` and holds no relay seat, so it needs no leave either.
- `!== self.room_id()` — re-following your *own* link must stay the no-op `enter()` already makes
  of it (`viewmodels.js:893`).

It sits **after** line 909, so a host who follows another room's link mid-match announces the end
*and* frees the seats, in that order, on the socket that is about to close. `leave_room()` nulls
`room_id`/`pending_id`/`attempted_id`, so `enter(route.room_id)` at line 933 takes the plain
`connect` path.

### Hole C — the match screen only when a match is running

**File** `src/interaction/viewmodels.js`, **function** `apply_route`, lines 929-932.

The condition is `!self.current_game()`; a session exists from the lobby on (line 928), so it has
never meant "a match is running". The flag that does is **`Game_Session.in_match`**
(`game_session.js:130`, set at `:168`, and now cleared at `:139` by hole A's edit) — "whether a
`start` has landed on this session", which is the relay's own definition of being in the match.

```js
        if (route.screen === "play") {
            // A session exists from the lobby on (line above), so "there is a game" never
            // meant "a match is running": `in_match` is a `start` having landed on this
            // session and not yet ended (#40, #87). Without it the lobby's own session made
            // the match screen reachable, and it drew a clock, a Scores button and a Back
            // link over a blank canvas.
            if (!self.current_game() || !self.current_game().in_match) return go("room", true);
            self.current_game().start();
        }
```

Why `in_match` and not `self.match_running()`: `match_running` is the *room's* answer, set from
`msg.started` in `apply_room` (`viewmodels.js:668`). It is permanently `false` in a local room
(nothing broadcasts `room` over the loopback), so offline play would never reach `#play`; and it is
`true` for a client sitting in the lobby watching somebody else's match, which is precisely a
client that must *not* be routed into it.

`in_match` is set **before** the level fetch (`game_session.js:158-168`), deliberately, so the
window where a route to `#play` lands while the `.dat` is still downloading still passes the guard
and still parks in `start_when_ready` (`game_session.js:418-425`). Keep that branch — hole C's fix
is what makes it the *only* way `start()` is ever called without a `game`.

`go("room", true)` **replaces** rather than pushes; that is what keeps Back from ping-ponging
between `#play` and `#room`, and the test below asserts it.

### Is there one guard that fixes more than one?

Half. **A and C share `in_match`** and the edit that gives it its second half (clearing it on
`match_end`) is what makes A safe against a double announce — so they are one idea in two places,
not two. **B is genuinely separate**: it is about `leave_room`, a different function, a different
message on the wire, and no flag in common. Three holes, four edits, two files.

### `ponytail:` comments warranted

One, on hole B's line, if the implementer wants it — the guard is a *route* test, not a
*room-identity* test:

```js
// ponytail: leaves on a route that names another room, which is the only way into another
// room the app generates (#8). upgrade path: leave in `enter()` instead, if a second entry
// point onto a room id ever appears.
```

Nothing else here cuts a corner with a ceiling. A and C are plain fixes; do not decorate them.

---

## 3. Tests

**Everything new goes in `test/browser.test.mjs`.** `test/router.test.mjs` covers `screen_of`, which
does not change. `test/replay.test.mjs` and `test/relay.test.mjs` are untouched — the relay's half
of reservation and AI takeover is already `relay.test.mjs`'s (#42) and stays there.

The suite has **no reload, no Back and no Forward anywhere** today (`grep -n 'goBack\|goForward\|reload(' test/browser.test.mjs` → nothing). This is new ground, so first the mechanics.

### How Back / Forward / reload behave against this app

- The app is **hash-routed**. `page.goBack()` / `page.goForward()` across two hashes of one
  document are *same-document* navigations: no reload, the Knockout `ViewModel` instance survives,
  and the only thing that runs is the `hashchange` listener at `viewmodels.js:936` → `apply_route`.
  So Back/Forward test `apply_route` in isolation, with every observable, the socket and the
  session still live. That is exactly where all three holes are.
- **`page.reload()` is a different animal.** The document is destroyed: the bundle is re-evaluated,
  `ko.applyBindings(new ViewModel())` runs again at module scope (`viewmodels.js:1218`), and
  `apply_route()` runs once at the bottom of the constructor (`:1215`). What survives:
  - the **hash** (the URL is what is reloaded);
  - **`sessionStorage`**: `jnb:room` → `{id}`, and `jnb:<ROOMID>` → `{token, schemes}`
    (`viewmodels.js:59-77`). That is the whole of it, and it is what lines 920-921 read.
  What does **not** survive: the `WebSocket` (the relay sees a real disconnect), `granted`, the
  `participants` couch, `current_game`, `board`, `config`, `in_match_with`, `attempted_id`, and the
  init-script recorders (`window.__routes`, `window.__sounds` — they come back empty, which is
  useful: a post-reload route list starts at zero).
- Consequence worth writing into the test's comment: **reload at `#play` never lands directly on
  `#play`.** It goes `#play` → (empty couch, line 920) `enter(recall("room").id)` → `joined` →
  `go("room", true)` → `#room` → `session()` → `ask_to_resume()` → relay `start` →
  `on_match_start` → `go("play")`. Two hash entries, in that order, every time.

### Helpers to add (3 lines) and one helper to move

```js
const hash = (root = page) => root.evaluate(() => window.location.hash);
const routes = (root = page) => root.evaluate(() => window.__routes || []);
const last_room = (seen) => seen.filter((msg) => msg.type === "room").pop();
```

and **move the `window.__routes` init script from `page.addInitScript(...)`
(`test/browser.test.mjs:127-154`) into `make_context()` beside `record_audio`** — same lines, no
new ones, and every context then records its routes, which is what makes the bounce assertions
below readable and what makes the failure dump useful for the new pages.

Also: the suite is out of room ids. Replace the nine stacked `generate_room_id({...})` literals
(`test/browser.test.mjs:46-83`, ~40 lines) with

```js
const taken = {};
const new_room_id = () => {
    const id = generate_room_id(taken);
    taken[id] = true;
    return id;
};
const room_a = new_room_id();  // … through room_l
```

Net deletion, and the walk needs three more ids (`room_j`, `room_k`, `room_l`).

### The walks

One new section, `// --- Back, Forward and reload (#87) ---`, three functions, each its own
context (a context is its own `sessionStorage`, which a reload test depends on). Call them from the
runner (`test/browser.test.mjs:1681-1689`) after `reconnect()`.

#### `history_host_back()` — point A, host half, plus C's Forward

Setup: the **page hosts** `room_j`; a node `relay_client` is a second seated, ready client so the
room outlives the page and so every assertion reads the relay's own messages rather than the DOM.

```js
const seen = [];
const mate = relay_client({ type: "join", id: room_j }, seen);
… mate.send({ type: "seats", names: ["Ghost"] });
… mate.send({ type: "ready", ready: true });     // all_ready(), so Start begins at once (server/index.js:1062)
await click("Start the match", hpage);
await on("play", hpage);
await until("the relay to run the match", () => seen.some((m) => m.type === "start"));

await hpage.goBack();                            // #play -> #room
await on("room", hpage);
await until("the room to hear the match end", () =>
    seen.some((m) => m.type === "match_end" && m.reason === "lobby"));
assert.equal(last_room(seen).started, false,
    "browser Back out of a live match ends it for the room, exactly as the button does (#87)");
```

| assertion | why it cannot flake |
| --- | --- |
| `match_end` with `reason:"lobby"` reaches the node client | `until()` polls an append-only array of relay messages for something that **must** arrive. No fixed wait, no ordering assumption between two sockets. |
| `last_room(seen).started === false` | Read *after* the `match_end` has been seen; `to_lobby()` sets `started=false` and `broadcast_state()`s in the same synchronous relay call, so the `room` that follows the `match_end` on one socket is ordered behind it. |

Then Forward, which is hole C proving itself — the match is over, so `#play` must bounce:

```js
const before = (await routes(hpage)).length;
await hpage.goForward();                         // #room -> #play
await until("the match screen to bounce back to the lobby",
    async () => (await routes(hpage)).length >= before + 2);
const walked = (await routes(hpage)).slice(before);
assert.ok(walked[0].startsWith("#play"), "Forward really re-entered the match route");
assert.equal(await hash(hpage), "#room",
    "and a match that is over is not a match screen you can reach (#87)");
assert.ok(!(await screen("play", hpage).isVisible()), "no chrome over a blank canvas");
```

Deterministic because `__routes` is append-only and the bounce is exactly two `hashchange`s
(`#play`, then the `location.replace("#room")`). **No bare `settle()`, and no assertion that reads
`"#room"` before the navigation has happened** — the length wait is what rules out a vacuous pass,
which a plain `hash === "#room"` check would risk (it is already `#room` going in).

Then Back once more, which guards the `replace`:

```js
await hpage.goBack();
await on("room", hpage);
assert.equal(await hash(hpage), "#room",
    "the bounce replaced rather than pushed, so Back does not walk into it again (#87)");
```

Then reload, at `#room`, with no match running — the cheap half of the reload story:

```js
await hpage.reload();
await on("room", hpage);
assert.deepEqual(await room_view(hpage), room_before,
    "a reload reclaims the seats from the token in sessionStorage and nothing else (#7)");
```

`on()` waits for both the screen div and the hash, and `room_view` is a Knockout-rendered list that
Playwright's locator retries until it matches. No sleeps anywhere.

#### `history_reload_in_match()` — point A, non-host half, and the reload under a live match

Setup copies `reconnect()` (`test/browser.test.mjs:1592-1623`): a node `relay_client` **hosts**
`room_k`, the page joins, readies, the node sends `start`. One addition:

```js
// Snapshotted on a loop rather than once, because a reload's `resync` is answered by the
// relay's *next* snapshot when it lands before one exists (server/index.js:757-760): the
// loop is what makes "the page gets back into the match" a fact rather than a race between
// two sockets.
const snapshots = setInterval(() => boss.send({
    type: "snapshot", t: 0, matrix: new Array(16).fill(0),
    body: encode_snapshot(new Int32Array(SNAPSHOT_INTS)),
}), 200);
```

(cleared in the function's tail, before `boss.close()`.)

Reload:

```js
await page2.reload();
await until("the page back into the match it reloaded out of", async () => {
    const walked = await routes(page2);        // reset by the reload
    return walked.length >= 2 && (await hash(page2)) === "#play";
});
await on("play", page2);
assert.equal(last_room(boss_saw).seats[1], "Dott",
    "a reload is a disconnect, and the seat was reserved for the token it came back with (#42)");
assert.ok(!boss_saw.some((m) => m.type === "match_end"),
    "and nothing ended the match on the room's behalf");
```

The `walked.length >= 2` clause is what makes `hash === "#play"` honest: the page passes *through*
`#room` on the way, so a bare `#play` check could pass on the hash it started with, before the
document was even replaced.

Then the non-host half of AC1 — Back out of a match this page does not host:

```js
const seats_before = boss_saw.length;
await page2.goBack();                            // #play -> #room
await on("room", page2);
await until("the seat handed to the AI", () =>
    boss_saw.slice(seats_before).some((m) => m.type === "driver" && m.driver === "ai"));
assert.ok(!boss_saw.some((m) => m.type === "match_end"),
    "a non-host leaving the match does not end it for everybody else (#22, #87)");
assert.equal(last_room(boss_saw).started, true, "the room is still playing it");
```

**The negative is made deterministic by ordering, not by a timer**: the `driver:"ai"` stamp is sent
by `release_seats()` in the *same* `end_match` call that would have announced the end, and it is
waited for first. If the announce had happened it would already be in `boss_saw` by the time the
driver stamp is. No `settle()`, no sleep.

Finally Forward, which must bounce — the page left the match, so its new lobby session has
`in_match === false`:

```js
const n = (await routes(page2)).length;
await page2.goForward();
await until("the bounce", async () => (await routes(page2)).length >= n + 2);
assert.equal(await hash(page2), "#room",
    "Forward does not walk a client back into a match it left (#37, #87)");
```

That is also the browser-navigation twin of the existing assertion at
`test/browser.test.mjs:960-970` ("a client that left the match stays left").

#### `history_link_while_seated()` — point B

Setup: node client hosts `room_l` and sits down (so the room survives and its `room` messages are
readable); a second node client hosts `room_j2`… — or reuse the already-open `room_j`. Simplest:
two node-hosted rooms, `room_l` (the one being left) and a second id, and one page.

```js
// Seated in the first room.
…join room_l through the UI, Take the seats, on("room")…
await until("the room to seat the page", () => last_room(left_saw).seats.includes("Dott"));

// The link to the other room, as a player follows one: a fragment navigation in the page
// it is already on, not a fresh load -- a fresh load is the reload case below.
await page3.evaluate((id) => (window.location.hash = id), room_m);

await until("the abandoned room to free the seat at once", () =>
    last_room(left_saw).seats.every((name) => name !== "Dott"));
```

That `until()` is the whole of AC2 and it is the deterministic form of "immediately rather than on
reservation expiry": its ceiling is `200 × 50 ms = 10 s` (`test/browser.test.mjs:187-193`), a sixth
of `reserve_ms()`'s 60 s default, so a pass means the `{type:"leave"}` really was sent and a
regression times out rather than sitting through the window. **The test does not touch
`RESERVE_MS`** and must not: the margin is the assertion.

Then finish the join and walk the three navigations:

```js
await on("names", page3);                       // the new room grants nothing yet
await page3.keyboard.press("ArrowUp");
await click("Take the seats", page3);
await on("room", page3);                        // history: … #room(l) , #names , #room(m)

await page3.goBack();
await on("names", page3);                       // a couch with participants renders as itself
await page3.goForward();
await on("room", page3);
assert.deepEqual(await room_view(page3), view_before, "and Forward comes back to the same room");

await page3.reload();
await on("room", page3);
assert.equal(await hash(page3), "#room");
assert.deepEqual(await room_view(page3), view_before,
    "a reload reclaims the new room's seat from its own token (#7)");
assert.ok(last_room(left_saw).seats.every((name) => name !== "Dott"),
    "and the room that was left never gets it back (#87)");
```

`on(name)` already waits for the screen div *and* the hash, which is the right pair for a
hash-routed app: a `hashchange` that Knockout has not repainted yet fails the first half.

### Flakiness — how each new assertion is made deterministic

This repo has **no retries, by design** (`CLAUDE.md`: "the simulation is seeded, so a flake is a
real race worth a bug rather than a rerun"). Rules the new walks follow:

1. **Every wait is a wait-for-a-fact**, either `until()` on an append-only array of relay messages,
   or a Playwright locator/`waitForFunction`. No new `settle()` anywhere.
2. **Every "did not happen" is ordered behind a "did happen"** on the same code path (the
   `driver:"ai"` trick above), never behind a sleep.
3. **Every hash assertion that could pass vacuously is gated on `__routes` growing** by the exact
   number of `hashchange`s the path produces.
4. **The relay is the witness, not the DOM**, wherever the claim is about the room. `started`,
   `seats`, `match_end` and `driver` all arrive on the node client's socket; none of them depends
   on Knockout having repainted.
5. **The host snapshots on an interval** in the reload walk, so `resync` is answered whenever it
   arrives rather than only if it arrives after a one-shot snapshot.
6. **No assertion on elapsed time**, on the reconnect backoff schedule (1/2/4/5 s), on the
   substituted/late/forged counters, or on whether the AI held the seat in the gap.

### Collision with #42's reconnect / repair path

Yes, and it is the reason the reload walk is written the way it is. **A reload is a disconnect to
the relay**: the socket goes, `leave(client)` runs (`server/index.js:565-612`), the seats are
reserved for the token for `reserve_ms()`, the relay substitutes a released frame each tick and
hands the seat to the AI after thirty missing ones, and `away_host` is remembered if that client
hosted. Everything the returning page then does — `enter()` with the stored token, `admit()`
re-stamping `"local"` on the reclaimed seats (`server/index.js:426`), `ask_to_resume()` →
`resume()` — is #42's machinery, and #42 is **out of scope for this issue**.

So the test asserts only the two ends and nothing in between:

- **Before**: the page is on `#play` in a match the node host is running.
- **After**: the page is on `#play`, the room still names its seat, and the host never saw a
  `match_end`.

It does **not** assert the `Connection lost` overlay (a reload destroys the page, so no overlay is
ever painted — that is the difference from `reconnect()`, and it is worth one comment line), nor
the driver the seat had while the page was gone, nor how many frames were substituted, nor how long
the round trip took. Those are races by nature and they belong to `relay.test.mjs`, which already
owns them.

One residual environment risk to name in the plan and not defend against: if CI ever sets
`RESERVE_MS` below a couple of seconds, the reload-into-a-match walk breaks, because the seat would
expire before the page came back. Leave it at the default; if it ever bites, the fix is for the
walk to boot its own server, not for the walk to sleep less.

---

## 4. Risks

- **Double announce on a race.** If a host presses Back in the gap between `on_limit` firing
  `announce_end("time")` and that broadcast coming back, `in_match` is still `true` and a second
  `match_end` goes out. The relay's `to_lobby()` re-broadcasts and re-resets ready; harmless and
  already possible today by other means. Not worth a second flag.
- **`end_match` now has a side effect on the wire.** It is called from one place
  (`apply_route:909`) on every non-`play` route, so the guard `game.in_match && host && played` is
  doing real work. Anyone adding a second caller must read those three terms first; the comment
  says so.
- **Existing walks that navigate.** Six places click "Back to the lobby"
  (`test/browser.test.mjs:487, 499, 540, 896, 957, 1043, 1184, 1196, 1213, 1333, 1366, 1655, 1663`).
  All of them keep working: the announce moves one task later and still precedes
  `release_seats()`. The two that assert on the *reason* — offline "The host ended the match."
  (`:504-508`) and the two-page host ending it (`:1213-1217`) — are the ones the
  announce-above-the-read ordering protects. Run them first.
- **`two_pages` timing.** The guest's `on("play")` after a rejoin (`:1187`, `:1201`) now passes
  through hole C's guard; `in_match` is set in `room.on_start` *before* the level fetch, and
  `on_match_start` (which routes to `#play`) runs after `build()`, so the flag is always already
  true when the route is applied. No ordering change.
- **`start_when_ready` looks dead after hole C and is not.** It still covers a route to `#play`
  landing while the `.dat` is downloading. Do not delete it.
- **Browser-context count.** Three new contexts means three more Chromium contexts per run and
  three more `trace-*.zip` on failure. Acceptable; the suite already opens eight.

---

## 5. Deliberately not doing

- **Not splitting #87.** Triage offered eleven issues out of §6 and the maintainer declined.
- **Not saying *why* the player ended up somewhere.** No "The host ended the match" / "You left
  room X" copy on any of these three paths — that is #88 and is out of scope.
- **Not touching seat reservation or AI takeover.** `reserve_ms`, the thirty-tick handover, the
  released-frame substitution and the backoff schedule are #42's and stay as they are; the tests
  assert around them, never on them.
- **Not replacing the "Back to the lobby" `<button>` with `<a href="#room">`.** Tempting — the
  browser's own navigation *is* the control, which is the issue's whole thesis — but it breaks the
  `button:visible` locator in thirteen existing assertions for no behavioural gain.
- **Not leaving the room on the bare `#join` typing screen.** A player who opens the code box while
  seated has not gone anywhere yet; AC2 is about following a *link*.
- **Not gating `#play` on `match_running()`.** It is the room's flag, false offline and true for a
  lobby spectator — wrong in both directions.
- **Not adding retries, a `settle()` or a `waitForTimeout` to the new walks.** See §3.
- **Not adding a `router.test.mjs` case.** `screen_of` is unchanged; there is nothing pure to test.
- **Nothing flagged as "should not be built".** All four acceptance criteria are buildable as
  written and none of them over-reaches. The one place AC4 is thinner than it reads is that at
  point C the Back and Forward legs are partly no-ops over a `location.replace`; they are kept
  anyway, because the assertion that Back does *not* re-enter `#play` is exactly what pins the
  `replace` down.
