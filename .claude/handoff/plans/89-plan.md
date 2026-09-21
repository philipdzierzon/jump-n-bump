# Plan — #89 Connect and Rejoin have no in-flight state, and can silently do nothing

Repo: `philipdzierzon/jump-n-bump`, branch `master` @ `af04c21`.
All line numbers are against that commit. Nothing in `server/` changes.

---

## 1. What the code does today

### A — the connect path

`connect(entry)` is the only thing in the client that opens a socket
(`src/interaction/viewmodels.js:748`):

```js
    function connect(entry) {
        self.error("");
        // Which build of the simulation this page is running. [...]
        entry.build = BUILD;

        var leaving = transport;
        var socket = new WebSocket_Transport(
            relay_url(),
            entry,
```

**Every caller** (`grep -n "connect(" src/interaction/viewmodels.js`):

| line | caller | reached from |
| --- | --- | --- |
| 1011 | `this.create_room` | **Create** button, `src/jnb.html:152` |
| 1021 | `this.submit_password` | **Continue** on the password screen, `src/jnb.html:173` |
| 1077 | `this.take_seats` (`if (quick)`) | **Take the seats**, `src/jnb.html:191` — this is Quick Join's socket |
| 900 | `enter(id)` | hash route / Browse row / **Continue** on the join screen |
| 861 | `retry()` | the #42 reconnect timer |

There is **no pending guard anywhere in that function**, and none of the three submit
buttons carries an `enable` binding:

```html
        <button class="pri" data-bind="click: create_room">Create</button>                          <!-- jnb.html:152 -->
        <button class="pri" data-bind="click: submit_password">Continue</button>                    <!-- jnb.html:173 -->
        <button class="pri" data-bind="click: take_seats, enable: participants().length > 0, text: seated() ? 'Back to the lobby' : 'Take the seats'"></button>  <!-- jnb.html:191 -->
```

Note the landing screen's `Quick Join` (`jnb.html:138`, `click: go_quick`) opens **no**
socket — it calls `leave_room()` and routes to `#names`. Quick Join's socket is opened by
**Take the seats** one screen later. That is the button that needs the binding.

**What the second click does.** Click 1 builds socket A; `transport` is still the
`Loopback_Transport`, because `transport = socket` only happens when `joined` lands
(line 763). Click 2 builds socket B, capturing `var leaving = transport` — still the
loopback. A's `joined` arrives first: closes the loopback, `transport = A`. B's `joined`
arrives next: closes the loopback again (a no-op) and sets `transport = B`.

**Socket A is now referenced by nothing and is never closed.** It is not dropped by
`leaving.close()` (that closed the loopback), and the only other guard is a read-only
early return in the message callback:

```js
                } else if (transport !== socket) return;            // viewmodels.js:782
```

Meanwhile `WebSocket_Transport` answers the relay's keepalive with no idea whether it is
still the active transport (`src/net/websocket_transport.js:20-27`):

```js
    socket.onmessage = function (event) {
        var msg = JSON.parse(event.data);
        switch (msg.type) {
            case "ping":
                // Echoed with the relay's own timestamp [...]
                socket.send(JSON.stringify({ type: "pong", at: msg.at }));
                break;
```

So the orphan stays open and healthy for as long as the tab does. On the relay
(`server/index.js`):

- `create` with a blank id generates a **fresh** id each time (`server/index.js:108`),
  so two clicks on Create with no code make **two rooms**, not an `ID_TAKEN`;
- the room is put in `rooms` with `listed: !!msg.listed` (`server/index.js:172`) and
  `/api/rooms` lists every `room.listed` (`server/index.js:1190, 1209`);
- Quick Join's `best_room` picks from the same listed set (`server/index.js:246-262`), so
  an orphan is not only visible, it is *preferred* — it has four free seats;
- `listing()` reads the host name off a client holding a seat, and the orphan's client
  holds none, so the row reads `""  ABCDE  0/4  in the lobby`;
