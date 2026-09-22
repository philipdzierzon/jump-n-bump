# Plan review verdict — #90

**VERDICT: APPROVE WITH CHANGES.** Shape is right — platform `<form>`, one `focus_screen`, attributes, zero new modules. Six defects below; one test step throws unconditionally, one mutation cannot fail, and AC3's "every" is nine-tenths cosmetic by the plan's own rule.

> **Anchors, before you start.** The plan and this review were both written against
> `90-keyboard-screen-reader` at HEAD `f7c84fa`. The implementer works on a **rebased** version of
> that stack — same content, different SHAs. Every `file:line` below was true at `f7c84fa` and is
> quoted so you can find it, but **re-find each anchor by grep, never by line number.** Earlier
> issues in this chain shipped citations that had drifted.

> **Probes.** Everything quoted below was produced by three throwaway Playwright scripts in
> `/tmp/probe90`: `probe.mjs` (CSS-selector throw, `event.detail` per activation, closed-`<details>`
> `offsetParent`, empty-region `isVisible`/`getByRole`, `display:contents` gap parity, blur timing),
> `probe2.mjs` (blur after a frame, `checkVisibility` vs `offsetParent`, `focus()` into a closed
> `<details>`), `probe3.mjs` (number-input constraint validation, `novalidate`, disabled default
> button). They import Chromium from the worktree's own `node_modules/playwright`; `node probe.mjs`
> re-runs one.

All probes ran against the worktree's own Playwright/Chromium. Raw results quoted.

---

## MUST FIX

1. **Step 14's `LIVE` sweep throws. Every run, fixed tree included.** Entry 3 is
   `'visible: match_running"'` (trailing `"`), interpolated into `'[data-bind*="' + bind + '"]'`.
   The `"` is markup, not part of the attribute value. Probe:
   ```
   1. selector-with-quote: THROWS SyntaxError: Failed to execute 'querySelector' on 'Document':
      '[data-bind*="visible: match_running""]'
   1b. selector-no-quote: mr1      1c. selector-amp: mr2
   ```
   The disambiguation it was for is unnecessary: `visible: match_running` already returns `jnb.html:191`
   (first in document order) and `visible: match_running() &&` already returns only `:221`.
   **Drop the trailing `"`.**

2. **`:128` and `:264` are the *same* `text: X, visible: X` shape §1.3 calls "the one shape a live
   region is never heard in", and get an attribute only.**
   - `jnb.html:128` `visible: connection_text, text: connection_text` — byte-for-byte `:260`'s shape.
   - `jnb.html:264` `text: result_text, visible: result_text`, *inside* `:262` `div visible: board`.

   `:128` is fixable at the same cost as `:260` — delete `visible: connection_text`. Probe:
   ```
   4. recon empty isVisible: false      4b. recon filled isVisible: true
   ```
   (`.reconnecting` is `position:absolute; left:0; right:0` with no `min-height`, so empty ⇒ zero-height
   ⇒ Playwright not-visible.) So `browser.test.mjs:957` and `:1005` (`!isVisible()`) and `:990`
   (`isVisible()`) all keep their verdicts, and `:1916`/`:1928` read `textContent`. **One deletion, no
   test churn, one more region that actually announces.**

   `:264` is *not* cheaply fixable — its wrapper toggles too. Count the reveal-shape status nodes
   honestly: after the fix exactly **one** of the ten (`:260`) is in the announceable shape, plus `:228`
   on a host migration. `:160`, `:191`, `:200`, `:207`, `:221`, `:222`, `:264` are all reveal-shape.
   **§1.3 must stop implying `:260` is unique, and §4 must list these beside the six error reveals.**
   Shipping the roles is still right; selling AC3 as met for nine of them is the "role attribute present
   but never reaches an AT" failure.

