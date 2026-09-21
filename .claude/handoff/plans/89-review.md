# Plan review verdict — #89

**VERDICT: APPROVE WITH CHANGES.** The trace is unusually accurate; every load-bearing claim was
re-derived. But **T2 as written cannot pass**, and one caller of `ask_to_resume` is missing in a way
that changes the fix's behaviour.

## MUST FIX

1. **T2 phase 3 can never reach `#play`.** The `relay.onMessage` handler corrupts *every* `start`
   carrying a snapshot with no gate — `broken` is a counter, not a switch. Phase 3 sets
   `deaf = false` but the snapshot is still replaced with `"not a snapshot"`, so `build` returns
   early again and `await on("play", guest)` times out.
   **Add a flag**: `let break_start = true;` in the condition; set `break_start = false` before
   phase 3. (Phase 2 is unaffected only because `deaf` stops the resync ever going out.)

2. **AC5's "no reachable browser test" is WRONG, and the stated reason is the opposite of the code.**
   `get_level`'s catch at `viewmodels.js:255-262` does `delete levels[name]` — a *failed* fetch is
   deliberately never cached ("Not remembered as a failure: it is worth another try next match").
   Only **successes** are. And the lobby's `preload()` (`viewmodels.js:277-285`) already fetches the
   level once on room updates.
   So `page.route("**/levels/caves/caves.dat", r => r.abort())` on T2's guest, with the host's match
   on `caves` (the suite already does `level_select().selectOption("caves")` at
   `test/browser.test.mjs:646`), makes the rejoin's `get_level` reject on every attempt — and
   un-routing recovers, because the cache entry was deleted.
   **Either bolt that onto T2's existing guest (~3 lines, same page) or keep it untested — but
   correct the reason.** The honest one: only AC6 demands a test, and AC5 shares `on_start_failed`
   with T2. As written the plan would put a **false claim** on the issue.

3. **`ask_to_resume` has a third caller the trace never mentions: `apply_room` calls it at
   `viewmodels.js:745`** — i.e. on *every* room update (seat taken, ready toggled, countdown, host
   migration). Today the latch is also acting as a one-shot, so a client that cannot be let into the
   match asks once. **After the fix it re-asks** — re-arming a 5 s timer and re-showing the error —
   **on every subsequent room broadcast.**
   Decide and state it: either accept the cadence (bounded by real room events, not by ticks) and put
   it in Risks, or latch failure separately so only `rejoin_match` re-opens it. It also means T2
   phase 2's `assert.equal(await said(), "", ...)` may be asserting against a timer armed by an
   auto-ask rather than by the click — still passes, but the comment is wrong about why.

4. **Two line citations are wrong** (the plan promises all numbers are against `af04c21`):
   - the `var socket = new WebSocket_Transport(...)` statement closes at **847**, not 770;
     `pending = socket;` goes on **848**, before `connect`'s closing brace. (770 is
     `reconnected = self.disconnected();`, deep inside the `joined` branch — wrong place.)
   - `} else if (transport !== socket) return;` is **784**, not 782.

## SHOULD FIX

5. **Guard the `joined` clear the same way the error callback is guarded.**
   `WebSocket_Transport.close()` nulls only `onclose` (`websocket_transport.js:65-68`); `onmessage`
   stays live while the socket is CLOSING, so a superseded socket's in-flight `joined` can still fire
   and would run the unguarded `pending = null; self.connecting(false);`, dropping the **successor's**
   in-flight state. Make it `if (pending === socket) { ... }` in **both** places.
6. **`go_landing` (`viewmodels.js:940-943`) does not call `leave_room`.** Create -> Back -> Create
   leaves `pending` set and `connecting` true, so all three buttons stay disabled for a round trip
   (and the pending `joined` still yanks the player into the room — pre-existing). Either clear it in
   `go_landing` or add it to the `ponytail:` ceiling; the current comment only covers a socket that
   never answers.
7. **AC2 gets no test.** With the enable binding on `:152`, T1's second click never reaches
   `create_room`, so `pending.close()` is exercised by nothing. Fine — AC6 only asks for the
   double-click — **but say it**, the same way AC5 is flagged.