- and the room only dies with its last client:

```js
function leave(client) {                                            // server/index.js:565
    const room = client.room;
    if (!room) return;
    room.clients.delete(client);
    // The room dies with its last client, not with its creator [...]
    if (!room.clients.size) {
        report_match(room);
        delete rooms[room.id];
```

That last one matters: **closing the superseded socket is enough**. No relay change is
needed for AC2 — the orphan room is deleted the moment its one socket goes.

(With a *typed* code the second click is refused `ID_TAKEN` and the player sees "That code
is taken." instead of an orphan. The orphan is the blank-code path, which is also the Quick
Join path — `quick_join` falls back to `create(client, { ...msg, id: "", listed: true })`,
`server/index.js:277`.)

### B — the rejoin

The in-flight flag is a plain `var` at `src/interaction/viewmodels.js:101`:

```js
    var resuming = false;
    var in_match_with = "";
```

Set in exactly one place (`ask_to_resume`, viewmodels.js:646):

```js
    function ask_to_resume() {
        var current = self.current_game();
        if (resuming || !self.match_running() || !granted().length) return;
        if (granted().join(",") === in_match_with) return;
        if (!current) return;
        resuming = true;
        current.resume();
    }
```

`current.resume()` → `room.request_resume()` → `transport.send({ type: "resync" })`
(`src/net/room.js:203`). Cleared on three paths, none of which is a failure:

- `leave_room()` — viewmodels.js:475
- `game.on_match_start` — viewmodels.js:604 (the success path)
- `apply_room` when the room says the match is over — viewmodels.js:672
- (`lost_connection()` — viewmodels.js:889 — a fourth, same shape)

**Leak 1 — the builder's early return.** `src/interaction/game_session.js:245-253`:

```js
    function build(level) {
        // Two ways a match already running cannot be joined: a body that does not decode,
        // and a gap too big to replay. [...]
        var t0 = performance.now();
        var resumed = room.resume ? decode_snapshot(room.resume) : null;
        var gap = room.gap();
        if (room.resume && (!resumed || gap > MAX_CATCH_UP)) return;
```

That `return` is *above* the only caller of `on_match_start`
(`game_session.js:293`, `if (self.on_match_start) self.on_match_start();`), which is where
`resuming = false` lives. `decode_snapshot` returns `null` rather than throwing
(`src/game/snapshot.js:132-140`), so this is a silent return.

**Leak 2 — the swallowed level fetch.** `src/interaction/game_session.js:189-191`:

```js
        get_level(room.settings.level).then(function (level) {
            if (mine === starting) build(level);
        }, noop);
```

`noop` is `function noop() {}` at `game_session.js:22` and is used nowhere else.

**No timeout.** The relay answers a `resync` on the host's *next* snapshot if it has none
yet (`server/index.js:1151` sets `client.waiting = true`; `server/index.js:760` answers it
when a snapshot lands), and silently drops the ask altogether for a client it gave up
repairing (`server/index.js:776`, `if (client.dropped) return void (client.waiting = false)`).
Either way nothing ever comes back, and the button
(`jnb.html:222`, `click: rejoin_match`) is a no-op for the rest of the match:

```js
    this.rejoin_match = function () {                               // viewmodels.js:1109
        in_match_with = "";
        ask_to_resume();
    };
```

**Existing timeout idiom** (`grep -n setTimeout src/interaction/`): `viewmodels.js:857`
(`reconnect_timer`, armed in `retry()`, cleared in `leave_room`/`lost_connection`/on join)
and `viewmodels.js:534` (`leaving`/`HOLD_MS`). Both are `var X_MS`, `var x_timer = null`,
`clearTimeout` at every exit. Copy that; do not invent anything.

**Error surface already exists.** The lobby screen already renders `error`
(`jnb.html:260`, `<p class="err" data-bind="text: error"></p>`). AC3 needs **no new
markup** — which keeps it clear of #88.

