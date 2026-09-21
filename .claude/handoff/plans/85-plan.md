# #85 — Keys stick down on blur, and keep being sent to the room

Plan for `philipdzierzon/jump-n-bump`, branch `master` @ `af04c21`.
Total production diff: **3 lines added in `src/game/keyboard.js`, 4 lines added in
`src/interaction/game_session.js`.** Nothing is deleted, nothing moves.

---

## 1. What the code does today

### The pressed-keys map

`src/game/keyboard.js:12-38` is the whole input layer. The map is a private closure var and
is written in exactly two places:

```js
// src/game/keyboard.js:12-38
export function Keyboard(key_function_mappings) {
    "use strict";
    var keys_pressed = {};

    this.input_frame = function (scheme) {
        var keys = CONTROL_SCHEMES[scheme];
        if (!keys) return null;
        return {
            left: !!keys_pressed[keys[0]],
            right: !!keys_pressed[keys[1]],
            up: !!keys_pressed[keys[2]],
        };
    };

    this.onKeyDown = function (evt) {
        keys_pressed[evt.keyCode] = true;
    };

    this.onKeyUp = function (evt) {
        keys_pressed[evt.keyCode] = false;
        var action = key_function_mappings[String.fromCharCode(evt.keyCode)];
        if (action != null) action();
    };
}
```

`keys_pressed` is **already fully encapsulated** — a repo-wide grep for `keys_pressed`
returns only `src/game/keyboard.js:14,23,24,25,30,34`. Nothing outside the constructor can
reach it. So AC4 is not about hiding an existing leak; it is about the *flush* not becoming
one (see §2.4).

Note the second job of `onKeyUp`: it runs the `key_function_mappings` action for that key —
`M` (mute) and `P` (board), registered at `src/interaction/game_session.js:426-447`. **A
flush must not go through `onKeyUp`**, or blurring with M or P held would toggle the sound
or the scoreboard.

### The bare document-level handlers

The only DOM that ever touches the map, at the very bottom of the `Game_Session`
constructor:

```js
// src/interaction/game_session.js:449-457
    // A focused text field owns the keys: typing a P into the room id must not start a
    // game, an M must not toggle the sound, and WAD must not steer a bunny. The guard
    // lives here rather than in `Keyboard`, which is simulation-side and sees no DOM.
    document.onkeydown = function (evt) {
        if (!is_typing(evt)) keyboard.onKeyDown(evt);
    };
    document.onkeyup = function (evt) {
        if (!is_typing(evt)) keyboard.onKeyUp(evt);
    };
```

Bare **assignment**, not `addEventListener`. That matters: `Game_Session` is constructed
once per lobby→match cycle (`session()` at `src/interaction/viewmodels.js:527-568`, cleared
by `end_match` at `viewmodels.js:214`), so a page's life holds many of them. Assignment means
the newest session's handlers replace the previous one's — no accumulation. Any new
registration here must use the same idiom or it leaks one listener per match onto a dead
`Keyboard`.

There is no `blur`, no `visibilitychange`, no `pagehide`, and no `.focus()` anywhere in
`src/` (grep: `addEventListener` in `src/` returns only `viewmodels.js:936` hashchange and
`viewmodels.js:1132` the names-screen jump key, neither of which touches the map).

### Why a latched key is everyone's picture, not a local artifact

The keyboard is read once per simulation tick and the result is put on the wire
unconditionally:

- `src/interaction/game_session.js:75-80` — the `Room` is constructed with a read function:
  ```js
  var room = new Room(transport, function (nth) {
      return keyboard.input_frame(config.schemes()[nth]);
  });
  ```
- `src/net/room.js:248-263` — `Room.step()` calls that read for every seat this client
  drives and sends it:
  ```js
  held.forEach(function (seat, scheme) {
      if (drivers[seat] === "local") seats[seat] = read_input(scheme);
  });
  schedule_input(tick + self.d, seats);
  transport.send({ type: "input", t: tick + self.d, seats: seats });
  ```
  "Every tick, unconditionally, stamped d ahead."
- `src/game/game.js:60-70` — `update_player_actions()` calls `room.step()` and writes
  `action_left/right/up` onto each `player`.
- `src/game/game.js:124-155` — `pump()` runs `game_iteration()` in a `while` loop at 60 Hz.

So a key left `true` in the map is re-read, re-stamped and re-broadcast 60 times a second
for as long as the tab is away. Every other client applies it. Confirmed: it is the room's
picture.

### The `Connection lost` overlay path — checked, and the issue's prose does not hold

The issue body says "The same happens when the `Connection lost` overlay takes focus." It
does not, in today's code:

