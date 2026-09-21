# Plan review verdict — #88

**VERDICT: APPROVE WITH CHANGES.**

## MUST FIX

1. **The "collateral finding" is FALSE — drop it.** All six existing `p.err` bind `text: error`
   (`src/jnb.html:153,162,174,192,260,282`), and the new landing paragraph binds the same observable.
   `document.querySelector("p.err")` at `test/browser.test.mjs:1703` today returns the **create**
   screen's node (`:153`, first in document order), not "the current screen's" — it has never been
   screen-scoped, and works only because every `.err` shows the same observable. After item A the
   first node is landing's, bound to the same `error`, so the diagnostic prints **identical text
   before and after**. Delete the Risk bullet and the `querySelectorAll(...).join(" | ")` repair, or
   keep the one-liner purely as a nicety (it would also surface `rooms_error`) — **but the stated
   rationale must not go into the PR; it is wrong.**
2. **Two `FLOW_TEXT` lines break `npm run format:check`.** `.prettierrc` sets `printWidth: 100`;
   `room_gone:` is 104 columns and `ready_cleared:` is 101. Prettier cannot split a string literal,
   so it rewrites both to the wrapped form the plan already uses for `vacated`:
   ```js
       room_gone:
           "That room would not let you back in. It may have ended, or it may have a password now.",
   ```
   **Wrap both in the plan so the diff is what Prettier produces.**
3. **`ready_cleared` instructs an action a queued/unseated client cannot take.** `apply_room` runs
   for every client, so a client with no seats gets "...Press Ready for the next one." while the
   Ready button is hidden (`jnb.html:223`, `visible: room_id() && seated()`). Gate it on the seats it
   is about:
   ```js
   if (self.match_running() && !msg.started && msg.held.length) self.notice(FLOW_TEXT.ready_cleared);
   ```

## SHOULD FIX

4. **`FLOW_TEXT.dropped` is churn.** Unchanged string, one surviving use site after item A
   (`viewmodels.js:810`), test asserts only its literal value. Leave it where it is.
5. `self.host_seat(msg.host_seat == null ? null : msg.host_seat)` is a no-op ternary. Use
   `self.host_seat(msg.host_seat)` — `waiting_text` already tests `seat == null`.
6. **Item B's `ponytail:` comment is four lines over a one-line change**, and the three lines above
   already say "un-ready at countdown zero". Fold the ceiling into one clause. (The `host_seat` one
   on the relay IS warranted as written.)
7. **Apostrophe mismatch in the same paragraph slot**: the staged banner (`jnb.html:208`) renders
   `Everyone&rsquo;s`; the new notice lands at `jnb.html:259` with a straight `'`. JS-side strings do
   use straight apostrophes (`viewmodels.js:819`), so it is defensible — decide it deliberately.
8. **Stale instruction**: nothing clears `notice` when the player presses Ready, so "Press Ready for
   the next one." stands until the next match begins. Either accept explicitly or add
   `self.notice("")` to `toggle_ready` (`:1153`).
9. Plan prose says the relay assertion goes in "the host-migration section", then uses `vacated` from
   `relay.test.mjs:467`, which is the **countdown-zero** block. Fix the sentence; the assertion is
   correct (`gate` is "Host" on seat 0).
10. `server/index.js:1209` is `res.set("Cache-Control", ...).json(listings())`, not
    `res.json(listings())`. Conclusion about `res.ok` unaffected.

## VERIFIED CORRECT (do not re-derive)

- **`router.js` is the only importable pure flow module.** 17 lines, imports only `net/room_id.js`,
  already imported by `viewmodels.js:5` and `router.test.mjs:7`. `viewmodels.js:1218` is
  `ko.applyBindings(new ViewModel())` at module scope and `relay_url()` reads `window.location` —
  node cannot import it. **The strings belong in `router.js`.**