8. **#88 lands first and shifts every `jnb.html` number here.** It inserts an error line into the
   landing screen before `jnb.html:145` (moving 152/173/191 down) and edits `viewmodels.js:810`,
   `:827-830` (inside `connect`'s error callback, where #89 inserts at the top) and `:662-668`
   (immediately above #89's `:672`). No semantic overlap, and the "no new markup" claim holds —
   `jnb.html:260` is real and is the only `p.err` inside the room div — but **edit by content, not by
   line number.**
9. **`RESUME_MS`'s `ponytail:` marker says "upgrade path: none".** That is a constant with a
   rationale, not deferred debt — drop the marker, keep the comment, or `/ponytail-debt` harvests a
   non-debt entry. (The `connect()` marker earns its keep.)
10. **State the three-vs-four discrepancy plainly on the issue.** The plan is right and the issue is
    wrong, but it buries the fourth in a parenthetical while its prose still says "three paths".

## VERIFIED CORRECT (do not re-derive)

- **`connect()` at `viewmodels.js:748` is the SOLE socket opener**: the only `new
  WebSocket_Transport` in `src/` is `:756`; `:94` and `:441` are `Loopback_Transport`. All five
  callers confirmed at 861, 900, 1011, 1021, 1077.
- **The orphan mechanism is exact.** `websocket_transport.js:23-27` pongs with no active-transport
  check; `connect` captures `var leaving = transport` (`:755`) and `joined` calls `leaving.close()`
  (`:764`) — the loopback on both clicks — while `transport = socket` is `:765`. The
  `transport !== socket` guard (`:784`) is a read-only early return. **Socket A is referenced by
  nothing and never closed.**
- **Relay half**: blank-code create -> `generate_room_id(rooms)` (`server/index.js:108`),
  `listed: !!msg.listed` (`:172`), `listings()` filters `room.listed` (`:1190`), `/api/rooms` serves
  it (`:1209`), `best_room` (`:247-262`), `quick_join` fallback (`:277`), `leave` deletes with the
  last client (`:568-575`). **"No relay change" holds.**
- **Quick Join caveat confirmed**: `jnb.html:138` is `click: go_quick`, and `go_quick`
  (`viewmodels.js:959-964`) opens no socket. The socket is `connect({type:"quick"})` from
  `take_seats` (`:1077`), bound to **Take the seats** (`jnb.html:191`). **The plan binds the right
  button; the issue's wording is loose.**
- **Both B leaks**: `game_session.js:253` returns above the only `on_match_start` call (`:293`);
  `decode_snapshot` returns `null` rather than throwing. `game_session.js:189-191` uses `noop`,
  defined at `:22` and used nowhere else — safe to delete. `this.on_match_start = null` at `:127`
  beside `on_match_end` (`:131`) / `on_limit` (`:134`), so `on_start_failed` matches an existing idiom.
- **The flag**: set once at `:651`; cleared at **475, 604, 672, 889** — four, not three.
  `lost_connection` (`:889`) genuinely needs `stop_resuming()`.
- **Ponytail**: one guard in `connect()` is the root-cause fix — three at the buttons would leave
  `enter()` able to orphan. Nothing in the file already tracks in-flight connect state.
  `on_start_failed` is **not optional**: `resuming` lives in the `viewmodels.js` closure and
  `Game_Session` holds no ViewModel reference.
- **`dblclick` is safe**: Playwright 1.63 runs actionability once then dispatches `clickCount: 2` in
  one mouse sequence — it cannot fail on the disabled state under test. `button()` is `:visible` +
  exact-label + `.first()`, so `button("Create")` will not collide with "Create a room". `until()`
  polls 200x50 ms = 10 s against `RESUME_MS = 5000`. Walks run sequentially, and the before/after set
  difference is immune to rooms earlier walks leave up.
  **One caveat**: `origin` may be an external relay via `JNB_BASE_URL` (`:42-44`), which undercuts
  the "relay is in-process" justification for the 150 ms `settle()`.
- **Scope**: `jnb.html:260` is the lobby's existing `<p class="err" data-bind="text: error">`, and
  `board-template` contains no `p.err`. `can_rejoin` (`:338-340`) is visible for T2's guest after both
  failures. `router.test.mjs` has no copy coverage today (#88 adds it), so #89 owes it nothing.