- The overlay is a plain `visible`-bound div with no focus affordance:
  `src/jnb.html:128` — `<div data-bind="visible: connection_text, text: connection_text" class="reconnecting"></div>`,
  and the lobby twin at `src/jnb.html:199`. No `<dialog>`, no `tabindex`, no `autofocus`,
  and no `.focus()` call exists anywhere in `src/`.
- The path that raises it throws the whole session away, keyboard included:
  ```js
  // src/interaction/viewmodels.js:880-892
  function lost_connection() {
      self.disconnected(true);
      ...
      var game = self.current_game();
      if (game) game.stop();
      self.current_game(null);
  ```
  The next `session()` builds a fresh `Keyboard` with an empty `keys_pressed`, so a latch
  cannot survive a reconnect.

**Verdict: nothing to build for it.** It is background narrative, not one of the five
criteria. If the overlay ever does become focus-taking, the blur handler added below covers
it for free, because taking focus into a real focusable element is exactly what fires the
window blur this issue is about. Flagged here so a reviewer does not go looking for a
missing third handler.

---

## 2. The change, criterion by criterion

### AC4 — the keyboard exposes a way to clear its pressed state

**File** `src/game/keyboard.js` · **function** `Keyboard` · add one method beside
`onKeyUp`.

```js
    this.onKeyUp = function (evt) {
        keys_pressed[evt.keyCode] = false;
        var action = key_function_mappings[String.fromCharCode(evt.keyCode)];
        if (action != null) action();
    };

    // Every key up at once, for a window that stopped being told about keyups at all: a
    // tab switched away from never delivers the keyup for the key that was held, and the
    // map would go on reporting it pressed for every tick of it (#85). Not a loop of
    // `onKeyUp`, which would fire M's and P's actions -- a flush is the keys being let go
    // of, not the player pressing them.
    this.release_all = function () {
        keys_pressed = {};
    };
```

Why a method and not the callers zeroing the map: the map is private and must stay private —
`input_frame` is the one reader on the wire path, and #86 (out of scope here) is going to
build on a defined "everything released" operation rather than on each caller's idea of one.
Reassigning the `var` is safe: `input_frame`, `onKeyDown` and `onKeyUp` all close over the
binding, not over the object.

That is the entire `src/game/` change. It reads no DOM, no clock and no randomness.

### AC1 — losing window focus releases the key, and the room stops receiving it held

**File** `src/interaction/game_session.js` · **function** `Game_Session` (constructor tail) ·
append directly under the existing `document.onkeyup` assignment at line 455-457.

### AC2 — the same when the page is hidden rather than merely blurred

Same two lines. `blur` and `visibilitychange` are **not** the same event and neither is a
superset of the other, which is why the issue names them separately:

| What the player does | `window` `blur` | `visibilitychange` → hidden |
| --- | --- | --- |
| Alt-tab to another **application** (the case in the issue title) | **fires** | does **not** fire — Chrome keeps an occluded/background *window*'s tab `visible` on desktop |
| Switch to another **tab** in the same window | fires | fires |
| Minimise the window | fires | fires |
| Phone/tablet backgrounds the browser, screen locks | unreliable — some mobile browsers only fire the visibility change | **fires** |
| Focus moves to the URL bar / devtools | fires | does not fire |

High confidence on rows 1–3 and 5; row 4 is the well-documented mobile case and is the
reason `visibilitychange` cannot be dropped, just as row 1 is the reason `blur` cannot.
**Register both.**

The exact edit:

```js
    document.onkeyup = function (evt) {
        if (!is_typing(evt)) keyboard.onKeyUp(evt);
    };

    // Alt-tab with right held and the browser never sends the keyup: the map stays
    // pressed, and `Room.step` re-reads it and re-stamps it 60 times a second, so the
    // bunny runs right forever on every client in the room and not just this one (#85).
    // Both events, because neither covers the other: switching applications blurs a window
    // whose tab Chrome still calls visible, and a phone backgrounding the browser can hide
    // it without a blur anybody promises.
    // Assigned rather than added, exactly like the key handlers above: a session is built
    // per match, and `addEventListener` would pile one listener per match onto keyboards
    // that are already gone.
    window.onblur = keyboard.release_all;
    document.onvisibilitychange = keyboard.release_all;
}
```

Direct assignment of the method is deliberate — `release_all` takes no argument and reads no
`this` (the whole file is closure-style, never `this.foo` inside a method), so no wrapper
earns its keep. No `if (document.hidden)` guard either: firing on *becoming visible* clears
a map that is already empty, and a keydown cannot be delivered to a page before the page has
been told it is visible. One condition less to read and one less to test around.

