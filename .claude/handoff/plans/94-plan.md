# Plan — #94: the client's `JSON.parse` is unguarded, so one malformed frame kills the page

Repo: `philipdzierzon/jump-n-bump`, read at `/Users/philipdzierzon/Documents/sbx/jumpnbump/jump-n-bump`,
branch `master`, commit `af04c21`. Two files change: `src/net/websocket_transport.js` and
`test/relay.test.mjs`. Nothing else.

All line numbers below are as of `af04c21`.

---

## 1. What the code does today

### The hole

`src/net/websocket_transport.js:20-45` — the client's only wire parse, unguarded:

```js
    socket.onmessage = function (event) {
        var msg = JSON.parse(event.data);
        switch (msg.type) {
```

`event.data` is whatever came down the socket. A frame that is not JSON throws out of
`onmessage`. In a browser that is an uncaught error on the socket's task: the socket stays
`OPEN`, `socket.onmessage` stays installed, but *this* frame's `switch` never runs — and in
practice the frames that matter are the ones that never got dispatched. The page looks alive
(canvas still rendering, `send` still succeeding, relay still pinging) while `ping`/`pong`,
`room`, `error` and every `input` frame after it are handled or not entirely at the whim of
whether the next frame happens to parse. Under node (`test/relay.test.mjs` drives this exact
transport) the throw is an uncaught exception that takes the process down.

`msg` is then dispatched by `msg.type`:
- `"ping"` → replies `pong` (`:26`)
- `"joined"` → sets `joined = true`, falls through (`:28-32`)
- `"room"` → `on_room(msg)` (`:33-35`)
- `"error"` → `on_error(msg.code)`, and closes if the handshake was refused (`:36-41`)
- default → `listener(msg)`, the room's own feed (`:42-43`)

### How the relay already decided this

`server/index.js:1223-1231` — the same parse, guarded, with the decision written down:

```js
        client.on("message", (data) => {
            let msg;
            // ponytail: a malformed frame is dropped and the connection kept. upgrade
            // path: rate limits and payload caps live with the rest of abuse (#47).
            try {
                msg = JSON.parse(data.toString());
            } catch {
                return;
            }
            switch (msg.type) {
```

Drop the frame, keep the connection, no validation of well-formed contents. That is the
decision to mirror — the issue is the asymmetry, not the policy.

### The sibling transport has no hole

`src/net/loopback_transport.js` never serialises and never parses: `send` switches on a live
object (`:31-68`) and `to_client` hands a live object straight to the listener (`:16-18`).
Nothing to guard.

### Every other `JSON.parse` in the client

`grep -rn "JSON.parse" src/` returns exactly two sites:
- `src/net/websocket_transport.js:21` — the hole.
- `src/interaction/viewmodels.js:73` — already inside a `try { … } catch (e) { return {}; }`
  (`recall`, `:71-77`), and storage rather than the wire.

So there is one unguarded parse in the client, at the one place the wire is read. The guard
goes there; there is no shared function above it and no second caller to fix.

### The stale comment

`src/net/websocket_transport.js:47-51`:

```js
    socket.onclose = function () {
        // ponytail: a closed socket is reported once and the match is over. upgrade path:
        // reserved seats, AI takeover and reconnect (#42).
        if (on_error) on_error("DISCONNECTED");
    };
```

All three shipped in `11292f3 Disconnect, reserved seat, AI takeover and reconnect (#42) (#75)`,
one layer up: `src/interaction/viewmodels.js:801-811` now branches on `"DISCONNECTED"` and calls
`lost_connection()` for a client that still holds a seat in a live room — the match freezes, the
page retries, and `:787-791` walks it back into the match it froze in. `SEAT_TAKEN` at `:821-824`
is the reservation. So both sentences of the comment are false today: the match is *not* over,
and the upgrade path is not an upgrade path. The whole two-line comment goes.

---

## 2. The change, criterion by criterion

### AC1 — a malformed frame is discarded and the page keeps handling subsequent messages
### AC2 — a discarded frame is visible to a developer rather than silently swallowed

One edit covers both.

**File:** `src/net/websocket_transport.js`
**Function:** `socket.onmessage` (`:20`)

