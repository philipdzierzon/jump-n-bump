# #88 — Five places the flow never says what happened

Plan only. Repo `philipdzierzon/jump-n-bump`, read at
`/Users/philipdzierzon/Documents/sbx/jumpnbump/jump-n-bump`, branch `master`, `af04c21`.
Every line number below is that commit's.

Five items, one issue, no split (triage offered; the maintainer declined). All five are
missing *text*, not missing behaviour: nothing in the simulation, the relay's rules or the
router changes. Four files are touched: `src/interaction/router.js`,
`src/interaction/viewmodels.js`, `src/jnb.html`, `server/index.js`, plus the two tests.

---

## 1. What the code does today

### The one thing that forces a shared module

Every new sentence has to be assertable from `test/router.test.mjs` (AC7). That test is plain
node — it imports `src/interaction/router.js`, `src/game/keyboard.js` and
`src/interaction/scores_viewmodel.js`. It **cannot** import `src/interaction/viewmodels.js`:
that file ends with

```js
ko.applyBindings(new ViewModel());                 // viewmodels.js:1218
```

at module scope and reads `window` on the way. So the wording cannot stay where the messages
are set. `src/interaction/router.js` is the flow's only pure module (17 lines, "the pure
pieces of the kiosk flow", `router.test.mjs:18-21`), it is already imported by both, and the
sentences are flow sentences. The strings move there. That is the whole of the new
structure; there is no new file.

### A — the landing screen has no error line

`src/jnb.html:135-145` is the landing screen. It is the only screen in the flow with no
`<p class="err">`:

```html
    <div data-bind="visible: screen() === 'landing'" class="kiosk centre">
        <h1>JUMP 'N BUMP</h1>
        <p class="muted">Four bunnies. One goal: lagomorphic cranial domination.</p>
        <button class="pri" data-bind="click: go_quick">Quick Join</button>
        <button data-bind="click: go_create">Create a room</button>
        <button data-bind="click: go_join">Join with a room code</button>
        <div class="row">
            <button class="sm grow" data-bind="click: go_browse">Browse rooms</button>
            <button class="sm grow" data-bind="click: play_offline">Play offline</button>
        </div>
    </div>
```

Create (`:153`), join (`:162`), password (`:174`), names (`:192`), lobby (`:260`) and browse
(`:282`) each carry exactly one `<p class="err" data-bind="text: error"></p>`, placed after
the screen's primary action and before its Back/Start-over button. One observable,
`this.error` (`viewmodels.js:136`), feeds all of them; a screen the flow walks to
deliberately clears it on the way in (`go_landing` :940, `go_create` :944, `go_join` :949,
`go_quick` :959, `go_browse` :965, `connect` :749), and a message set just before a route is
*meant* to survive it — that is the #43 idiom, stated at `viewmodels.js:954-956` and used at
`:838-840`.

The three failure paths that land on `#landing`:

1. **The socket died with no room behind it** — `viewmodels.js:806-811`:
   ```js
                       if (transport === socket) leave_room();
                       self.error("The connection dropped.");
                       if (self.screen() === "play" || self.screen() === "room") go("landing", true);
   ```
   It already sets a message. Nobody could ever read it.
2. **A refused join while sitting on the lobby or the match** — `viewmodels.js:827-830`:
   ```js
                   } else if (self.screen() === "room" || self.screen() === "play") {
                       // A reload into a room that has since gone: there is nothing to reclaim
                       // and no password worth asking for.
                       go("landing", true);
   ```
   No message at all. The comment is also half wrong: the relay answers `ROOM_UNAVAILABLE`
   for a missing room *and* for a bad password in one branch (`server/index.js:190-191`), and
   a reload sends no password (`viewmodels.js:900`), so a room that acquired a password while
   this client was away refuses it here too.
3. **The reconnect window ran out** — `viewmodels.js:870-874`:
   ```js
       function give_up() {
           leave_room();
           self.error("The connection dropped.");
           go("landing", true);
       }
   ```
   This is the sixty seconds of `Reconnecting…` the issue describes (`reserve`, `:125`,
   `retry` `:853-868`). "The connection dropped." is true but says nothing about the seats,
   which is the thing that actually went.

(`apply_route`'s `route.screen === "password" && !self.pending_id()` fallback at `:913` also
reaches landing, but it is a degenerate route — a Forward or a reload onto `#password` with
nothing behind it — not a failure. Not counted, not messaged.)