- **The three landing paths**: `:806-811` sets "The connection dropped." into a screen with no
  `p.err`; `:827-830` sets nothing; `:870-874` sets the same dropped string where the *seats* are
  what was lost. `apply_route:910` calls `leave_room()`, and `leave_room` (`:425-478`) never touches
  `self.error` — messages survive the route.
- **Path 2 is reload-only and `room_gone` is accurate.** The only codes reaching that branch for a
  non-`create` entry are `ROOM_UNAVAILABLE` (`server/index.js:190-191`); `BAD_ID` is create-only, and
  reconnect refusals are swallowed by `:800`'s `return retry()`.
- **Item D's refutation is RIGHT, so the ISSUE's suggestion is wrong.** `display_names()`
  (`:348-352`) feeds **both** `scores_viewmodel` (`:385`, column heads) **and** `result_text` ->
  `match_result` (`:391`). A `(host)` suffix would print "Dott (host) wins with 3 bumps." —
  `router.test.mjs:93-96` asserts exactly that shape. `seat_labels()` (`server/index.js:309-319`) is
  a mutually-exclusive ternary chain; a host seat is orthogonal to `(left)`/`(out of sync)`/`(AI)`.
  **The issue's "they are used only by the scoreboard" is misleading — say so in the PR body.**
- **`host_seat(room)` earns its place on the relay.** `room_view` (`:371-393`) sends `seats`, `held`
  and `host` (own boolean); nothing identifies another client's seats. **The host seat is not
  derivable client-side.** `host_seat(room) !== null` is equivalent to `ensure_host`'s current loop.
- **Item E's strict-locator hazard is real.** `message()` at `browser.test.mjs:1392` is
  `screen("browse").locator(".err").innerText()` — a second `.err` on browse throws strict-mode.
  Funnelling through `rooms_error() || error()` avoids it; `:1418`'s `/not available/` still passes.
- **Item B's trace**: `countdown_zero` (`:1012-1021`) -> `vacate` -> `broadcast_state` -> `apply_room`
  with `held: []`, reaching `viewmodels.js:700-708` silently. `to_lobby` (`:361-367`) ->
  `reset_ready` (`:339-342`) on every match end. `match_running()` still holds the previous answer at
  `:668`, so the transition detection works. `take_seats` clears `error` at `:1072`.
- **`notice` collision is safe** — only asserted at `browser.test.mjs:679/681/706`, all before the
  first `match_end` at `:714`.
- **AC5 and the declined badge**: `lobby_rows` (`:251-261`) deep-equals exact joined strings at
  `:405/:576/:602/:626`, and `room_view` (`:266-276`) slices `querySelectorAll("small").slice(0,2)`.
  A `<small>host</small>` breaks four assertions and silently corrupts the two-page walk.
  **Declining is right**; `waiting_for` satisfies AC5 without touching either helper.
- **#8 HOLDS — plainly.** Item C sets the message client-side, in the same handler, on the same
  single `ROOM_UNAVAILABLE` the relay already sends. A nonexistent code and a real-but-locked code
  produce **byte-identical screens, identical round trips and identical timing**; both previously
  produced identical *silence*. The only signal gained is "did I get in or not", inherent to joining.
  `server/index.js:190-191` untouched. **No leak.**
- **#90's seam**: text-binding is the right mechanism — KO's `visible` sets `display:none` (drops the
  node from the a11y tree) and `if` removes it entirely, while a `text:`-only `p.err` with
  `min-height: 1em` (`jnb.html:26`) is always present and in the tree. After this issue all seven
  `p.err` have that shape.
  **BUT** the plan's second channel, the lobby notice at `jnb.html:259`, is
  `text: notice, visible: notice` — exactly the shape the plan argues against, and item B's
  `ready_cleared` lands there. **Either drop `visible: notice` now** (one attribute; `.muted` has no
  `min-height`, so an empty `p` collapses to its margins) **or state in §4 that #90 must** — do not
  claim the seam is uniformly text-bound.