Replace `:20-22`:

```js
    socket.onmessage = function (event) {
        var msg = JSON.parse(event.data);
        switch (msg.type) {
```

with:

```js
    socket.onmessage = function (event) {
        var msg;
        // The relay's own parse has always been guarded (server/index.js): one frame that is
        // not JSON is dropped and the socket kept, rather than taking this handler with it and
        // leaving a page that looks alive receiving nothing ever again (#94).
        //
        // ponytail: logged per frame, so a relay that garbles every frame floods the console.
        // upgrade path: log the first one only, if that is ever what a bug report looks like.
        try {
            msg = JSON.parse(event.data);
        } catch (e) {
            console.log("dropped a malformed frame: %s", event.data);
            return;
        }
        switch (msg.type) {
```

Nothing else in the handler moves; the `switch` body, the `joined` fall-through and the
`default` branch are untouched.

Three details, all of them house style rather than taste:

- **`catch (e)`, not `catch {`.** The client is bundled through babel-preset-env 1.6 / babel 6
  (`.babelrc`, `package.json` devDependencies); optional catch binding is ES2019 and babel 6
  does not parse it. `server/index.js` can use `catch {` because it is not bundled. `src/` uses
  `catch (e)` in both places it catches at all: `src/game/snapshot.js:137`,
  `src/resource_loading/dat_level_loader.js:29`, `src/interaction/viewmodels.js:65,74`. The `e`
  is unused, which matches `viewmodels.js:65-69`.
- **`var msg;`, not `let`.** This file is `"use strict"` + `var` throughout (`:9-12`), the
  pre-ES6 hand-port style the whole of `src/` keeps.
- **`console.log` with a printf format, not `console.warn`/`console.error`.** There is no
  `console.warn` or `console.error` anywhere in `src/` or `server/`. Every developer-visible
  line in this codebase is `console.log("… %s …", x)`:
  `src/interaction/game_session.js:198` and `:220` (`report_repair`, `report_match`),
  `server/index.js:181,197,352,574,718,884,893`. `game_session.js:215-217` even writes the
  policy down: *"it goes to the console and nowhere else, so a desync is diagnosed by asking a
  player to paste a line."* One console line is exactly what "visible to a developer" means
  here, and it is the laziest thing that is not silence.

### AC4 — delete the stale comment

**File:** `src/net/websocket_transport.js`
**Function:** `socket.onclose` (`:47`)

Delete `:48-49` in full, leaving:

```js
    socket.onclose = function () {
        if (on_error) on_error("DISCONNECTED");
    };
```

Delete both lines, not just the `upgrade path:` clause: the `ponytail:` marker names a ceiling
that no longer exists, and its first sentence ("the match is over") is the part #42 most
directly falsified. Do **not** write a replacement comment — `on_error("DISCONNECTED")` is one
self-evident line, the interesting half of the story now lives at
`src/interaction/viewmodels.js:796-811` where the code that acts on it is, and
`/ponytail-debt` harvests `ponytail:` comments into a ledger, so a marker left on shipped work
is worse than no comment at all.

(`this.close()` at `:65-68` nulls `onclose` so a deliberate close is silent. That is untouched
and out of scope.)

### AC3 — the test

See §3.

---

## 3. Tests

### Which file, and why

**`test/relay.test.mjs`.** Its header (`:1-3`) says what it is: *"The relay (#34) … It runs
against a real server on a real socket, because the protocol is the thing under test."* It
already imports the client transport under test (`:11`,
`import { WebSocket_Transport } from "../src/net/websocket_transport.js";`), already owns a
`connect()` helper that wraps one (`:55-85`), already starts and runs matches through it
(`:259`, `:377-400`, `:615-631`), and is plain top-level `assert` with no framework. A frame
arriving at the client's `onmessage` is this file's subject.

**Not `test/browser.test.mjs`.** Its header (`:1-28`) scopes it to *"the markup, the flow and
the layout … under test together"* through a real Chromium — it exists for what jsdom could
not render. Getting a malformed frame into that page means `page.routeWebSocket`, i.e.
replacing the real relay connection that is the whole reason that walk boots a server at all
(`:41-44`), to test a net-layer module with no DOM in it. Wrong file, and roughly 40 lines
more of it.