`apply_route` calls `leave_room()` on the way into landing (`:910`), and `leave_room`
(`:425-478`) does **not** touch `self.error`, so a message set before the route survives it.

### B — countdown-zero ejection, and the ready reset

Relay, `server/index.js:1007-1021`:

```js
function countdown_zero(room) {
    if (rooms[room.id] !== room) return;
    const pending = room.pending;
    for (const client of [...room.clients])
        if (client.seats.length && !client.ready) vacate(client);
    // The seats changed hands before the match began, so the room is described again
    // first: a client vacated at zero has to hear that it holds nothing.
    broadcast_state(room);
    begin(room, pending);
}
```

Client, `viewmodels.js:692-709` — the `room` message arrives with `held: []`, and:

```js
        if (!msg.held.length) {
            ...
            // Every seat gone: un-ready at countdown zero, which reserves nothing. The
            // client is still in the room, so the names screen is where it asks for seats
            // again rather than the landing page (#37, #17).
            if (
                self.participants().length &&
                (self.screen() === "room" || self.screen() === "play")
            )
                go("names", true);
            return;
        }
```

The names screen it lands on has an error line (`jnb.html:192`) and nothing is put in it.
This branch is reachable only from countdown zero: the relay's other `vacate` calls are a
`leave` message (`server/index.js:1136`) and the post-disconnect timer (`:590`), and in both
cases this client's socket is already gone or it asked for it.