---

## 2. The change, item by item

### A1 — one guard, in the shared function (`src/interaction/viewmodels.js`)

One guard in `connect()` covers Create, Password, Quick Join, `enter()` **and** `retry()`.
Three guards at the call sites would leave `enter()` — the Browse row and the hash route —
still able to orphan a socket.

It **supersedes rather than refuses**: refusing would let one stuck `CONNECTING` socket
freeze the #42 reconnect, which calls the same function off a timer.

Add beside the other observables (after `viewmodels.js:136`, `this.error = ko.observable("")`):

```js
    // A connection attempt in flight, which is all three submit buttons' enabled state:
    // nothing visibly changed on the first click, so the player clicked again and got a
    // second socket (#89).
    this.connecting = ko.observable(false);
```

Add immediately above `function connect(entry)` (viewmodels.js:748):

```js
    // The attempt that has not answered yet. A second one supersedes it rather than racing
    // it: an abandoned socket goes on ponging the relay whether or not it is still the
    // transport, so the room it created stays up -- in the public list, with a host that
    // never leaves, and picked first by Quick Join for having four free seats (#89).
    // ponytail: a socket that neither opens nor closes leaves the buttons disabled until
    // the browser gives up on it. upgrade path: a bound of its own if anybody ever sees
    // one -- the page is served by the relay it dials, so an unreachable relay is a page
    // that never loaded.
    var pending = null;
```

Then, inside `connect`:

```js
    function connect(entry) {
        if (pending) pending.close();
        self.connecting(true);
        self.error("");
```

and after the `var socket = new WebSocket_Transport(...)` statement closes (viewmodels.js:770):

```js
        pending = socket;
    }
```

Settle it on both answers. In the room callback, first thing inside the `joined` branch
(viewmodels.js:761):

```js
                if (msg.type === "joined") {
                    pending = null;
                    self.connecting(false);
                    // Only once the new room is in: a refused join leaves this client in the
```

and at the top of the error callback (viewmodels.js:796), **before** the retry early return,
so a reconnect attempt that fails always re-arms:

```js
            function (code) {
                if (pending === socket) {
                    pending = null;
                    self.connecting(false);
                }
                // A retry that did not get in -- the socket died again, or the room would
```

`WebSocket_Transport.close()` nulls `onclose` before closing
(`src/net/websocket_transport.js:65-68`), so a superseded socket cannot fire a spurious
`DISCONNECTED`; the `pending === socket` guard is belt and braces.

### A2 — the enable bindings (`src/jnb.html`, Prettier-ignored, hand-formatted)

Three one-attribute edits. `&&` is written `&amp;&amp;` in this file (lines 220, 223, 225).

Line 152:
```html
        <button class="pri" data-bind="click: create_room, enable: !connecting()">Create</button>
```

Line 173:
```html
        <button class="pri" data-bind="click: submit_password, enable: !connecting()">Continue</button>
```

Line 191:
```html
        <button class="pri" data-bind="click: take_seats, enable: participants().length > 0 &amp;&amp; !connecting(), text: seated() ? 'Back to the lobby' : 'Take the seats'"></button>
```

Knockout's `enable` binding writes `element.disabled` synchronously on the observable
write (no `ko.options.deferUpdates` anywhere in `src/`), so the button is disabled before
the first click handler returns and the browser suppresses the second click on it.

### B1 — bound the ask, and make the two failures reach it (`src/interaction/viewmodels.js`)

Beside `var resuming = false;` (viewmodels.js:101):

```js
    // How long the ask is given before it is called a failure. The relay answers on the
    // host's next snapshot, which is two seconds away at worst, and the level was preloaded
    // in the lobby -- so past this it is an answer that is not coming rather than a slow one.
    // ponytail: one fixed ceiling. upgrade path: none while the snapshot interval is the
    // only thing it waits on.
    var RESUME_MS = 5000;
    var resume_timer = null;
```