**Why here and not anywhere else.** Every write to the map goes through the `onkeydown`
assigned nine lines above, in this same constructor, over the `keyboard` this same
constructor built. There is no other writer and no second `Keyboard` in the tree. Putting
the flush anywhere else — module scope in `viewmodels.js`, or inside `Keyboard` — either
loses the per-session rebinding that keeps the two in step, or drags the DOM into
`src/game/`, which the comment at `game_session.js:451` and `test/replay.test.mjs` both
forbid. There is no path that can latch a key and bypass this registration.

### AC3 — regaining focus with the key still down resumes on the next real keydown

**No code.** It falls out of the flush:

- `keys_pressed` is `{}`, so `input_frame` returns `{left:false,right:false,up:false}` and
  the room broadcasts a released frame on the very next tick.
- Browsers do not re-deliver a `keydown` for a key that was already physically down when
  the window regained focus. So the player who alt-tabs back still holding right sees the
  bunny standing still until they release and press again — which is the criterion, stated
  literally.
- On platforms where the OS keeps generating **auto-repeat** keydowns into the newly
  focused window (X11 most notably), the bunny resumes on the first repeat. That is still a
  real keydown, so it is still the criterion, not a latch.

Both outcomes are correct and no code distinguishes them. Worth one sentence in the PR body
so the behaviour change is not reported as a bug ("my bunny doesn't move after alt-tab").

### AC5 — a browser test

See §3.

---

## 3. The test

**File** `test/browser.test.mjs` · **walk** `sound()` (starts line 1264) · insert after the
held-jump `wind_until` block that ends at line 1350, before the `M` mute section at line
1352.