The second half — ready resets after *every* match — is `to_lobby` → `reset_ready`
(`server/index.js:361-367`, `:337-342`). The client just takes the new value at
`viewmodels.js:678` (`self.ready(!!msg.you_ready)`). A staged config change clears ready too
and *does* say so, in the banner at `jnb.html:206-209` ("Everyone's ready was cleared and the
countdown stopped"), for the exact reason this item exists: cleared checkboxes alone read as
a bug (#10, #38). A match end clears the same flags and says nothing.

### C — a mistyped code answers with a password prompt

`join_room` (`:1013-1019`) → `go(id)` → `apply_route` → `enter(id)` (`:894-901`) →
`connect({type:"join", …})`. The relay answers `ROOM_UNAVAILABLE`
(`server/index.js:190-191` — deliberately one code for both cases). The screen at that moment
is `join` (`screen_of("#QMFTX")` is the join route, `router.js:14-15`), so the handler falls
all the way through to `viewmodels.js:841-845`:

```js
                } else {
                    // Which of the two it was is exactly what is not said: the password
                    // screen is where both answers land (#8).
                    go("password", true);
                }
```

No error. The player types a guess, `submit_password` (`:1020`) reconnects, and *now* the
screen is `password`, so `:831-832` fires and `UNAVAILABLE` finally appears. That is why the
message only shows on the second attempt.

`UNAVAILABLE` (`viewmodels.js:35`) is already the single opaque answer #8 requires:

```js
var UNAVAILABLE = "That room is not available. Check the code, and the password if it has one.";
```

### D — the lobby never says who the host is

`jnb.html:227`: `<p class="muted" data-bind="visible: !is_host()">Waiting for the host to start.</p>`.
`is_host` is set from `msg.host`, and `room_view` sends that as the recipient's own boolean
only (`server/index.js:376`). No client is ever told *which* seat the host is on.

The issue points at `seat_labels` (`server/index.js:299-320`), which computes
`name + " (left)" | " (out of sync)" | " (AI)"` per seat and reaches the client as
`msg.labels` → `self.seat_labels` (`viewmodels.js:149`, set `:661`). **It is not usable for
this.** Its only consumer is `display_names()` (`:348-352`), which feeds both the board's
column heads *and* `match_result` (`:380-392`), so a `(host)` suffix would render as
`Dott (host)` in the score table and as `"Dott (host) wins with 3 bumps."` above it. The
label chain is also a mutually exclusive ternary — a host seat is either the plain name or
one of the three states, never both. Riding it is the wrong rung; it is cheaper *and*
correcter to send the seat index.

### E — a failed room-list fetch is an empty list

`viewmodels.js:972-985`:

```js
        fetch("api/rooms", { cache: "no-store" })
            .then(function (res) {
                return res.json();
            })
            .then(self.rooms)
            .catch(function () {
                self.rooms([]);
            });
```

and `jnb.html:281`:

```html
        <p class="muted" data-bind="visible: !rooms().length">Nothing public right now &mdash; make one, or join by its code.</p>
```

A dead relay reads as a quiet Saturday. The retry already exists on the screen — the
`Refresh` button, `jnb.html:284`.

---

## 2. The change, item by item

### 0 (shared) — `src/interaction/router.js`: the flow's sentences

Append to `src/interaction/router.js` (it currently ends at `screen_of`, line 17). Keep the
`var` style the file already uses.

```js
// The flow's own sentences, beside the routes rather than in the view model because this is
// the file a test can import: `viewmodels.js` applies its bindings to a DOM at module scope,
// so node can never reach a string that lives there (#88).
export var FLOW_TEXT = {
    // One answer for a wrong password and for a room that is not there: telling them apart
    // is what would make an unlisted room's id worth guessing at (#8). Said on the first
    // refusal as well as the second, because a password box for a room that may never have
    // existed is the refusal the player cannot act on (#88).
    unavailable: "That room is not available. Check the code, and the password if it has one.",
    // The socket went and there was no room behind it to reconnect into.
    dropped: "The connection dropped.",
    // The reservation window ran out with the retries still going: the seats are anybody's
    // now, which is the half worth saying out loud (#42).
    gave_up: "The connection did not come back in time, so your seats were given up.",
    // A reload into a room that refused it. The relay answers a missing room and a wrong
    // password with one code, so this names both and picks neither (#8).
    room_gone: "That room would not let you back in. It may have ended, or it may have a password now.",
    // Countdown zero frees the seats of anyone who never readied, and the client lands back
    // on the names screen to ask for some again (#17, #37).
    vacated:
        "The countdown ran out before you were ready, so your seats went back to the room. " +
        "Take them again if they are still free.",
    // Ready is cleared for the whole room when a match ends, exactly as a staged config
    // change clears it -- and cleared checkboxes on their own read as a bug (#10, #38).
    ready_cleared: "The match ended and everyone's ready was cleared. Press Ready for the next one.",
    // A failed fetch and an empty list are the same empty array (#88).
    rooms_failed: "The room list would not load. Refresh to try again.",
};

// Who the lobby is waiting on. The relay names the seat, because a client's own `host` flag
// names nobody; with no name for it the sentence is the one the lobby has always said (#88).
export function waiting_for(name) {
    return name ? "Waiting for " + name + " to start." : "Waiting for the host to start.";
}
```

`viewmodels.js:5` becomes:

```js
import { screen_of, FLOW_TEXT, waiting_for } from "../interaction/router.js";
```

and `viewmodels.js:30-35` loses its local copy:

```js
var CODE_HINT = "A code is 5 letters, no I and no O.";
// Nobody holds a seat, so nobody is keeping the room waiting: an AI-filled seat is ready
// by definition (#37).
var ALL_READY = [true, true, true, true];
```

(the two comment lines at `:30-31` move with `UNAVAILABLE` into `FLOW_TEXT.unavailable`).
Replace the two existing uses of `UNAVAILABLE` (`:832`, `:839`) with
`FLOW_TEXT.unavailable`. `CODE_HINT` stays where it is — it is not one of this issue's
messages and moving it is scope creep.

### A — the landing screen's error line, and the two paths that set nothing

**`src/jnb.html`**, inside the landing screen, after the `.row` div and before `</div>`
(`:144`), hand-formatted at 8 spaces like every other screen's:

```html
        <p class="err" data-bind="text: error"></p>
```

**`viewmodels.js:810`** — path 1 keeps its message, through the shared constant:

```js
                    self.error(FLOW_TEXT.dropped);
```

**`viewmodels.js:827-830`** — path 2 gains one:

```js
                } else if (self.screen() === "room" || self.screen() === "play") {
                    // A reload into a room that will not have it back. It may have ended, or
                    // it may have gained a password while this client was away -- the relay
                    // answers both with one code and this says both (#8). Either way there is
                    // nothing to reclaim, so the landing screen is where it ends.
                    self.error(FLOW_TEXT.room_gone);
                    go("landing", true);
                }
```

**`viewmodels.js:870-874`** — path 3 says what really happened:

```js
    function give_up() {
        leave_room();
        // Not "the connection dropped": the retries ran the whole reservation window out, so
        // what the player lost is the seats, and that is what the title screen has to say (#42).
        self.error(FLOW_TEXT.gave_up);
        go("landing", true);
    }
```

Exact wording:

| path | message |
| --- | --- |
| socket died, no room behind it | `The connection dropped.` (unchanged) |
| refused on a reload into the lobby/match | `That room would not let you back in. It may have ended, or it may have a password now.` |
| reconnect window ran out | `The connection did not come back in time, so your seats were given up.` |

**#8**: none of these is reachable by a client that was not already in that room — path 2
requires `screen()` to be `room` or `play`, which is reached only through the flow or through
`recall("room").id` (`:920-921`). The room's existence is not news to it, and the sentence
still refuses to say which of the two refusals it was.

### B — countdown-zero ejection, and the ready reset

**`viewmodels.js:700-708`**, one line before the route:

```js
            // Every seat gone: un-ready at countdown zero, which reserves nothing. The
            // client is still in the room, so the names screen is where it asks for seats
            // again rather than the landing page (#37, #17).
            // ponytail: the line names the countdown because countdown zero is the only way
            // a seated client is left holding nothing -- the relay's other two `vacate`
            // calls are a `leave` this client sent and a disconnect it cannot hear. upgrade
            // path: carry the reason on the room view if a third way ever appears.
            if (
                self.participants().length &&
                (self.screen() === "room" || self.screen() === "play")
            ) {
                self.error(FLOW_TEXT.vacated);
                go("names", true);
            }
            return;
```

> **The countdown ran out before you were ready, so your seats went back to the room. Take
> them again if they are still free.**

It lands in the names screen's existing `<p class="err">` (`jnb.html:192`), which is the
screen the player is routed to, and "Take them again" names the button right above it
("Take the seats", `:191`).

**`viewmodels.js:662-668`**, the match-start/match-end transition. The `match_running`
observable still holds the *previous* answer at this point, which is the whole detection:

```js
        // The board of the last match stands until the next one begins, which is where it
        // is zeroed -- not on entering the lobby, which is where it is read (#13, #39).
        if (msg.started && !self.match_running()) {
            self.board(null);
            self.board_reason(null);
            // And the last match's announcement goes with its board: the ready it was about
            // has been pressed again by now.
            self.notice("");
        }
        // Ready is cleared for everyone when a match ends, and cleared checkboxes on their
        // own read as a bug rather than as the rule they are -- the same reason the staged
        // banner says so (#10, #38, #88).
        if (self.match_running() && !msg.started) self.notice(FLOW_TEXT.ready_cleared);
        self.match_running(!!msg.started);
```

> **The match ended and everyone's ready was cleared. Press Ready for the next one.**

It lands in the lobby's existing notice line, `jnb.html:259`
(`<p class="muted" data-bind="text: notice, visible: notice"></p>`) — the line `set_password`
already uses. No new markup, no new observable. It clears when the next match starts, when
the host applies a config (`:1164`) and when the room is left (`:463`).

### C — the first refusal says so

**`viewmodels.js:841-845`**, one line:

```js
                } else {
                    // Which of the two it was is exactly what is not said, but *that* it was
                    // refused is: without this the first refusal is a password box for a room
                    // that may never have existed, and the player only learns otherwise after
                    // guessing at a password (#8, #88).
                    self.error(FLOW_TEXT.unavailable);
                    go("password", true);
                }
```

> **That room is not available. Check the code, and the password if it has one.**

**How the wording respects #8.** It is the same string the second refusal already shows
(`:832`) and the same string a refused Browse row shows (`:839`), so the first attempt, the
second attempt and the listed-room path are word-for-word identical. It names neither
"no such room" nor "wrong password"; it names the two things the player can act on (the code,
and the password if there is one) without saying which of them was wrong. A guesser probing
ids learns exactly what they learn today: one sentence, for every id, right or wrong.
`server/index.js:190-191` stays untouched — one code on the wire, one sentence on the screen.
The test below asserts that property rather than only the text.

### D — the lobby names the host

**`server/index.js`**, a new function directly above `ensure_host` (`:228`), and
`ensure_host`'s first line reusing it:

```js
// Which seat the host is sitting on. `host` in the room view is the recipient's own answer,
// so a client that is not the host is told there is one and never which (#88).
// ponytail: the first of the host's seats, so a two-player couch is named after its first
// participant. upgrade path: send every seat it holds if the sentence ever names both.
function host_seat(room) {
    for (const client of room.clients)
        if (client.host && client.seats.length) return client.seats[0];
    return null;
}

function ensure_host(room) {
    if (host_seat(room) !== null) return;
    let successor = null;
    ...
```

(seat 0 is falsy, hence `!== null`.)

**`server/index.js:376`**, in `room_view`, one field beside the boolean it explains:

```js
        host: !!client.host,
        // Which seat that host is on, so the lobby can name the player everyone is waiting
        // for: the flag above names nobody (#88).
        host_seat: host_seat(room),
```

**`viewmodels.js`**, beside `is_host` (`:139`):

```js
    this.is_host = ko.observable(true);
    // The seat the room says its host is on, or null in a local room, which has no relay to
    // ask and no host to wait for.
    this.host_seat = ko.observable(null);
```

a computed beside `seat_rows` (after `:376`):

```js
    // Who the lobby is waiting on, by the name the room knows them under -- not the board's
    // label, which would read "Zip (AI) to start" for a host whose socket is out (#88).
    this.waiting_text = ko.computed(function () {
        var seat = self.host_seat();
        return waiting_for(seat == null ? null : self.seat_names()[seat]);
    });
```

set in `apply_room` beside `self.is_host(host)` (`:676`):

```js
        self.host_seat(msg.host_seat == null ? null : msg.host_seat);
```

and cleared in `leave_room` beside `self.is_host(true)` (`:443`):

```js
        self.host_seat(null);
```

**`src/jnb.html:227`**, replacing the static sentence:

```html
        <p class="muted" data-bind="text: waiting_text, visible: !is_host()"></p>
```

> **Waiting for Zip to start.** — and `Waiting for the host to start.` when the room has not
> named a seat (an offline room, or a lobby with no seated host), which is what the line says
> today.

The seat list is left alone **on purpose**: see *Deliberately not doing*.

### E — a failed fetch reads as a failure

**`viewmodels.js`**, beside `this.rooms` (`:133`):

```js
    this.rooms = ko.observableArray([]);
    // A failed fetch and an empty list are the same empty array, so which one it was is
    // remembered rather than inferred (#88). Its own observable rather than `error`, because
    // Browse deliberately keeps a refused join's message across a refresh (#43) and a
    // refresh that works has to clear this one without clearing that one.
    this.rooms_error = ko.observable("");
```

**`viewmodels.js:977-984`**:

```js
        fetch("api/rooms", { cache: "no-store" })
            .then(function (res) {
                return res.json();
            })
            .then(function (list) {
                self.rooms_error("");
                self.rooms(list);
            })
            .catch(function () {
                self.rooms([]);
                self.rooms_error(FLOW_TEXT.rooms_failed);
            });
```

**`src/jnb.html:281-282`**:

```html
        <p class="muted" data-bind="visible: !rooms().length &amp;&amp; !rooms_error()">Nothing public right now &mdash; make one, or join by its code.</p>
        <p class="err" data-bind="text: rooms_error() || error()"></p>
```

> **The room list would not load. Refresh to try again.**

One `.err` paragraph on the screen, still — see Risks. The retry is the `Refresh` button
that is already there (`:284`).

---

## 3. Tests

### `test/router.test.mjs` (AC7)

The file's idiom is top-level `assert.equal` / `assert.match` on a pure function's output,
each with a sentence explaining the rule (`:99-152`). Extend the import at `:24` and append a
section below the `match_result` block, before `console.log("router: ok")`:

```js
import { screen_of, FLOW_TEXT, waiting_for } from "../src/interaction/router.js";
```

```js
// The flow's own sentences. They live beside the routes because that is the file node can
// import: the view model applies its bindings to a DOM the moment it loads (#88).
assert.equal(
    FLOW_TEXT.unavailable,
    "That room is not available. Check the code, and the password if it has one.",
    "said on the first refusal now, not only on the second: a password box for a room that " +
        "may never have existed is a refusal the player cannot act on",
);
assert.doesNotMatch(
    FLOW_TEXT.unavailable,
    /exist|no such|gone|wrong password|bad password/i,
    "and it still names neither answer: telling a missing room from a wrong password is " +
        "what would make an unlisted room's id worth guessing at (#8)",
);
assert.equal(FLOW_TEXT.dropped, "The connection dropped.");
assert.equal(
    FLOW_TEXT.gave_up,
    "The connection did not come back in time, so your seats were given up.",
    "the title screen a sixty-second reconnect gives up onto says what was lost, not just " +
        "that a socket went (#42)",
);
assert.equal(
    FLOW_TEXT.room_gone,
    "That room would not let you back in. It may have ended, or it may have a password now.",
    "both refusals in one sentence, because the relay answers them with one code (#8)",
);
assert.equal(
    FLOW_TEXT.vacated,
    "The countdown ran out before you were ready, so your seats went back to the room. " +
        "Take them again if they are still free.",
    "on the names screen, which is where a client vacated at zero lands (#17, #37)",
);
assert.equal(
    FLOW_TEXT.ready_cleared,
    "The match ended and everyone's ready was cleared. Press Ready for the next one.",
    "the rule a staged change already announces, said for the other half of it (#10, #38)",
);
assert.equal(
    FLOW_TEXT.rooms_failed,
    "The room list would not load. Refresh to try again.",
    "a relay that is down must not read as a quiet Saturday",
);

// Who the lobby is waiting on: the room names the seat, so the sentence can name the player.
assert.equal(waiting_for("Zip"), "Waiting for Zip to start.");
assert.equal(
    waiting_for(null),
    "Waiting for the host to start.",
    "and the sentence the lobby has always said when the room has not named a seat",
);
assert.equal(waiting_for(""), "Waiting for the host to start.", "an unnamed seat names nobody");
```

### `test/relay.test.mjs` — one assertion for D

The countdown-zero block already exists at `:461-485` and needs nothing. Add `host_seat` to
an existing room-view assertion — the nearest natural place is the host-migration section;
a two-line addition where a `room` message is already in hand:

```js
assert.equal(
    vacated.host_seat,
    0,
    "and the room names the seat its host is on, so a client that is not the host can say " +
        "which of four names it is waiting for (#88)",
);
```

(`vacated` is the `room` message at `:467`; `Host` holds seat 0 there.)

### `test/browser.test.mjs`

No expectation needs changing — see Risks for why each item avoids the existing walks — with
one optional one-line repair at `:1703` noted there.

---

## 4. The seam for #90

#90 makes these messages announceable and focusable. This issue deliberately adds **no new
message shape**: every sentence lands in a paragraph that already exists, with the class it
already has. After this issue, *every* screen in the flow — landing included, which is the
only one that was missing one — carries exactly one `<p class="err" data-bind="text: …">`,
bound to a text observable rather than toggled with `visible:`, so the node stays in the DOM
and its text content changes in place (the shape a live region needs; a `visible:`-toggled
node is `display: none` at the moment its text changes and is not announced). The lobby's
second channel is the one pre-existing `<p class="muted" data-bind="text: notice, visible: notice">`
at `jnb.html:259`. So #90 has two selectors and nothing else to find: `p.err` (seven of them,
one per screen, same class, same position — after the primary action, before the Back button)
and the lobby's notice paragraph. #90 attaches `role="alert"` / `aria-live` and whatever focus
management it decides on to those, and changes no wording and no view model. **Nothing in
this issue implements any part of that**: no roles, no `aria-live`, no `tabindex`, no focus
moves.

---

## 5. Risks

- **`src/jnb.html` is Prettier-ignored and hand-formatted** (`.prettierignore`, CLAUDE.md
  "Formatting"). Four edits only, all at 8-space indentation matching their siblings, all
  using the file's own `&amp;&amp;` / `&mdash;` conventions. There is no rendering check, so
  a stray reflow is caught by nothing but review.
- **`test/browser.test.mjs:1703`** — the failure diagnostic does
  `document.querySelector("p.err")?.textContent`, i.e. the *first* `p.err` in document order.
  The landing screen is the first screen in the file (`:135`), so after item A that selector
  always reads the landing screen's paragraph instead of the current screen's, and every
  timeout report would print the wrong message (or an empty one). Worth the one-line repair
  in the same PR: `[...document.querySelectorAll("p.err")].map((el) => el.textContent.trim()).filter(Boolean).join(" | ")`.
  Diagnostics only — no assertion depends on it.
- **The lobby row helpers are positional.** `lobby_rows` (`:251-261`) joins the text of every
  *visible* `span, small` in a row and is deep-compared against exact strings at `:405`,
  `:576`, `:602`, `:626`; `room_view` (`:266-276`) takes `querySelectorAll("small").slice(0, 2)`
  and assumes `[ready, bunny]`. This is the direct reason item D names the host in the
  sentence instead of badging the seat: a `<small>host</small>` in the row breaks four
  deep-equals, and putting it anywhere before the bunny silently breaks `room_view` in the
  two-page walk as well. The sentence lives in a `<p>` outside the `<li>` and touches neither
  helper.
- **`notice()` (`:306`) is asserted at `:679`, `:681` and `:706`.** Item B's reuse of `notice`
  is safe only because no match ends before those lines in the walk (the first `match_end` is
  at `:714`) and `apply_config` clears the notice at `:648`/`:668`. An implementer who moves
  the settings block after a match must re-check this.
- **`message()` (`:1392`) is `screen("browse").locator(".err").innerText()`** — a Playwright
  strict locator. A *second* `.err` paragraph on the browse screen would fail with a
  strict-mode violation, which is why item E funnels both messages through the one existing
  paragraph (`text: rooms_error() || error()`) instead of adding a line. The `/not available/`
  assertion at `:1418` still passes: a successful refresh sets `rooms_error("")`, so the
  refused-join message shows through.
- **A stale error can now appear on the landing screen.** `error` is one observable for the
  whole flow and is cleared on deliberate entry to a screen, not on leaving one — so typing a
  bad code on `#join` and pressing the browser's Back shows `A code is 5 letters, no I and no
  O.` on the title screen. This is exactly the behaviour `#browse` already has and #43
  deliberately relies on (`viewmodels.js:954-956`); clearing on entry to landing would erase
  all three of item A's messages, since `apply_route` runs after they are set. Accepted, not
  worked around.
- **`host_seat` is a new field on every `room` and `joined` message.** `relay.test.mjs`
  asserts named fields, never whole-message deep-equals (`:95`, `:468-478`, `:529`), so
  nothing breaks. An old client ignores it; a new client against an old relay reads
  `undefined` and falls back to the sentence it says today.
- **`npm test` builds the client first** and runs four files; only `router.test.mjs` and the
  one `relay.test.mjs` line are new work, but the browser walk must still pass, so run the
  whole suite and not just the fast file.

---

## 6. Deliberately not doing

- **A `(host)` badge in the lobby seat rows.** The sentence already names the host, and the
  badge would say it twice while breaking four `lobby_rows` deep-equals and risking
  `room_view`'s positional slice. Flagged rather than dropped: if the maintainer wants the
  badge, it goes *after* the bunny `<small>` (never before), and `:405`, `:576`, `:602`,
  `:626` all need new expectations.
- **Routing `(host)` through `seat_labels`** (the issue's suggested rung). It would put
  `Dott (host)` in the board's column heads and `"Dott (host) wins with 3 bumps."` above them,
  because `display_names()` feeds both, and the label chain is a mutually exclusive ternary a
  host state does not fit. Rejected with reasons, not silently.
- **Splitting the issue.** Triage offered; the maintainer declined.
- **Telling a client its seats went to the AI mid-match** — #76. Item B covers only countdown
  zero, which is a different moment (before the match) and a different audience (the player
  who was ejected, on the names screen).
- **Changing whether an unlisted room is revealed** — #8. Item C reuses the existing single
  opaque sentence for both refusals and adds no second failure code; `server/index.js:190-191`
  is untouched.
- **Live-region roles, focus management, keyboard reach** — #90, which this issue is the
  markup groundwork for. Section 4 says what it attaches to.
- **`res.ok` on the room-list fetch.** `res.json()` already rejects on any non-JSON body, and
  the relay answers `/api/rooms` with `res.json(listings())` on one line
  (`server/index.js:1209`) — there is no error-shaped JSON body for it to catch. Add it if the
  relay ever gets an error envelope.
- **Clearing `error` on entry to the landing screen.** It would erase the three messages item
  A exists to show. See Risks.
- **Moving `CODE_HINT` or `LABELS` into `router.js`.** Only the strings this issue asserts
  move; the rest stay where they are.