Arm it in `ask_to_resume` (viewmodels.js:651):

```js
        resuming = true;
        resume_timer = setTimeout(resume_failed, RESUME_MS);
        current.resume();
    }

    // One place the ask stops being in flight, because the timer bounding it has to stop
    // with it: one left running would call the *next* ask a failure.
    function stop_resuming() {
        clearTimeout(resume_timer);
        resume_timer = null;
        resuming = false;
    }

    // It neither landed nor came back. Nothing else clears the flag, and a Rejoin button
    // that silently does nothing for the rest of the match is what that used to mean (#89).
    function resume_failed() {
        if (!resuming) return;
        stop_resuming();
        self.error("Getting back into the match did not work. Try again.");
    }
```

Replace the four bare clears with `stop_resuming();` — viewmodels.js **475**, **604**,
**672**, **889** (each currently `resuming = false;`, leave the `in_match_with = "";`
beside it alone).

Wire the failure hook in `session()`, after the `game.on_match_start = ...` block
(viewmodels.js:~620):

```js
        // A `start` that never became a match. A client that asked to be let into this one
        // is waiting on exactly this answer, and there is no second telling (#89).
        game.on_start_failed = resume_failed;
```

Clear the message on a fresh press (viewmodels.js:1109), matching `take_seat`/`go_create`:

```js
    this.rejoin_match = function () {
        self.error("");
        in_match_with = "";
        ask_to_resume();
    };
```

### B2 — surface the two failures (`src/interaction/game_session.js`)

Beside `this.on_match_start = null;` (game_session.js:127):

```js
    this.on_start_failed = null;
```

Above `room.on_start` (game_session.js:~157):

```js
    // A `start` that never became a match: the level would not load, or the state it
    // carried could not be replayed. Both were silent, and a client that had asked to be
    // let into this match was waiting on exactly this answer (#89).
    function start_failed() {
        if (self.on_start_failed) self.on_start_failed();
    }
```

Replace the swallowed rejection (game_session.js:189-191):

```js
        get_level(room.settings.level).then(
            function (level) {
                if (mine === starting) build(level);
            },
            function () {
                if (mine === starting) start_failed();
            },
        );
```

Replace the early return (game_session.js:253):

```js
        if (room.resume && (!resumed || gap > MAX_CATCH_UP)) return start_failed();
```

**Delete** `function noop() {}` (game_session.js:22) — that was its only use.

`get_level` already puts its own words on screen for a failed fetch
(viewmodels.js:257, "That level would not load. Ask the host for another one."), so the
fetch case says *why*; `resume_failed` adds the rejoin's own line and, more to the point,
un-latches the button. Nothing here touches `self.in_match`, which belongs to #41/#42.

---

## 3. Tests — all in `test/browser.test.mjs`

Add `room_j` to the generated-id chain at the top (same nested-object idiom as `room_i`).
Register both walks in the `--- run ---` block after `queueing()`.

### T1 — AC6: a double-click on Create makes one room