3. **AC4's `novalidate` mutation cannot fail — a blank number box is valid and submits.** Probe on
   `<input type="number" min="0" max="99" step="1">` inside a validating form:
   ```
   blank : {"subs":1,"valid":true,"v":{"ro":false,"vm":false,"bi":false}}
   3     : {"subs":1,"valid":true,...}
   999   : {"subs":0,"valid":false,"v":{"ro":true,...}}     ← blocked
   999 nv: {"subs":1,"valid":false,...}                      ← novalidate restores it
   ```
   No `required`, so blank ⇒ `valueMissing:false` ⇒ submits. Only **out of range** blocks. As written,
   `novalidate` ships with no assertion behind it, and the existing suite never submits an out-of-range
   number either (`browser.test.mjs:548,549,563,564,1046` are all in range).
   **Fix: step 9 types `"999"` into "Bumps to win" (max 99) and still asserts the staged banner arrives.**
   Then removing `novalidate` really times out `"the staged change"`. Rewrite the table row.

4. **AC2's guard gap is not real — two lines close it.** `viewmodels.js:1060` is
   `window.addEventListener("hashchange", apply_route)`, so a synthetic event reruns `apply_route`
   on the screen already showing. After step 10's Enter, focus is still in the lobby password box:
   ```js
   await kb.evaluate(() => window.dispatchEvent(new HashChangeEvent("hashchange")));
   assert.equal(await focused(kb), "INPUT:password",
       "a route onto the screen already showing does not steal the box");
   ```
   Delete the `activeElement` early return ⇒ focus jumps to `BUTTON.sm:Copy join link` ⇒ red.
   **Replace the "no cheap browser test" row with this.**

5. **§4.2's "it cannot be measured from here" is false.** The defect is directly observable — the text
   arrives while the pane is unrendered:
   ```js
   await kb.evaluate(() => { window.__when = [];
     const p = document.querySelector("div[data-bind*=\"'landing'\"] p.err");
     new MutationObserver(() => window.__when.push(!!p.offsetParent))
       .observe(p, { childList: true, characterData: true, subtree: true }); });
   ```
   Probe F confirms `offsetParent` is `false` for a node inside a `display:none` pane. Trigger a drop
   ⇒ `__when` is `[false]` today, `[true]` after a `valueHasMutated()` once the pane is up.
   **Either ship the one-liner with that assertion, or record the gap as *measured and deferred*.
   Do not write "unmeasurable" — #89 and #92 were rejected for exactly this sentence.**

6. **`offsetParent` is NOT null inside a closed `<details>`; the stated justification is false and
   `focus()` there is a silent no-op.** Probe:
   ```
   D. closed details #hid: offsetParent=true offsetHeight=21 checkVisibility=false rect.h=21
   E. focus() on closed-details button -> activeElement: BODY
   F. hidden-pane input: offsetParent=false checkVisibility=false
   ```
   Chromium uses `content-visibility: hidden` for closed-`<details>` content: it keeps an offset parent
   and a box, is untabbable, and swallows `focus()`. Reachable today: offline lobby entered while
   `loading_level()` is true ⇒ `:226` "Start the match" is `disabled` ⇒ loop reaches `:233` `<select>`
   inside the closed `<details>` ⇒ `focus()` no-ops ⇒ `return` ⇒ focus stays on `<body>`.
   **Fix: `checkVisibility()` in place of `offsetParent`, both in the guard and in the loop** — same
   line count, false for the hidden pane *and* the closed panel, comment becomes true.

---

## SHOULD FIX

7. **`focus_in` is a helper with one caller, beside an assertion that subsumes it.** Step 5 already does
   `assert.equal(await focused(kb), "DIV.kiosk")`. Its stated reason for existing (browse, where the
   first control is nondeterministic) is a screen the walk never visits. **Delete it, or spend it on
   browse** — which would also close §4.3's unwalked-path hole for two lines.

8. **Step 3's ordering as written fails.** Prose says `type("ABC")`, `press("Enter")`, then the code
   block asserts `said("create", kb)` deep-equals `[""]`. Knockout's `text` binding writes
   synchronously, so `CODE_HINT` is already in the node. **State explicitly that the empty-region
   assertion runs *before* the Enter**, the way step 10 does.

