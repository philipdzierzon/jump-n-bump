# Plan review verdict — #87

**VERDICT: APPROVE WITH CHANGES.** The three production fixes are correct and minimal. Two
justifications are wrong, and one test assertion cannot pass as written.

## MUST FIX

1. **`walked[0].startsWith("#play")` can NEVER pass.** The `__routes` recorder
   (`test/browser.test.mjs:137-153`) evaluates `location.hash` *inside* `setTimeout(..., 0)`, not at
   hashchange time. Listener order is recorder-then-`apply_route`, so by the time the deferred push
   runs, `apply_route` has already executed `location.replace("#room")` synchronously — **both
   recorded entries read `#room`.**
   Fix: in the init script the plan already moves, add a second, **synchronous** recorder and assert
   on that:
   `window.__hashes = []; addEventListener("hashchange", () => window.__hashes.push(location.hash))`
   Leave `__routes` alone for the failure dump.
2. **The same defect makes the `before`/`n` count gates unsound.**
   `const before = (await routes(hpage)).length` is sampled while the *previous* navigation's
   deferred push may still be queued, so `>= before + 2` can be satisfied by one bounce hashchange
   plus one stale entry. The synchronous `__hashes` array from (1) removes the hole — both entries
   land inside the same task as the navigation.
3. **Moving the routes init script into `make_context` must DELETE the page-level one.** `page` comes
   from `make_context("flow")`, so if `page.addInitScript(...)` at `:127-154` stays, every hashchange
   is recorded **twice** on the main page. The plan says "move" — say **"move and delete 127-154"**.
4. **"`#play -> #landing` stranded the match too" is FALSE.** `server/index.js:603-607`: when the last
   host's socket goes and `room.started`, the relay already runs `to_lobby(... reason:"host_left" ...)`.
   That path is **not** stranded — it ends with a different reason and the last-snapshot board
   (`scores_viewmodel.js:64` renders "The host left."; `relay.test.mjs:753` pins it).
   The real effect is a **user-visible copy change**: other clients now see "The host ended the
   match." with the host's real board instead of "The host left." with `last_board`. An improvement —
   but that is reason-copy, i.e. **#88's territory**. Name it in the plan and the commit; do not sell
   it as "fixes a stranded match for free".

## SHOULD FIX

5. **Hole D's middle term is right, its stated reason is wrong.** A `join` route never reaches line
   920 (that branch is `room`/`play` only), and `jnb:room` is rewritten on every handshake at
   `viewmodels.js:779`, so a cold load on `/#CODE` does not lose the breadcrumb in any way that
   matters. **Keep `self.room_id()`** — without it a cold load runs a pointless full `leave_room()`
   reset (new transport, every observable cleared, breadcrumb nulled) in the window before the
   handshake — but state **that** reason.
6. **The "Back after the bounce" assertion is weakly deterministic.** Because the bounce *replaced*,
   both entries are `#room` and the back fires no hashchange — fine. But in the regression case (a
   push), Back lands on `#play`, `apply_route` bounces again, and `hash` sampled a round trip later
   reads `#room` — **the assertion passes anyway.** Gate it: capture `__hashes.length` before
   `goBack()` and assert it is unchanged when the hash is read.
   Also: the plan's blanket "no `settle()`" is **stricter than the repo's own convention** —
   `settle()` exists at `:197` precisely for negatives and is used that way at `:963`.
7. **Id count is short.** The sample uses `room_m` but the plan allocates only `room_j/k/l`. **Four ids.**
8. **"Six places click 'Back to the lobby'"** — it is **13** (the plan then lists 13).
9. **`end_match` is not quite the only chokepoint.** `go_quick` and `play_offline` call `leave_room()`
   *before* routing, so a host mid-match still announces nothing there; the relay's `host_left` net
   covers them. One sentence, so "root cause, fixed once" isn't over-read.