Observable: **the public room list**, diffed rather than counted, because earlier walks
leave listed rooms up. (`page.on("websocket")`'s socket counter is module-global and shared
by every walk; the relay's `room %s created` stdout is not captured by this harness.)

```js
// One click, one room (#89). The connect path had no in-flight state and the button no
// enable binding, so a second click opened a second socket -- and the abandoned one went
// on answering the relay's pings, holding a room up in the public list with a host that
// would never leave.
async function double_click_create() {
    const dbl = await (await make_context("double")).newPage();
    const listed = async () =>
        (await fetch(origin + "/api/rooms").then((res) => res.json())).map((room) => room.id);
    await dbl.goto(origin + "/");
    const before = await listed();
    await click("Create a room", dbl);
    await on("create", dbl);
    // Listed, because the public list is where the orphan showed up. And no code typed:
    // the relay generates one per create, so two clicks with a code of their own would
    // collide on the second rather than make a second room.
    await screen("create", dbl).locator('input[type="checkbox"]').setChecked(true);
    // Not two clicks: the second would fail Playwright's own enabled check and report a
    // timeout instead of the thing under test. A double-click is what a player does, and
    // it is dispatched without re-checking in between -- so the button really is asked
    // twice, and what refuses the second one is the page.
    await button("Create", dbl).dblclick();
    await on("names", dbl);
    // Proving something did not happen, which is the one place a fixed wait is right.
    await settle();
    const after = await listed();
    assert.equal(
        after.filter((id) => before.indexOf(id) < 0).length,
        1,
        "two clicks on Create, one room in the public list",
    );
}
```

Determinism: `dblclick()` runs its actionability check once and then dispatches both
clicks, so it never fails on the disabled state it is testing; the assertion is a set
difference, so rooms left up by other walks cannot affect it; `settle()` (150 ms) is the
file's existing "prove a non-event" tool and the second create would have been answered
within it — the relay is in-process. If a future Playwright re-checks between the two
clicks, swap in two `click({ force: true })` calls, which bypass the check outright.

### T2 — AC3/AC4: a rejoin that fails says so, and works again afterwards

Needs a real host page (only a real client snapshots, and the relay cannot hand back a
match it has no state for) plus a guest whose socket is intercepted. Playwright 1.63 has
`page.routeWebSocket`; the handler runs in node, so the two flags below are read live.

```js
// Rejoining a match that will not have you (#89). The ask set a flag cleared on three
// paths, and a `start` that never became a match is none of them -- so a failed rejoin
// left the button silently doing nothing for the rest of the match.
//
// Two failures, both arranged on the socket: a state that will not decode, which is the
// early return out of `build`, and an ask the relay never hears, which is what the bound
// on it is for. The second really waits that bound out -- there is no clock to wind on a
// page whose match is being played by a real host in real time.
async function rejoin_fails() {
    const host = await (await make_context("rejoin-host")).newPage();
    await host.goto(origin + "/");
    await click("Create a room", host);
    await on("create", host);
    await screen("create", host).locator("input.code").fill(room_j);
    await click("Create", host);
    await on("names", host);
    await host.keyboard.press("ArrowUp");
    await until("the host's participant", async () => (await seats(host).count()) === 1);
    await click("Take the seats", host);
    await on("room", host);
    await click("Start the match", host);
    await on("play", host);

    const guest = await (await make_context("rejoin-guest")).newPage();
    let broken = 0;
    let deaf = false;
    await guest.routeWebSocket(/\/ws/, (ws) => {
        const relay = ws.connectToServer();
        ws.onMessage((frame) => {
            // The ask nothing ever answers and nothing ever fails.
            if (deaf && String(frame).includes('"resync"')) return;
            relay.send(frame);
        });
        relay.onMessage((frame) => {
            const msg = JSON.parse(String(frame));
            // A state `decode_snapshot` answers null for, which is the return out of
            // `build` that happens above `on_match_start`.
            if (msg.type === "start" && msg.snapshot) {
                msg.snapshot = "not a snapshot";
                broken++;
            }
            ws.send(JSON.stringify(msg));
        });
    });
    const said = () => text(screen("room", guest).locator("p.err"));

    await guest.goto(origin + "/#" + room_j);
    await on("names", guest);
    await guest.keyboard.press("ArrowUp");
    await until("the guest's participant", async () => (await seats(guest).count()) === 1);
    await click("Take the seats", guest);
    await on("room", guest);
    // Seated into a match already running, so the page asks to be let into it by itself.
    await until("the relay's answer, broken on the way in", () => broken > 0);
    await until("the failure on screen", async () => /did not work/.test(await said()));
    await on("room", guest);

    // And the ask the relay never hears: nothing answers it and nothing fails it, so the
    // only thing that can end it is the bound the client puts on it.
    deaf = true;
    await click("Rejoin the match", guest);
    assert.equal(await said(), "", "pressing it again clears the last answer");
    await until("the ask to time out", async () => /did not work/.test(await said()));

    // Neither failure latched it: the third press is the one that works.
    deaf = false;
    await click("Rejoin the match", guest);
    await on("play", guest);
}
```

Determinism: phase 1 waits on `broken > 0`, so the assertion cannot pass because the
relay was merely slow; phase 2's bound is a real 5 s timer and `until()` polls for 10 s,
two times the margin, with no race to lose; phase 3 is the recovery, and it is the whole
point of the walk. No retries are needed and none are added.

### Not tested

AC5's *own* path (a level fetch rejecting during a rejoin) is not reachable from a browser
test: `get_level` caches the resolved promise per level name
(`viewmodels.js:245`, `if (!levels[name])`), so a rejoin never refetches and `page.route`
has nothing to abort. The fix ships and is covered through the same `on_start_failed` hook
T2 exercises. Flagged below.

---

## 4. Risks

- **The #42 reconnect shares `connect()`.** The guard supersedes rather than refuses,
  precisely so `retry()` can always make another attempt; and the error callback clears
  `connecting` *before* its `return retry()`. Still: run the `reconnect()` walk and watch
  that the page comes back on the first retry a second later, exactly as
  `CLAUDE.md` describes.
- **`page.routeWebSocket` proxies every frame through the driver process.** A page playing
  a 60 Hz lockstep match through it is slower than one that is not, and a chronically late
  client can be repaired or, past the relay's repair allowance, marked `dropped`
  (`server/index.js:776`). T2's guest plays only after both failures and only long enough
  to reach `#play`, which keeps the exposure to a second or two. This is the walk's main
  flakiness risk; if it does flake, drop phase 3 and assert the cleared flag by pressing
  Rejoin a third time with `deaf` still true and watching the error come back a second time.
- **Existing walks that create rooms** (`walk`, `two_pages`, `browse`, `queueing`) leave
  listed rooms up. T1 diffs the list before and after, so they cannot make it fail; do not
  "simplify" it into a count.
- **`dblclick` semantics.** If Playwright ever starts re-checking actionability between the
  two clicks, T1 fails as a timeout rather than an assertion — the fallback is two
  `click({ force: true })` calls.
- **A stuck `CONNECTING` socket** now disables the three buttons until the browser gives up
  on it. Named in a `ponytail:` comment rather than fixed: the page is served by the relay
  it dials.

---

## 5. Deliberately not doing

- **No relay change.** A room dies with its last client (`server/index.js:568-574`), so
  closing the superseded socket is the whole of "no orphan room reaches the public list";
  an idle-room reaper belongs to abuse (#47).
- **No enable binding on the join screen's Continue** (`jnb.html:161`): it opens no socket,
  it routes, and the ACs name three controls. Its own oddity — a second click lands on the
  password screen early — is not this issue's.
- **No "Connecting…" copy on the create screen**, though `jnb.html:159` has the idiom: the
  greyed button *is* the visible in-flight state, and status copy is #88's, which lands
  earlier in this stack.
- **No new error markup.** The lobby already renders `error` (`jnb.html:260`); AC3's one
  new string lives in `resume_failed` and nowhere else, so it cannot collide with #88.
- **No disabled state on "Rejoin the match"** while its ask is in flight: not in the ACs,
  it is already a guarded no-op, and it now recovers on its own.
- **No timeout on `connect()`** to match the rejoin's: no AC asks for one, and the browser
  already ends a socket that will not open.
- **`self.in_match` is not reset** on a failed start in `game_session.js`: that flag is
  #41/#42's repair bookkeeping, and widening this fix into it is how a third bug gets in.
- **No browser test for the level-fetch rejection** (AC5): the level promise cache makes it
  unreachable from `page.route`, and it shares its code path with what T2 already proves.