Not `test/router.test.mjs` (pure functions, no socket) and not `test/replay.test.mjs` (the
simulation, loopback only).

### The case

Append immediately **before** `server.close();` at `test/relay.test.mjs:1526`, after the public
room-list section ends at `:1524`. A room of its own, so it perturbs nothing above it.

```js
// One malformed frame is dropped, and the socket goes on handling the next -- rather than
// dying under a page that still looks alive (#94). The relay cannot be made to send one, so
// the frame is handed to the client's own `onmessage`: the socket underneath is a real one,
// the relay behind it is real, and the only fake thing is the frame itself.
process.env.COUNTDOWN_MS = "50";
const parse_host = connect({ type: "create", id: "PARSE" });
await lobby(parse_host);
await parse_host.seats(["Ada"]);
const Native_WebSocket = globalThis.WebSocket;
let raw = null;
globalThis.WebSocket = class extends Native_WebSocket {
    constructor(...args) {
        super(...args);
        raw = this;
    }
};
const parse_guest = connect({ type: "join", id: "PARSE" });
globalThis.WebSocket = Native_WebSocket;
await lobby(parse_guest);
await parse_guest.seats(["Bax"]);
const guest_heard = [];
parse_guest.socket.receive((msg) => guest_heard.push(msg));
parse_host.socket.send({ type: "start", seed: 11, settings: {} });
await new Promise((resolve) => setTimeout(resolve, 200));
raw.onmessage({ data: "{" });
parse_host.socket.send({ type: "input", t: 9, seats: { 0: pressed } });
await new Promise((resolve) => setTimeout(resolve, 100));
assert.deepEqual(
    guest_heard.filter((msg) => msg.type === "input").map((msg) => msg.t),
    [9],
    "a malformed frame mid-match is dropped, and the frame after it is handled as usual",
);
delete process.env.COUNTDOWN_MS;
parse_host.socket.close();
parse_guest.socket.close();
```

Why each piece, so the implementer can adjust it without guessing:

- **`raw.onmessage({ data: "{" })`** — the transport assigns `socket.onmessage` directly
  (`:20`), so calling it is exactly the path a frame takes. Against `af04c21` this throws
  `SyntaxError` synchronously and the test process dies: a loud red. With the guard it logs one
  line and returns. (`raw.dispatchEvent(new MessageEvent("message", { data: "{" }))` is the
  more ceremonious equivalent if the direct call is ever preferred; it needs nothing extra in
  node 22, and buys nothing here.)
- **The global subclass** — `socket` is closure-private inside `WebSocket_Transport` and must
  stay that way; patching `globalThis.WebSocket` for the one `new WebSocket(url)` at `:10` is
  the whole of how the instance is reached. It is restored on the very next line, before any
  other client connects, so `WebSocket.OPEN` in `this.send` (`:62`) reads the native constructor
  as always. `connect()` constructs the transport synchronously, so `raw` is set when it returns.
- **`"PARSE"`** — five characters, no `I` and no `O`, and unused by any other room in the file
  (`grep -n 'id: "' test/relay.test.mjs`).
- **`COUNTDOWN_MS = "50"`** — the relay's default is 10s (`server/index.js:34`); the file
  already sets and deletes this env var around a start, at `:379`, `:463` and `:511`. Same
  idiom, same cleanup.
- **`t: 9`** — the relay drops an input frame below `room.due` (`server/index.js:1097`), and
  `room.due` only advances behind `room.tick` (`:689-691`), which only advances on a client's
  own input stamp (`:1102`). No client has sent a frame in this room, so `due` is 0 and 9 is
  comfortably ahead. `pressed` is the top-level const at `test/relay.test.mjs:277` and is in
  scope for the rest of the file. Seat 0 is the host's, so the frame is not a forgery
  (`server/index.js:1107-1112`).
- **`start`, then the frame** — makes it mid-match, as the criterion asks. `start` and `input`
  both reach the guest through the transport's `default` branch (`:42-43`), i.e. through
  `receive`, not through `connect()`'s `events` array, which is why the assertion reads
  `guest_heard` and not `parse_guest.events`.
