# #90 — The room flow cannot be driven from the keyboard, and is never announced

Plan only. Repo `philipdzierzon/jump-n-bump`, read in the worktree
`/Users/philipdzierzon/Documents/sbx/jumpnbump/jump-n-bump/.claude/worktrees/90`, branch
`90-keyboard-screen-reader`, HEAD `f7c84fa` (the whole #81 stack: #82-#89 and #92-#95 all
landed). Every line number below is that tree's.

Last issue of the #81 chain. Held back until #88 because it attaches to the paragraphs #88
added, and #88's own review handed one item down explicitly: the lobby's `ready_cleared`
notice renders in a node bound `text: notice, visible: notice` — `display: none` at the
moment its text changes, which is the one shape a live region is never heard in.

**Nothing in the simulation, the relay, the router or the protocol changes.** Two production
files: `src/jnb.html` (attributes, six `<form>` wrappers, three CSS lines) and
`src/interaction/viewmodels.js` (one 9-line function, one call). Plus
`test/browser.test.mjs`. No new module, no new observable, no new string, no new dependency.

The whole issue is a case of using the platform: `<form>` submits on Enter with no JS at all,
`.focus()` is one line, `role="alert"` is an attribute. What is *not* lazy here is the
enumeration: AC1, AC2 and AC3 are each an "every" criterion, so §1 lists every text entry,
every screen change and every message node in the flow, and §2 says what happens to each.

---

## 1. What the code does today

### 1.1 Every text entry in the flow, and the button that does the same thing

`grep -c "<form" src/jnb.html` → **0**. There is no `<form>` element anywhere in the client,
so the browser has nothing to submit and Enter does nothing on any of these:

| # | node | screen | binding | same action, by mouse |
|---|------|--------|---------|----------------------|
| 1 | `jnb.html:151` `input.code` | create | `value: code, valueUpdate: 'input'` | `:153` `click: create_room, enable: !connecting()` |
| 2 | `jnb.html:161` `input.code` | join | `value: code, valueUpdate: 'input'` | `:162` `click: join_room` |
| 3 | `jnb.html:173` `input[type=password]` | password | `value: password, valueUpdate: 'input'` | `:174` `click: submit_password, enable: !connecting()` |
| 4 | `jnb.html:184` `input.grow` (one per participant, inside `foreach: participants`) | names | `value: name, valueUpdate: 'input'` | `:192` `click: take_seats, enable: participants().length > 0 && !connecting()` |
| 5 | `jnb.html:243` `input[type=number]` "Bumps to win" | lobby settings | `value: form.bump_limit, valueUpdate: 'input'` | `:249` `click: apply_config` |
| 6 | `jnb.html:246` `input[type=number]` "Minutes" | lobby settings | `value: form.time_limit, valueUpdate: 'input'` | `:249` `click: apply_config` |
| 7 | `jnb.html:253` `input[type=password]` "New password" | lobby settings | `value: new_password, valueUpdate: 'input'` | `:255` `click: set_password` |

Non-text controls in the flow, for completeness — none of them is an AC1 case, all of them
are AC2/AC4 cases (they have to be reachable and operable by Tab, which they already are):
`:152` the `listed` checkbox, `:233` the level `<select>`, `:236` `input[type=file]`,
`:239`/`:241` the flag and AI-fill checkboxes, `:229` the `<details>` summary.

The only `keydown` listener the flow has is `viewmodels.js:1263-1269`, and it is about the
couch, not about Enter:

```js
    window.addEventListener("keydown", function (evt) {
        if (self.screen() !== "names" || is_typing(evt)) return;
        var scheme = jump_scheme(evt.keyCode);
        if (scheme < 0) return;
        add_participant(scheme);
        evt.preventDefault();
    });
```