10. **Ponytail: drop the one proposed comment.** Hole B's guard is a plain fix with no ceiling and no
    upgrade path worth naming — decoration. **Zero is the right number here.**
    The `browser.test.mjs:46-83` deletion (40 lines of stacked literals -> a 6-line `new_room_id`)
    **IS in scope**: the walk needs four more ids, and `generate_room_id(taken)` takes exactly that
    mutable map (`src/net/room_id.js:18-24`). Net deletion; take it.

## VERIFIED CORRECT (do not re-derive)

- `end_match` is `viewmodels.js:520`, sole caller `apply_route:909`; `go_lobby:992-999` contains
  nothing but the announce and `go("room")`, so it **does** collapse to one line with nothing lost.
- **The ordering argument HOLDS.** `Loopback_Transport.to_client` is a bare synchronous
  `listener(msg)` (`loopback_transport.js:16-18`), so an offline `announce_end` fills `ended_because`
  before control returns. Announcing *below* `var reason = ended_because` reads `null`,
  `current_game` is nulled before the echo's `to_lobby_soon` round trip, and the `:504` "The host
  ended the match." assertion loses its line. **Top of the function is required.**
- `self.screen()` is still `"play"` at line 909 (set at 911), so `to_lobby_soon`'s 2-second hold
  behaves exactly as today. No ordering change for any of the 13 existing clicks.
- **The double announce is REAL.** `Game_Session.in_match` is written in exactly three places
  (`game_session.js:130` init, `:162` read, `:168` set true) and **never cleared**; `room.js`'s own
  `in_match:150` is a different private variable. `browser.test.mjs:1043` is the live scenario: the
  offline match self-ends with `"time"`, then Back runs `end_match` with `in_match` still true and
  `played` true -> a second `announce_end("lobby")`, which the relay re-broadcasts unconditionally
  (no `started` guard at `server/index.js:361-368`) and which double-counts `report_match`.
  **The `game_session.js:139` edit is required, not scope creep.**
- **`match_running` is wrong in BOTH directions.** Only `apply_room:668` sets it, and `apply_room`
  runs on relay messages alone — the loopback never sends `room`, so it is permanently `false`
  offline (and `leave_room` doesn't reset it). It is `true` for a lobby spectator, who must be bounced.
- **Hole C breaks no existing entry into `#play`.** The only `go("play")` in the tree is
  `on_match_start` (`viewmodels.js:619`), which runs after `room.on_start` sets `in_match = true`
  (`game_session.js:168`) — including the reconnect `return void session()` path and both
  "Rejoin the match"/"Take seat" flows.
- **`start_when_ready` is genuinely still reachable** — `session()` sets `current_game` at `:621` and
  `on_start` sets `in_match` before the `get_level` promise, so a route to `#play` during the `.dat`
  fetch passes the new guard and parks. **Do not delete it.**
- **Reload at `#play` is `#play -> #room -> #play`, exactly two hashchanges.** `apply_route` returns
  at `:921` via `enter(last)`; `reconnected` is false on a fresh document so the `joined` handler
  takes `go("room", true)`, then `session()` -> `ask_to_resume` -> `start` -> `on_match_start` ->
  `go("play")`.
- **The `driver:"ai"` ordering trick is valid** — and valid *because* the announce sits at the top:
  `release_seats()` runs after it in the same `end_match` call, same socket, same fan-out order.
- **`all_ready` -> immediate `begin`** once the node mate readies (`server/index.js:1057-1061`); no
  countdown to wait out.
- **The #42 restraint is correct, not evasion.** The `!match_end` negative in the reload walk is
  structurally safe: `leave()`'s `host_left` branch fires only when no host remains, and `boss`
  stays. Forward-after-Back cannot rejoin, because `ask_to_resume`'s
  `granted().join(",") === in_match_with` guard (`:649`) still holds.
- **Scope is clean.** Expect a textual conflict with #88 in the `end_match` / `go_lobby` region and in
  `jnb.html`'s top bar — **re-grep rather than trusting quoted line numbers after the rebase.**