- **The 200ms/100ms sleeps** — the file's existing idiom for "let the relay fan out"
  (`:247`, `:260`, `:279`, `:297`).

Run it with `node --no-warnings test/relay.test.mjs` from the worktree root (the full `npm test`
rebuilds the client and boots Chromium for the browser walk; not needed to see this case pass).

One case is the whole of it. There is no second test for the log line: asserting on
`console.log` means patching it, which is more machinery than the branch it guards.

---

## 4. Risks

- **Callers touched: none.** `WebSocket_Transport`'s two public methods (`receive`, `send`)
  and its four constructor arguments are unchanged; the edit is entirely inside one anonymous
  handler. Its importers — `src/interaction/viewmodels.js`, `test/relay.test.mjs:11`,
  `test/browser.test.mjs:37` — see no difference.
- **`test/replay.test.mjs` determinism: not at risk.** Nothing in `src/game/` is touched, no
  clock or RNG is read, and the replay suite runs over `Loopback_Transport`, which does not
  parse anything and is not edited. The `src/game/` → no-`src/interaction/`-imports rule is
  untouched.
- **Behaviour change under a *currently* well-behaved relay: none.** The relay only ever sends
  `JSON.stringify` output, so the `catch` is dead on the happy path.
- **Console flood.** A relay that garbles every frame now writes a line per frame. This is the
  one real corner cut, and it is exactly what `websocket_transport.js:57-60` already warns about
  in this file (*"one console line per tick is not how a client hears about that (#41)"*). Hence
  the `ponytail:` comment naming the ceiling. If a reviewer prefers, a `var warned = false;`
  beside `var joined = false;` and `if (!warned) { warned = true; console.log(…); }` is two more
  lines and closes it — flagged, not taken, because the flood *is* the bug report.
- **Prettier.** `npm run format:check` is the CI gate and `.githooks/pre-commit` blocks an
  unformatted commit. Run `npm run format` before committing; the snippets above are written at
  `tabWidth: 4` / `printWidth: 100` and should be no-ops.
- **The test's global patch** is restored one line later and before any other `connect()`. If a
  future reader moves the new block above other sections, the restore must move with it.

---

## 5. Deliberately not doing

- **No validation of well-formed message contents** — the issue puts it out of scope, and a
  schema for six message shapes is the abstraction this repo exists not to have.
- **No change to `server/index.js`** — its parse is already guarded; it is the reference, not
  the patient.
- **No guard in `src/net/loopback_transport.js`** — it never serialises and never parses.
- **No accessor exposing the transport's inner socket for the test** — widening the production
  API to make a test easier is more code than the four-line global patch that avoids it.
- **No reconnect, resync or `on_error` call from the `catch`** — a malformed frame is a relay
  bug, not a connection state; the socket is still fine and the next frame proves it.
- **No log throttling, ring buffer or "first N frames only"** — named as a ceiling in the
  comment, added when somebody actually drowns in it.
- **No replacement comment on `socket.onclose`** — deletion over addition; the behaviour now
  lives and is explained at `src/interaction/viewmodels.js:796-811`.
- **No second test for the console line** — patching `console.log` to assert on it costs more
  than the branch is worth.
- **No `test/browser.test.mjs` case** — `page.routeWebSocket` would mock the real relay that
  walk exists to exercise, for a module with no DOM in it.

---

## 6. Flags for the reviewer

- Everything the four criteria ask for is worth building; nothing in them should be dropped.
  The only judgement calls inside them are **AC2's shape** (one `console.log` per dropped frame
  vs. once-per-socket — taken: per frame, ceiling named in a `ponytail:` comment) and **AC4's
  extent** (the whole two-line comment vs. only its `upgrade path:` clause — taken: the whole
  comment, since the first sentence is the part #42 falsified and a stale `ponytail:` marker
  pollutes the `/ponytail-debt` ledger).
- The one place a new `ponytail: <ceiling>, <upgrade path>` comment is warranted is the new
  `catch`, for the console-flood ceiling. Nowhere else in this change cuts a corner with a
  known ceiling.