`is_typing` (`game_session.js:511-517`) returns true for `INPUT`, `TEXTAREA` and
`contentEditable`. **This is the single most important fact for AC2:** the names screen's
form *is* the keyboard — a focused text box swallows `↑`, `W`, `NumPad 8` and `I`, and
`browser.test.mjs:391-397` already asserts exactly that ("typing a w into a name box does not
add a seat"). Focusing a name input on entry to that screen would break the one screen whose
whole interaction is a bare key press.

`game_session.js:489-495` (`document.onkeydown` → `keyboard.onKeyDown`) never calls
`preventDefault`, and `src/game/keyboard.js:29-35` only records the key — so **Tab still moves
focus during a match**, which is what makes AC4's "get out of the match by keyboard" possible.

### 1.2 Every screen change, and what focus does after it

`self.screen` is declared at `viewmodels.js:132` and written in exactly **one** place:

```js
        self.screen(route.screen);                                  // viewmodels.js:1031
```

inside `apply_route()` (`:1021-1057`). Three things call it:

- `window.addEventListener("hashchange", apply_route)` — `:1060`
- `go(hash, replace)` — `:436-444`, which calls `apply_route()` by hand when the hash is
  already the one being routed to, and otherwise lets `hashchange` do it
- the constructor's last line, `apply_route();` — `:1348`, i.e. **before**
  `ko.applyBindings(new ViewModel())` at `:1351` has hidden anything

Every route into the flow, all through that one line: the five landing buttons
(`go_quick` `:1083`, `go_create` `:1068`, `go_join` `:1073`, `go_browse` `:1089`,
`play_offline` `:1126`), `create_room`/`join_room`/`submit_password`/`take_seats`
(`:1133`-`:1196`), `join_listed` `:1117`, `go_lobby` `:1122`, `go_landing` `:1064`,
`to_lobby_soon` `:507-518`, the three landing failure paths (`:916-917`, `:937-938`,
`give_up` `:984-987`), the countdown-zero bounce to names (`:771`), `enter()`'s
`go("room"|"password", true)` (`:1011-1013`), the `apply_route` fallbacks themselves
(`:1033`, `:1041`, `:1042`, `:1049`), the browser's Back/Forward, and a reload.

What focus does after any of them: **nothing**. `grep -rn "focus()\|autofocus\|tabindex" src/`
→ no hits. The only ARIA in the tree is three attributes: `jnb.html:89`
(`'aria-label': label` on a board swatch), `:184` (`aria-label="name"`) and `:186`
(`aria-label="remove"`). Knockout's `visible` binding sets `style.display = "none"`, so the
control that had focus is hidden out from under it, the browser blurs it, and
`document.activeElement` becomes `<body>`. The player tabs down from the top of the page
again — past the five landing buttons, on every transition.

### 1.3 Every message node in the flow

Exhaustive. "Shape" is what matters: a node that is always laid out and whose text changes is
the shape a live region is announced in; a node that is `display: none` until it has something
to say is not in the accessibility tree at all while it is quiet.

**Errors** — seven, one per screen, all `class="err"`, all always rendered (no `visible:`
binding), all fed by the one `this.error` observable (`:146`), with
`.err { min-height: 1em }` (`jnb.html:26`) keeping the empty box laid out. #88 built this
deliberately and §4 of its plan says so:

| node | screen |
|------|--------|
| `jnb.html:145` `text: error` | landing |
| `jnb.html:154` `text: error` | create |
| `jnb.html:163` `text: error` | join |
| `jnb.html:175` `text: error` | password |
| `jnb.html:193` `text: error` | names |
| `jnb.html:261` `text: error` | lobby |
| `jnb.html:283` `text: rooms_error() || error()` | browse |

What lands in them, and where the screen already is when it does — in place (the announceable
case) or one route earlier (the reveal case):

*in place:* `CODE_HINT` from `create_room` `:1135` and `join_room` `:1140`; `"That code is
taken."` `:932`; `NAME_TAKEN` `:919`; `BAD_NAME` `:921`; `OUT_OF_DATE` `:923`; `SEAT_TAKEN`
`:930`; `FLOW_TEXT.unavailable` on the password screen `:940`; `"Getting back into the match
did not work. Try again."` (#89, `:716`); `"That level would not load…"` `:274`; `"This client
does not have that level…"` `:251`; `"That file is not a level."` `:1343`;
`FLOW_TEXT.rooms_failed` `:1111`.

*set one route before the pane is revealed:* `FLOW_TEXT.dropped` `:916` → landing;
`FLOW_TEXT.room_gone` `:937` → landing; `FLOW_TEXT.gave_up` `:986` → landing;
`FLOW_TEXT.vacated` `:784` → names; `FLOW_TEXT.unavailable` `:947` → browse and `:954` →
password. Six messages whose text is in the node *before* it becomes visible. This distinction
is §4's honest limit, not something the fix can wish away.

**Status and outcome lines** — ten, every one `visible:`-toggled:

| node | binding | what it reports |
|------|---------|-----------------|
| `jnb.html:128` | `visible: connection_text, text: connection_text` | the socket went / is back, over a live match |
| `jnb.html:160` | `visible: pending_id` — `Connecting…` | a join is in flight (the other half of #89's `enable: !connecting()`) |
| `jnb.html:191` | `visible: match_running` | seats taken while a match runs, on the names screen |
| `jnb.html:200` | `visible: disconnected`, `class="banner alarm"` | connection lost, seats held |
| `jnb.html:207` | `visible: staged_text` | the host staged a config change and cleared everyone's ready |
| `jnb.html:221` | `visible: match_running() && !seated()` | same as `:191`, in the lobby |
| `jnb.html:222` | `visible: queued` | every seat taken, you are in the queue (#44) |
| `jnb.html:228` | `text: waiting_text, visible: !is_host()` | who the room is waiting on; changes on host migration (#88) |
| `jnb.html:260` | `text: notice, visible: notice` | `ready_cleared` (#88), `Password set.`, `Password removed.` |
| `jnb.html:264` | `text: result_text, visible: result_text` | how the last match ended |

`jnb.html:260` is the one #88's review named: `visible: notice` makes it `display: none` at the
instant `apply_room` (`:740`) writes `FLOW_TEXT.ready_cleared` into it.

**Not messages** — labels and one ticker, listed so it is on the record that they were
considered and left alone: `:137` the tagline, `:150`, `:172`, `:181` instructions, `:189`
"Nobody yet.", `:190` "These seats are taken…", `:203-204` the share link, `:220` "Every seat
in the room…", `:248`, `:256`, `:258` settings help, `:282` "Nothing public right now…",
`:118-123` the top bar's clock and key list, `:214-216` the seat rows, and **`:225` the
countdown**, which rewrites itself once a second and would talk over everything else on the
screen.

---

## 2. The fix, per acceptance criterion

### AC1 — every text entry submits on Enter, to the same action as its button

Rung: **the platform**. A `<form>` submits on Enter with no JS; Knockout's `submit` binding
already exists and already calls `preventDefault` for us, so there is no navigation and no
handler to write. Six wrappers, one per form in the flow. A `<button>` in a form is a submit
button by default, so the primary buttons need no `type` — they drop their `click:` binding
instead, because a click on a submit button submits the form and the handler runs either way.
This is a deletion, not an addition: six `click:` bindings out, six `submit:` bindings in.

**What stops a naive `<form>` from breaking the existing walk** — three things, all deliberate:

1. **Knockout's `submit` binding calls `event.preventDefault()`** unless the handler returns
   exactly `true` (`node_modules/knockout/build/output/knockout-latest.debug.js:5184-5188`:
   `if (handlerReturnValue !== true) { if (event.preventDefault) event.preventDefault(); … }`). None of the six handlers can
   return `true`: `create_room` and `join_room` return `self.error(CODE_HINT)` (a Knockout
   observable returns *itself* on write), `take_seats` returns `go(...)`, and
   `submit_password`/`apply_config`/`set_password` return `undefined`. So no form ever
   navigates, and `test/browser.test.mjs`'s 20-odd `click("Create")` / `click("Take the
   seats")` / `click("Apply to the next match")` / `click("Set it now")` calls keep working
   unchanged — the click submits, the submit calls the same function.
2. **`type="button"` on the names screen's `×`** (`jnb.html:186`). Implicit submission
   activates the *first* submit button in tree order, and inside the names form that would be
   the remove button of the first participant — Enter in a name box would drop the seat
   instead of taking it. This is the only button in the file that ends up inside a form
   without wanting to be one.
3. **`novalidate` on the settings form.** `bump_limit`/`time_limit` carry `min`/`max`/`step`
   (`:243`, `:246`), so submitting would run native constraint validation and block on an
   out-of-range or blank box with a native bubble. `config_diff`
   (`src/net/room_config.js:98-103`) already drops those values silently, and the mouse path
   must behave exactly as it does today. One attribute keeps both paths identical.

Knockout's handler is called as `value.call($data, element)`, i.e. the form element arrives as
the first argument. All six handlers take no parameters (`:1133`, `:1138`, `:1145`, `:1176`,
`:1296`, `:1319`), so nothing reads it.

The exact shipped markup, `src/jnb.html` (hand-indented; the file is in `.prettierignore`,
and `npm run format:check` will not touch it):

**create**, replacing `:151-153`:

```html
        <form data-bind="submit: create_room">
            <input class="code" maxlength="5" placeholder="CODE" data-bind="value: code, valueUpdate: 'input'" />
            <label><input type="checkbox" data-bind="checked: listed" /> Show it in the public list</label>
            <button class="pri" data-bind="enable: !connecting()">Create</button>
        </form>
```

**join**, replacing `:161-162`:

```html
        <form data-bind="submit: join_room">
            <input class="code" maxlength="5" placeholder="CODE" data-bind="value: code, valueUpdate: 'input'" />
            <button class="pri">Continue</button>
        </form>
```

**password**, replacing `:173-174`:

```html
        <form data-bind="submit: submit_password">
            <input type="password" placeholder="Password" data-bind="value: password, valueUpdate: 'input'" />
            <button class="pri" data-bind="enable: !connecting()">Continue</button>
        </form>
```

**names**, wrapping `:182-192`. The three muted paragraphs sit between the list and the button
in document order and come along inside the form rather than being moved — a `<p>` in a form
is legal, and moving them would be a bigger diff than the change itself:

```html
        <form data-bind="submit: take_seats">
            <ul class="seats" data-bind="foreach: participants">
                <li>
                    <input class="grow" maxlength="16" data-bind="value: name, valueUpdate: 'input', attr: { readonly: $parent.seated }" aria-label="name" />
                    <small data-bind="text: $parent.scheme_name(scheme)"></small>
                    <button type="button" class="sm" data-bind="click: $parent.drop_participant, visible: !$parent.seated()" aria-label="remove">&times;</button>
                </li>
            </ul>
            <p class="muted" data-bind="visible: participants().length === 0">Nobody yet.</p>
            <p class="muted" data-bind="visible: seated">These seats are taken and keep their names for as long as you are in the room.</p>
            <p class="muted" role="status" data-bind="visible: match_running">A match is in progress; you are in for the next one.</p>
            <button class="pri" data-bind="enable: participants().length > 0 &amp;&amp; !connecting(), text: seated() ? 'Back to the lobby' : 'Take the seats'"></button>
        </form>
```

**the lobby's two settings panels**, wrapping `:231-250` and `:251-257`:

```html
            <form novalidate data-bind="submit: apply_config">
                <fieldset data-bind="enable: is_host">
                    ... unchanged ...
                    <button class="sm">Apply to the next match</button>
                </fieldset>
            </form>
            <form data-bind="submit: set_password">
                <fieldset data-bind="visible: room_id, enable: is_host">
                    ... unchanged ...
                    <button class="sm">Set it now</button>
                </fieldset>
            </form>
```

and one CSS line so the wrappers change no layout at all — the screens are flex columns with
a `gap`, and a `<form>` box would collapse each wrapped group into a single gapless flex item:

```css
        /* A form here is the Enter key and nothing else: the screens lay their own controls
           out, so the wrapper must not become a flex item of its own (#90). */
        form { display: contents; }
```

`display: contents` removes the box and nothing else — submission is not a layout behaviour,
and the element stays in the accessibility tree (an unnamed `<form>` is not exposed as a
landmark either way).

Entry 6 ("Minutes") shares its form with entry 5 ("Bumps to win"), so one form covers both.
The browse and landing screens have no text entry and get no form.

### AC2 — after a screen change, focus lands on that screen's first meaningful control

Rung: **one line of platform, called from the one place screens change**. No focus-management
abstraction, no screen→control table, no registry: the panes are in document order, Knockout
hides the ones it is not showing, so *the first control the browser still lays out belongs to
the screen just routed to*. The markup declares its one exception with a `tabindex`.

`src/interaction/viewmodels.js`, directly above `apply_route` (`:1021`):

```js
    // Focus follows the screen, or a keyboard player tabs down from the top of the page after
    // every transition (#90). No table of screens: the panes are in document order and
    // Knockout hides the ones it is not showing, so the first control still laid out belongs
    // to the screen just routed to. A pane with a `tabindex` of its own is taken instead of
    // its first control -- the names screen's form *is* the keyboard, and `is_typing`
    // (game_session.js:511) would swallow the jump keys into a focused text box. The match
    // screen has no control inside a `.kiosk`, so this is a no-op there, which is what the
    // issue's "in-game controls are out of scope" asks for.
    function focus_screen() {
        // Only when focus has nowhere to be. The screen that went took its control's focus
        // with it, so this is the transition case; a route onto the screen already showing
        // (`go("room")` from a match that ended) must not steal the box somebody is typing in.
        var here = document.activeElement;
        if (here && here !== document.body && here.offsetParent) return;
        var targets = document.querySelectorAll(
            ".kiosk[tabindex], .kiosk input, .kiosk select, .kiosk button",
        );
        for (var i = 0; i < targets.length; i++)
            if (targets[i].offsetParent && !targets[i].disabled) return targets[i].focus();
    }
```

and one line at the end of `apply_route`, after `:1056`:

```js
        if (route.room_id) enter(route.room_id);
        // Queued, not immediate: this function also runs once from the constructor (:1348),
        // before `ko.applyBindings` (:1351) has hidden a single pane.
        queueMicrotask(focus_screen);
```

Why each piece is there, and nothing else is:

- **`offsetParent`** is null for anything inside a `display: none` pane, and also for the
  contents of a closed `<details>` — so the collapsed room settings are skipped for free.
- **`!disabled`** skips `Create`/`Continue`/`Take the seats` while `connecting()` (#89) and
  `Take the seats` on an empty couch. A disabled control cannot take focus anyway; the check
  only stops the loop from stopping there.
- **`.kiosk` scope** is what makes the match screen a no-op: the top bar is `.top-bar`
  (`:113`), the canvas is `.canvas-container` (`:126`), and the only `.kiosk` on that screen is
  the board overlay (`:129`), which contains no control. Zero special-casing for `play`.
- **the `activeElement` guard** is the whole of "do not steal focus": `apply_route` runs again
  on same-screen routes (`go()` `:439`, `to_lobby_soon` `:511`), and without it a match ending
  elsewhere would yank the cursor out of the lobby's password box.
- **`queueMicrotask`** rather than a timer: it runs after the synchronous module body, so a
  cold load on `#create` or `#browse` focuses the right pane; every `await` in the browser test
  flushes it, so no test needs a wait for it.

The one markup change AC2 needs, on the names pane (`jnb.html:179`):

```html
    <div data-bind="visible: screen() === 'names'" class="kiosk" tabindex="-1">
```

Focus lands on the panel itself, which is the standard route-change target: a screen reader
reads the pane it is focused into — "who is playing on this keyboard? Press the jump key of
every control scheme you want…" — which is the one sentence a blind player on that screen
cannot do without, `↑`/`W`/`NumPad 8`/`I` keep working because a `<div>` is not `is_typing`,
and Tab from the pane goes straight to the first name input. Without the `tabindex` the loop
would stop on **`Start over`** (`:194`, the only enabled control on an empty couch), which is
the way out of the flow and says nothing about jump keys.

Where focus lands, per screen, after this change:

| screen | first target | note |
|--------|--------------|------|
| landing | `:138` `Quick Join` | also on a cold load of `/` |
| create | `:151` `input.code` | type, Enter — AC1 and AC2 compose |
| join | `:161` `input.code` | same |
| password | `:173` `input[type=password]` | same |
| names | `:179` the pane | the exception above |
| room, online | `:205` `Copy join link` | first control in document order inside `visible: room_id` |
| room, offline | `:226` `Start the match` | `:205` and the seat buttons are bound away offline (`takeable` is `!!room_id && …`, `viewmodels.js:382`) |
| browse | first row's `Join` (`:279`), else `:284` `Create a room` | depends on the list |
| play | nothing — deliberately | see above |

### AC3 — errors and status messages are announced when they appear

Rung: **an attribute**. `role="alert"` is `aria-live="assertive"` plus `aria-atomic`;
`role="status"` is the polite one. Seventeen attributes, one binding deletion, one CSS line.
No JS, no observable, no wrapper element.

**The seven error paragraphs get `role="alert"`** and nothing else, because #88 already built
them in the shape a live region needs — always rendered, `min-height: 1em`, text changing in
place:

```html
        <p class="err" role="alert" data-bind="text: error"></p>
```

at `:145`, `:154`, `:163`, `:175`, `:193`, `:261`, and at `:283` with its
`text: rooms_error() || error()`. All seven hold the same observable, but six of them are
inside a hidden pane and therefore not in the accessibility tree, so one error is one
announcement.

**The lobby notice stops hiding itself** — #88's review item, `:260`:

```html
        <p class="muted notice" role="status" data-bind="text: notice"></p>
```

`visible: notice` deleted. The region is now in the page, empty, before `apply_room` writes
`FLOW_TEXT.ready_cleared` (`:740`), `set_password` writes `Password set.` (`:1321`) or
`leave_room` clears it (`:486`) — which is the only way a live region is heard. It needs a box
to be a rendered region, so the existing `min-height` rule at `jnb.html:26` is split to cover
it:

```css
        .err { color: #e4572e; font-size: 13px; }
        /* Laid out empty, both of them: a live region is announced on a change while it is in
           the page, never on being revealed with the message already inside it (#88, #90). */
        .err, .notice { min-height: 1em; }
```

Cost: one blank line of space in the lobby, above the error line that is already always there.

**The ten status lines get `role="status"`** — `:128`, `:160`, `:191`, `:200` (`role="alert"`,
not status: the connection going is the loudest thing in the flow), `:207`, `:221`, `:222`,
`:228`, `:260` (above), `:264`. Attribute only; every existing binding stays, including the
`visible:` bindings three browser-test assertions depend on
(`browser.test.mjs:444`, `:461`, `:665` assert `div.banner` is *not* visible).

The rule, stated once so a reviewer can check it rather than guess at it: **a paragraph the
flow reports an outcome through is a live region; a label and a ticker are not.** The only
exclusion is `:225`, the countdown, which rewrites itself every second and would interrupt
everything else a screen reader is saying. §1.3's third table is the full list of what that
leaves out and why.

### AC4 — the whole flow is completable with the keyboard alone

No code of its own. It is AC1 plus AC2 plus what already worked: `<details>` toggles on Enter,
buttons activate on Enter and Space, the couch fills from `↑`/`W`/`NumPad 8`/`I`, and Tab still
moves during a match because nothing calls `preventDefault` on the game's keys
(`game_session.js:489`, `keyboard.js:29`). AC5's walk is the proof; §3 lists the path.

---

## 3. Tests, criterion by criterion

`focus_screen` lives in `viewmodels.js`, which ends in `ko.applyBindings(new ViewModel())` at
module scope (`:1351`) and reads `window` on the way — `test/router.test.mjs` cannot import it,
and roles and forms are markup. So **everything here is `test/browser.test.mjs`, and
`test/router.test.mjs` gets nothing**: no string moves, no pure function changes.

One new section, `keyboard_only()`, on its own context and page, called from the run block
after `walk()`. One new room id beside the others (`:46-63`): `const room_o = new_room_id();`.

### New helpers (beside the existing ones at `:160-358`)

```js
// What the next key would go to. `BODY` is the bug (#90): a screen change that leaves focus on
// the document makes a keyboard player tab down from the top of the page again.
const focused = (root = page) =>
    root.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return "BODY";
        const name = el.tagName + (el.className ? "." + el.className.split(" ")[0] : "");
        // A button by its label, an input by its type: what a player would call the thing they
        // are about to press or type into.
        if (el.tagName === "BUTTON" || el.tagName === "SUMMARY")
            return name + ":" + el.textContent.replace(/\s+/g, " ").trim();
        return el.tagName === "INPUT" ? name + ":" + el.type : name;
    });
// AC2's claim where the first control is not deterministic (Browse lists whatever rooms the
// rest of the suite has left up).
const focus_in = (name, root = page) =>
    screen(name, root).evaluate(
        (pane) => pane.contains(document.activeElement) && document.activeElement !== document.body,
    );
// Tab until the label has focus, which is the reach assertion itself: a control no number of
// Tabs arrives at is a control the flow cannot be driven to.
async function tab_to(label, root = page, key = "Tab") {
    for (let i = 0; i < 30; i++) {
        if ((await focused(root)).endsWith(label)) return;
        await root.keyboard.press(key);
    }
    assert.fail(key + " 30 times never reached " + label + ", stopped on " + (await focused(root)));
}
```

and, in `make_context` (`:107-125`) beside the two `addInitScript`s already there:

```js
    // A real mouse click reports `detail >= 1`; a button activated by Enter or Space reports 0.
    // This is what keeps AC5's walk a keyboard walk after somebody edits it (#90).
    await made.addInitScript(() => {
        window.__mouse = 0;
        addEventListener("click", (event) => event.detail > 0 && window.__mouse++, true);
    });
```

### The walk

```js
// Driven by keys and nothing else (#90): every screen change asserts where focus landed, every
// text box is submitted with Enter, and a mouse click anywhere in it fails the last assertion.
async function keyboard_only() { ... }
```

Phase by phase, with the assertion each phase exists for:

1. **Load.** `goto(origin + "/")`, `on("landing")`, then
   `assert.equal(await focused(kb), "BUTTON.pri:Quick Join")` — focus on a cold load, through
   the `queueMicrotask` ordering. Set the no-navigation sentinel:
   `await kb.evaluate(() => (window.__same_page = true))`.
2. **Landing → create by key.** `tab_to("Create a room", kb)`, `press("Enter")`,
   `on("create")`, `assert.equal(await focused(kb), "INPUT.code:text")`.
3. **AC1 in place, AC3 in place.** `keyboard.type("ABC")`, `press("Enter")`. Three letters is
   not a room id, so `create_room` (`:1133-1136`) answers `CODE_HINT` synchronously with no
   socket — which *only* `create_room` sets, so the message is proof the Enter reached it:
   ```js
   const said = (name, root) => screen(name, root).getByRole("alert").allInnerTexts();
   assert.deepEqual(await said("create", kb), [""], "the alert region is in the page, empty");
   ...
   await until("the refusal", async () =>
       (await said("create", kb)).some((line) => line.includes("5 letters")));
   ```
   `getByRole("alert")` is the discriminator: Playwright's role engine skips hidden elements,
   so it resolves only while the region really is in the page and carrying the text. A
   `visible:`-toggled paragraph and a paragraph with no `role` both match nothing.
4. **Create for real.** `press("Control+A")`, `type(room_o)`, `press("Enter")`, `on("names")`.
5. **The names exception.** `assert.equal(await focused(kb), "DIV.kiosk")` and
   `assert.ok(await focus_in("names", kb))`, then `press("ArrowUp")` and
   `until(... seats(kb).count() === 1)` — the jump key still reaches the couch with the screen
   focused, which a focused name box would have swallowed.
6. **AC1 on the names form.** `press("Tab")`,
   `assert.equal(await focused(kb), "INPUT.grow:text")`, `press("Enter")`, `on("room")`.
7. **Lobby focus.** `assert.equal(await focused(kb), "BUTTON.sm:Copy join link")`.
8. **A keeper client** so the room outlives step 12's `Leave`:
   `relay_client({ type: "join", id: room_o }, keeper_saw)` (`:348-355`), before the password is
   set. No seats, so it neither readies nor blocks a start.
9. **AC1 on the settings form, AC3 on the staged banner.** `tab_to("Room settings", kb)`,
   `press("Enter")` (native `<details>`), `tab_to(":number", kb)`, `press("Control+A")`,
   `type("3")`, `press("Enter")`, then
   `until("the staged change", () => screen("room", kb).getByRole("status").filter({ hasText: "Host staged" }).count())`
   — one assertion for the Enter reaching `apply_config` and for the banner being a live region
   that is in the page while it says it.
10. **AC1 on the password form, AC3 on the notice.** `tab_to(":password", kb)`,
    `type("hunter2")`, and before the Enter:
    ```js
    const live = screen("room", kb).locator('p[data-bind*="text: notice"]');
    assert.equal(await text(live), "", "nothing said yet");
    assert.ok(
        await live.isVisible(),
        "and the region is already in the page: a live region is announced on a change while " +
            "it is there, never on being revealed with the message already inside it (#88, #90)",
    );
    ```
    then `press("Enter")` and `until(... (await notice(kb)) === "Password set.")` plus the same
    `getByRole("status")` lookup for the text. The `isVisible()` before the Enter is the whole
    point: it is false the moment anybody restores `visible: notice`, and false if the
    `min-height` rule is dropped.
11. **AC4 to a match.** `tab_to("Ready", kb, "Shift+Tab")` (Ready is *above* the settings in
    document order, so backwards), `press("Enter")`,
    `until(... text(ready) === "Not ready")`, `tab_to("Start the match", kb)`,
    `press("Enter")`, `on("play")`.
12. **AC2's deliberate no-op, and out again.**
    `assert.equal(await focused(kb), "BODY", "the match screen focuses nothing of its own")`,
    then `tab_to("Back to the lobby", kb)`, `Enter`, `on("room")`, `tab_to("Leave", kb)`,
    `Enter`, `on("landing")`, `assert.equal(await focused(kb), "BUTTON.pri:Quick Join")`.
13. **AC1 on the join and password screens.** `tab_to("Join with a room code", kb)`, `Enter`,
    `on("join")`, `assert.equal(await focused(kb), "INPUT.code:text")`, `type(room_o)`,
    `press("Enter")` → the room now has a password, so the relay refuses
    (`server/index.js:190-191`) and the flow lands on the password screen (`viewmodels.js:954`):
    `on("password")`, `assert.equal(await focused(kb), "INPUT:password")`,
    `until(... said("password", kb) includes "not available")`, `type("hunter2")`,
    `press("Enter")`, `on("names")`.
14. **The two sweeps, because AC3 is an "every" criterion.**
    ```js
    const unroled = await kb.evaluate(
        () =>
            [...document.querySelectorAll('div[data-bind*="screen() ==="] p.err')].filter(
                (el) => el.getAttribute("role") !== "alert",
            ).length,
    );
    assert.equal(unroled, 0, "every screen's error line is an alert region (#90)");
    ```
    and the ten status nodes by the binding that fills each one, so a missed attribute names
    itself:
    ```js
    // The paragraphs the flow reports an outcome through, each found by its own binding.
    const LIVE = [
        "text: connection_text",          // the match's reconnect line
        "visible: pending_id",            // Connecting...
        'visible: match_running"',        // the names screen's
        "visible: disconnected",          // connection lost
        "visible: staged_text",           // the host staged a change
        "visible: match_running() &&",    // the lobby's
        "visible: queued",                // the queue
        "text: waiting_text",             // who the room waits on
        "text: notice",                   // ready cleared, password set
        "text: result_text",              // how the last match ended
    ];
    const roles = await kb.evaluate(
        (binds) =>
            binds.map((bind) => {
                const el = document.querySelector('[data-bind*="' + bind + '"]');
                return el ? el.getAttribute("role") : "missing";
            }),
        LIVE,
    );
    assert.deepEqual(
        roles,
        ["status", "status", "status", "alert", "status", "status", "status", "status", "status", "status"],
        "every line the flow reports an outcome through is a live region (#90)",
    );
    ```
15. **The two guards.**
    ```js
    assert.ok(await kb.evaluate(() => window.__same_page === true), "no form ever navigated");
    assert.equal(await kb.evaluate(() => window.__mouse), 0, "and no step used the mouse");
    assert.deepEqual(errors, [], "and the page threw nothing");
    ```

### The mutation per criterion — what must turn a **named** assertion red

Three assertions in this chain shipped vacuous. Each of these was chosen so the fix is the
only thing that satisfies it, and each names the assertion that dies.

| AC | mutation | assertion that must fail |
|----|----------|--------------------------|
| **AC1** | delete `data-bind="submit: create_room"` from the create `<form>` | step 3's `"the refusal"` never appears (the Enter goes nowhere), **and** step 15's `"no form ever navigated"` fails, because an unhandled submit reloads the page and takes the sentinel with it |
| **AC1** (second shape) | put `click: create_room` back on the button *and* keep the form handler | nothing fails — and that is why the plan deletes the `click:` instead of adding beside it; noted so a reviewer checks the diff removes it |
| **AC2** | delete `queueMicrotask(focus_screen)` from `apply_route` | step 2's `assert.equal(await focused(kb), "INPUT.code:text")` reads `"BODY"`, and five more focus assertions with it |
| **AC2** (the exception) | remove `tabindex="-1"` from the names pane | step 5's `assert.equal(await focused(kb), "DIV.kiosk")` reads `"BUTTON.sm:Start over"` |
| **AC2** (the guard) | delete the `activeElement` early return in `focus_screen` | nothing in this walk fails — an honest gap; the behaviour it protects (a match ending while the host types in the lobby) has no cheap browser test, and the guard is three lines with a comment naming the case. Stated here rather than claimed as covered. |
| **AC3** | delete `role="alert"` from the create screen's `p.err` | step 3's `getByRole("alert")` resolves nothing → `until("the refusal")` times out; step 14's `unroled` counts 1 |
| **AC3** | restore `visible: notice` on `jnb.html:260` | step 10's `"the region is already in the page"` fails — the exact failure mode #88's review handed down |
| **AC3** | drop `.notice` from the `min-height` rule | the same `live.isVisible()` assertion fails: an empty paragraph with no box is not a rendered region, for Playwright or for a screen reader |
| **AC3** | delete `role="status"` from the staged banner | step 9's `getByRole("status")` lookup times out; step 14's `deepEqual` reports `null` in that slot |
| **AC4** | remove `type="button"` from the names `×` | step 6's `on("room")` times out: Enter in the name box activates the first submit button in the form, which is the remove button, and the couch empties instead |
| **AC4** | remove `novalidate` from the settings form and leave a number box blank | step 9's `"the staged change"` times out on the native validation bubble |
| **AC5** | replace any `press("Enter")` in the walk with `.click()` | step 15's `"no step used the mouse"` fails — `detail > 0` for a real click, `0` for a key-activated one |

---

## 4. What cannot honestly be built or tested here

Both of these go in the **PR body**, under the ACs they qualify. Neither is a reason to hold
the issue, and neither warrants a new issue — there is nothing to build until somebody listens
to the page with a screen reader.

1. **No assertion in this repo proves audible speech.** There is no assistive technology in
   CI. What the tests prove is everything short of it: the role is on the node, the node
   resolves through Playwright's role engine (which excludes hidden elements), and the region is
   laid out and empty *before* the message arrives. That is the difference between a message
   announced and a message merely rendered, and it is the strongest claim this suite can make.
   `page.accessibility.snapshot()` would add nothing — it reports the tree, not the live-region
   events, and it is Chromium-only and deprecated.
2. **Six messages are set one route before their pane is revealed**, and for those, whether the
   announcement happens at all is the browser's call, not the markup's:
   `FLOW_TEXT.dropped`/`room_gone`/`gave_up` → landing (`viewmodels.js:916`, `:937`, `:986`),
   `vacated` → names (`:784`), `unavailable` → browse (`:947`) and → password (`:954`). The text
   is already in the node when `display: none` lifts, so there is no change *while* the region
   is in the page; Chromium does fire a live-region event for a revealed `role="alert"` subtree,
   which is why the shape is worth shipping, but it is not guaranteed across screen readers and
   it cannot be measured from here. **Do not ship a workaround on a guess.** If a manual
   NVDA/VoiceOver pass finds those six silent, the fix is one line in `focus_screen` —
   `self.error.valueHasMutated()` once the pane is up, which re-writes the text into a region
   that is now visible. Named, not built.

Two smaller things, same place:

3. **AC4 is proved along one path**, not all of them: landing → create → names → lobby →
   settings → match → lobby → landing → join → password → names. Quick Join, Browse's `Join`
   row and `Play offline` route through the same `apply_route` and the same forms and are
   covered by the focus and role sweeps rather than by a walk of their own.
4. **`Connecting…` exists only on the join screen** (`jnb.html:160`). Press Create or Continue
   on the create and password screens and the button quietly disables (#89) with nothing said.
   That is missing *copy*, which is #88's kind of work, not a role — recorded in the PR body,
   not fixed here.

---

## 5. Scope, and what could break

### Deliberately not doing

- **A focus-management module, a key-handler registry, or a screen→control table.** The DOM is
  already the table: document order plus `display: none`. One `querySelectorAll` and one
  `tabindex` in the markup cover every screen including the exception.
- **`autofocus`.** It fires on parse, and these screens are toggled with `visible:`, so it
  would help the landing page once and nothing else. `focus_screen` covers that case too.
- **Touch input and the names screen's touch path** — #45, out of scope per the issue.
- **In-game controls and an audit of the match canvas** — out of scope per the issue. The
  `.kiosk` scope makes the match screen a no-op rather than a special case, and the one
  attribute the match screen does get is `role="status"` on the reconnect line (`:128`), which
  is flow copy, not a control.
- **A live region on the countdown** (`:225`). It rewrites every second and would talk over
  every other announcement on the screen.
- **Rewording anything.** #88 owns the copy. The two weak `aria-label`s on the names screen
  (`:184` `"name"`, `:186` `"remove"` — neither says *whose*) are left alone for the same
  reason; worth an issue of its own if the maintainer wants them read properly.
- **Removing the focus ring from the names pane.** A UA outline around the panel tells a
  sighted keyboard player where focus went. If it looks wrong in review, one line
  (`.kiosk[tabindex]:focus { outline: none }`) fixes it.
- **`aria-describedby` from a screen's first control to its error paragraph.** It would make the
  six reveal-case messages audible on focus — and it needs an `id` per screen plus an attribute
  per control, on a guess about the six, before anybody has listened to the page. See §4.2.

### Risks to the existing walk

- **Every `click()` on a primary button now goes through `submit`.** `Create` (`:579`, `:842`,
  `:1128`, `:1641`, `:1696`, `:1987`), `Continue` (`:753`, `:944`, `:1581`, `:1894`, `:2109`, `:2217`), `Take the seats`
  (19 call sites),
  `Apply to the next match` (`:459`, `:465`, `:550`, `:565`, `:668`, `:688`, `:1047`, `:1381`,
  `:1706`),
  `Set it now` (`:698`, `:725`). All keep working: the click submits the form, Knockout's
  `submit` binding runs the same handler and cancels the default. If any one of them ever
  starts reloading the page, the cause is a handler that returned exactly `true`.
- **`button("Create", dbl).dblclick()`** (`:1664`) and `disabled(button("Create", solo))`
  (`:1643`) are #89's assertions. `enable: !connecting()` stays on the button, a disabled
  submit button neither fires a click nor submits, so the second click of the double still does
  nothing and `el.disabled` still reads `true`.
- **Implicit submission picks the first submit button in the form.** Only the names form
  contains another button; `type="button"` on the `×` is what keeps Enter off it. Any future
  button added inside a form needs the same attribute.
- **`form { display: contents }`** keeps the flex layout byte-identical, so `phone()`
  (`:1826-1854`) still finds nothing running off the side. A plain `<form>` box would collapse
  each group into one gapless flex item — visible, but not a test failure, which is exactly the
  kind of reflow `src/jnb.html` has no automated check for.
- **`novalidate` is load-bearing on the settings form.** Without it, `min`/`max`/`step` on the
  two number boxes start blocking submissions that `config_diff` silently drops today
  (`room_config.js:98-103`), including via the mouse.
- **Focus now moves on every route.** The `activeElement` guard keeps it to real transitions,
  but it does move during the existing walks: after `Take the seats` focus sits on the lobby's
  first control, after `Back to the lobby` likewise. Nothing in the suite asserts
  `activeElement`, and the two places that care about focus already handle it explicitly —
  `:403` blurs a name box before pressing `w`, and `:391` presses `w` *into* a name box and
  asserts nothing happens. Both still hold: the names pane is focused, not its input.
- **`focus()` scrolls its target into view.** On the 390px viewport the first control of each
  screen is near the top of the pane, and `fits()` measures `scrollWidth`, not scroll position.
- **`queueMicrotask` is not polyfilled** by `babel-preset-env` (it is an API, not syntax).
  Chromium, Firefox and Safari have had it since 2018; the client is ES5-compiled but runs in a
  browser with it.
- **`.notice` adds one blank line to the lobby**, above the error line that is already always
  blank. That is the price of a region that exists before it speaks, and it is the same price
  `.err` has been paying since #88.
- **`npm test` builds first and runs four suites.** Only `browser.test.mjs` gains work, but it
  is the one that renders the markup — run the whole thing, not the fast files.

### Headline

Two production files. `src/jnb.html`: three CSS lines, six `<form>` wrappers, 17 role
attributes, one `tabindex`, one `type="button"`, one `novalidate`, one binding deleted, six
`click:` bindings moved to `submit:`. `src/interaction/viewmodels.js`: a 9-line function and
one call. `test/browser.test.mjs`: three helpers, one init script, one ~130-line walk.