**Why this walk.** The second half of `sound()` is already the exact rig this test needs and
the only one in the suite that can see the simulation move at all — the bundle exports
nothing to reach into (CLAUDE.md), so `window.__sounds` is the one observable. That half
sets up: a local room, a **pinned fake clock**, AI turned **off** on the empty seats so one
bunny is the only thing in the world that can make a noise, and `ArrowUp` **held down**
rather than pressed — with the comment at `browser.test.mjs:1341-1342` explaining why held
is the only thing that works on a fake clock ("no tick passes between a keydown and the
keyup that follows it"). `jump.mp3` landing repeatedly *is* the bunny moving; its absence
over five wound seconds *is* the bunny stopped, and line 1355-1363 already leans on exactly
that inference for the mute assertion.

The current code at the insertion point:

```js
// test/browser.test.mjs:1340-1353
    // Held down rather than pressed: no tick passes between a keydown and the keyup that
    // follows it on a fake clock, so a press is a key the simulation never sees.
    await forget_sounds(sound_page);
    await sound_page.keyboard.down("ArrowUp");
    await wind_until(
        sound_page,
        "a jump",
        async () => (await sounds(sound_page)).includes("jump.mp3"),
        500,
        20,
    );

    // M, which is a keyup in this game. The key stays down over it, so what is being
```

Insert between them:

```js
    // --- alt-tab with the key still down (#85) ---------------------------------------
    // The key is held and the browser is about to stop telling this page about it. What
    // used to happen is that the map kept saying pressed, so the bunny went on jumping --
    // and went on being stamped and sent to the whole room.
    // The event rather than a real tab switch: which window has focus is the window
    // manager's business and headless has no window manager, so a second tab brought to
    // the front is a different test on every machine. What is under test is what the page
    // does when the event lands.
    // ponytail: proves the handler, not that Chrome fires blur on alt-tab. upgrade path:
    // a second page and `bringToFront()`, if headless focus ever becomes something a suite
    // with no retries can lean on.
    await sound_page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await forget_sounds(sound_page);
    await sound_page.clock.fastForward(5000);
    assert.deepEqual(
        await sounds(sound_page),
        [],
        "blur let the key go: five wound seconds with ArrowUp still physically down, and " +
            "the one bunny in the room never jumped again",
    );

    // And it comes back on the next real keydown rather than from a latched state -- which
    // also puts the key back down for the mute assertion below, whose whole point is a
    // bunny that goes on jumping throughout.
    await sound_page.keyboard.up("ArrowUp");
    await sound_page.keyboard.down("ArrowUp");
    await wind_until(
        sound_page,
        "the jump to come back",
        async () => (await sounds(sound_page)).includes("jump.mp3"),
        500,
        20,
    );
```

Three things the implementer must not drop:

1. **The `up`/`down` restore is load-bearing, not tidiness.** The existing assertion at
   `browser.test.mjs:1355-1363` reads "muted is silent, not quiet: five seconds of held
   jump, and not one element played". After a flush the simulation thinks the key is up, so
   without the restore that assertion still *passes* but proves nothing — silence because
   nothing was jumping, not because mute works. Restoring the key keeps its meaning.
2. **A synthetic `blur` reaches `window.onblur`.** `dispatchEvent(new Event("blur"))` on
   `window` invokes the assigned handler; `isTrusted` is never read. And because focus never
   really moves, Playwright's subsequent `keyboard.up`/`keyboard.down` still land on the page.
3. **`fastForward` works on a blurred page** — the clock is Playwright's fake one and is not
   affected by a synthetic focus event.

Run it with `npm test` (which builds the client first). No other walk changes.

---

## 4. Risks

**`test/replay.test.mjs` determinism — clear.** The `src/game/` change is one method that
assigns `{}` to a private var. It reads no DOM, no clock, no `Math.random`. `replay.test.mjs`
builds `new Keyboard([])` (line 91) and drives `onKeyDown`/`onKeyUp` (lines 120, 146, 425);
none of those behave differently, and nothing in `src/game/` calls `release_all` — the only
two call sites are the two DOM assignments in `src/interaction/`. The FNV-1a checksum cannot
move. `src/game/keyboard.js` stays importable from node with no DOM, which is the invariant
CLAUDE.md names.

**Listener leaks across sessions and repairs — handled by using assignment.** `Game_Session`
is rebuilt per match (`viewmodels.js:527`) and again after every `lost_connection()`
(`viewmodels.js:880-892`). `window.onblur = ...` overwrites; `window.addEventListener("blur", ...)`
would not, and after ten matches ten dead keyboards would each get a flush. If a future
change converts the keydown/keyup pair to `addEventListener`, these two must move with it
and gain a removal path. Worth a review note on the PR.

**A stale session between matches.** After `end_match` nulls `current_game`, `window.onblur`
still points at the retired session's keyboard until the next `session()` overwrites it. A
blur in the lobby therefore flushes a keyboard nobody reads. Harmless, and identical to what
`document.onkeydown` already does today.

**The other browser walks — untouched.** `walk`, `self_ending_match`, `two_pages`,
`reconnect`, `browse`, `queueing`, `phone` (invoked at `browser.test.mjs:1682-1689`) never
dispatch a focus event and never hide a page, so none of them can trip the new handlers.
Playwright's `keyboard.press`/`down`/`up` do not move focus.

**`window.onblur` will not fire on element blur.** `blur` does not bubble, and an assigned
`onblur` is a non-capturing listener, so clicking out of the room-id input does not flush the
map. Checked because the tree has text fields on the flow screens (`is_typing`,
`game_session.js:461-468`) and a false flush there would be a new bug.

---

## 5. The seam for #86

`release_all()` is the defined "this client is holding nothing" operation, and #86
(sampling inputs correctly across a catch-up batch) is the first caller that will want it
for a reason other than a lost window. Today `Room.step()` re-reads `input_frame` on every
iteration of `pump`'s `while` loop (`game.js:124-155`), so one animation frame can sample the
live keyboard a dozen times and stamp a dozen different frames for a dozen ticks — whatever
the player's fingers happened to be doing at each of those microseconds. Whatever #86
replaces that with (a frame sampled once per batch, or a per-tick queue), it needs a single
authoritative way to say "and for these ticks, nothing was pressed" that does not synthesise
keyups and does not reach into the map — which is precisely this method, minus its DOM
callers. #51 (hidden-tab freeze) is the other one: freezing a client is only safe once
freezing it cannot leave a key latched, and the `visibilitychange` handler added here is the
same event #51 will hang the freeze off.

---

## 6. Deliberately not doing

- **Nothing for the `Connection lost` overlay.** It takes no focus (`src/jnb.html:128`, no
  `.focus()` in `src/`) and `lost_connection()` discards the keyboard outright
  (`viewmodels.js:880-892`). Flagged rather than dropped: it is prose in the issue body, not
  one of the five criteria.
- **No `pagehide` / `freeze` / `pageshow` handlers.** `blur` and `visibilitychange` cover
  every case the criteria name; `pagehide` is teardown, where no tick runs anyway.
- **No second assertion for the `visibilitychange` half.** Both events are assigned the same
  function reference, so a second dispatch would prove `dispatchEvent` works, not that the
  fix does twice. AC2 is satisfied by the registration, which is one line and readable.
- **No assertion that the *room* stops receiving the held key.** It is the same
  `input_frame` read (`game_session.js:78` → `room.js:257`) with no branch between the map
  and the wire — asserting it would mean a second relay walk with two pages for a failure
  mode that cannot exist separately. AC1's wire clause is covered by the one read path.
- **No `if (document.hidden)` guard**, no wrapper functions around `release_all`, and no
  removal/teardown API for the handlers. Assignment already is the teardown.
- **`keys_pressed` is not exposed, not even for the test.** The suite's discipline is that
  the bundle exports nothing to reach into; `jump.mp3` is the observable.