9. `!targets[i].disabled` misses fieldset-inherited disabling — `el.disabled` reflects the content
   attribute only, so every control inside `fieldset[disabled]` reads `false`. `!targets[i].matches(":disabled")`
   is the same length and correct. Unreachable today (`:205`/`:226` always precede), free anyway.

10. `:160` "Connecting…" is `visible: pending_id` over **static** text — deleting `visible:` would show
    it permanently, so it stays reveal-shape. Name it in §4; don't count it as announced.

11. §5's `role="status"` sentence should say plainly which nodes the roles are *insurance* for versus
    which are *proved*. `unroled === 0` and the `roles` deepEqual are markup-presence assertions; they
    prove exhaustiveness, not audibility. The plan is close to saying this and should say it.

---

## VERIFIED CORRECT (do not re-derive)

**Every line number in §1 lands.** All of `jnb.html:113–289` checked against the plan's four tables:
the 7 text entries, 7 `p.err`, 10 status lines and the "not messages" list are **complete and correctly
classified**. `grep -c "<form"` is 0; `.err { min-height: 1em }` is `jnb.html:26`; the only ARIA is
`:89`, `:184`, `:186`. `takeable: !!self.room_id() && !self.seat_names()[seat]` **is** at
`viewmodels.js:382`. `is_typing` **is** `game_session.js:511-517`; `document.onkeydown` **is** `:489`
and never `preventDefault`s; the couch `keydown` **is** `:1263-1269`. `self.screen(...)` is written in
exactly one place, `:1031`; `apply_route()` at `:1348`, `ko.applyBindings` at `:1351`. `.prettierignore`
lists `src/jnb.html`.

**Knockout's `submit` really cancels, in the file the bundle uses.** `knockout@3.5.3`, `main` →
`knockout-latest.js`; minified body is `try{d=e.call(f.$data,b)}finally{!0!==d&&(a.preventDefault?…` —
identical to debug `:5184`. **None of the six handlers can return `true`:** `create_room:1136` /
`join_room:1141` return `self.error(CODE_HINT)` (Knockout returns the receiver, i.e. the ViewModel);
`join_room:1144` / `take_seats:1180,1196` return `go(...)`, which bottoms out in `undefined` through
`apply_route`/`enter`/`connect`; `submit_password:1146`, `apply_config:1295`, `set_password:1318` have
no returns. No form navigates.

**`form { display: contents }` is layout-neutral.** Probe: `5. gap parity {b1_to_err:14}` (the `.kiosk`
`gap: 14px` is preserved across the form boundary), `5b. form box {w:0,h:0}`. `fits()`
(`browser.test.mjs:1826-1854`) only tests `documentElement.scrollWidth <= clientWidth`, so the phone
assertion holds either way. No CSS rule uses a child combinator through the new wrapper
(`fieldset`, `fieldset[disabled]`, `label input[type=checkbox]` are all unqualified), and
`locator("fieldset").first()` / `.nth(1)` keep their targets.

**AC5's `detail` guard discriminates, for every control the walk touches.** Probe:
```
2.  keyboard clicks: ["b1:0:click","SUBMIT","cb:0:click","sum:0:click","b1:0:click","SUBMIT"]
2b. mouse clicks:    ["b1:1:click","SUBMIT","cb:1:click","sum:1:click"]
```
Enter on a submit button, Space on a checkbox, Enter on a `<summary>`, and **implicit submission's
synthesized click on the default button** are all `detail === 0` and all bubble to the capture
listener on `window`. Real mouse clicks are `1`. Keyboard interaction with `<select>` fires no click.

**The focus transition works, and `queueMicrotask` is the right beat.** Probe:
```
A. microtask: b1      B. after rAF: BODY      C. now: BODY
6. {"active":"b1","offsetParent":false,"after_read_active":"b1"}
```
At microtask time `document.activeElement` is *still* the just-hidden control, but reading
`offsetParent` forces layout and returns null — so the guard falls through exactly as intended on a
real transition and returns early on a same-screen route. Blur to `<body>` lands by the next frame, so
step 12's `assert.equal(await focused(kb), "BODY")` holds by the time it is read.

**Empty live regions resolve as the plan needs.** Probe: `4c. empty p.err isVisible: true`,
`4e. err rect {w:430,h:13}`, `4d. getByRole alert innerTexts: [""]`. Playwright's role engine defaults
to `includeHidden:false`, so a `visible:`-toggled or role-less paragraph matches nothing — step 3's
`[""]` and step 10's `min-height` mutation are both non-vacuous.

**Disabled default button blocks Enter.** Probe: `disabled default button, subs = 0`. So
`enable: !connecting()` on `:153`/`:174` keeps #89's guarantee on the keyboard path too, and
`disabled(button("Create", solo))` / `dblclick()` (`:1643`, `:1664`) are unaffected.

**Focus routing, per screen, re-derived from the markup** — all nine rows of AC2's table are right,
including that without `tabindex="-1"` the names screen lands on **`:194` Start over** (`:184`/`:186`
absent with an empty couch, `:192` disabled by `participants().length > 0`). Nothing lands on a
destructive control. Browse with zero rooms lands on `:284` "Create a room". Play lands nowhere
(`.top-bar` and `.canvas-container` are not `.kiosk`; `:129`'s `.overlay.kiosk` holds no control).

**No existing keyboard assertion breaks.** All 28 `keyboard.*` calls in `browser.test.mjs` are on the
**names** screen (target becomes the focused pane `<div>`, so `is_typing` is false and the couch still
fills) or on **play** (focus is `<body>`). `:391-397` presses `w` *into* an input and `:403` blurs
first — both still hold. `div.banner` is only `:207`, so `:444`/`:461`/`:665` are unaffected by the
role attribute, and `notice()` (`:326`) reads `textContent`, so deleting `visible: notice` leaves
`:699`/`:701`/`:726` green.

**Step 11 does not trip a countdown.** `all_ready` (`server/index.js:306-309`) skips clients with no
seats, so the step-8 keeper never blocks; `start` with everyone ready calls `begin` immediately
(`:1077`), so `:226` is never `disabled` by `!countdown()` and `tab_to("Start the match")` reaches it.
The step-9 staged change is also what makes the Ready button read `"Ready"` rather than `"Not ready"`
at step 11 — say so in the plan, it is load-bearing ordering.

**Step 13's route is right.** `screen_of("#ABCDE")` returns `{screen:"join", room_id}` (`router.js:15`),
so `apply_route` does *not* take the `room`/`play` no-participants branch and reaches
`enter(route.room_id)`. With `browsed === false` and `screen() === "join"`, the refusal falls to the
final `else` at `:954` → `go("password", true)`. `FLOW_TEXT.unavailable` contains "not available";
`CODE_HINT` is `"A code is 5 letters, no I and no O."` — both `includes()` checks match.

**AC4's `type="button"` mutation is genuinely fatal.** `:186` `×` has no `type`, precedes `:192` in
tree order, and is visible while `!seated()`, so it is the form's default button — Enter drops the
seat (and its handler removing the `<li>` also kills the submission), and `on("room")` times out.

---

## Unbuildable / unmeasurable as claimed — where to record it

- **§4.1 stands.** No AT in CI; the role-engine + laid-out-before-the-message pair is the strongest
  available claim. PR body, as planned.
- **§4.2 must be rewritten** (MUST FIX 5): the reveal-case defect *is* measurable via `offsetParent` at
  mutation time. Whether a screen reader *speaks* the revealed region is not.
- **The nine reveal-shape status nodes** (MUST FIX 2) belong in §4 as a named limit, not inside AC3's
  "every".
- **`novalidate`** (MUST FIX 3) is untested as the plan stands; either the walk exercises an
  out-of-range value or §4 records it as attribute-without-assertion.
- **`:264`'s double toggle** (`:262` `visible: board` + `:264` `visible: result_text`) — record in §4,
  with the one-issue-of-its-own note the plan already gives the weak `aria-label`s.

Worktree left clean (`git status --porcelain` empty; probes live in `/tmp/probe90`).
