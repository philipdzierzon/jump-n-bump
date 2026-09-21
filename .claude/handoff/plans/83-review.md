# Plan review verdict — #83

**VERDICT: APPROVE WITH CHANGES.** The wall-clock bound is the right call and its primary
justification holds. Fix the following before/while implementing.

## MUST FIX

1. **The test's sprint-case numbers are wrong; the block as written fails.**
   `behind_transport(40)` with `d = 2` gives `gap() === 38` at tick 0 — `test/replay.test.mjs:265`
   already asserts exactly that.
   Change `assert.equal(sprinting.room.gap(), 40, ...)` -> **38**, and
   `assert.equal(sprinting.room.gap(), 39, ...)` -> **37**.
   (The plan corrects itself in prose — "take the numbers from the existing line 265" — but ships the
   wrong literals in the code block.)

2. **"Without the fix, this test hangs" is WRONG for `af04c21`, and the mis-description endangers the
   regression guard.** On `af04c21` `timeGetTime()` is `new Date().getTime()`, so the stubbed
   `globalThis.performance` is *not* the pump's clock: the first sub-case **passes** there
   (`stepped=1`, `drawn=1`, `yields.length=1`, `room.now()=1`) and the block fails only at the
   **sprint** assertion (`stepped` is 38, not 1). It hangs only in the intermediate state — Edit A
   applied, Edit B missing — which is what the `stepped > 100` throw exists for.
   Correct §4, and state explicitly that **the sprint sub-case is the assertion that fails on
   `af04c21`**, so nobody trims it as redundant.

3. **The workspace `CLAUDE.md` "Game loop" paragraph goes stale.**
   `/Users/philipdzierzon/Documents/sbx/jumpnbump/CLAUDE.md:76-80` reads "runs `game_iteration()` ...
   in a `while` loop until it is ahead of a 60 Hz `next_time` budget" — the repo's documented
   description of the exact thing being changed, and the repo's own `CLAUDE.md` points architecture
   notes there. Add one sentence naming `BATCH_MS` as the second exit. AC5 covers the in-code comment
   only; **add this file to the plan's scope.**

## SHOULD FIX

4. **§3 is misquoted.** Not "worst case 10 ms all-in for a 94-tick gap". The doc's 94-tick row is
   0+0+0+4 = **4 ms**; the worst row across all six repairs is **6 ms** (tick 723, gap 2). Say
   "4 ms for the 94-tick gap, 6 ms worst of six". (§1 and §7 ARE quoted faithfully.)
5. **AC6's "no edit to any existing line of that file" is false** — the plan edits
   `test/replay.test.mjs:90` (the `start()` signature) and `:100` (`no_renderer` -> `renderer`).
   Reword to "no existing assertion or call site changes".
6. **State the bound's real shape.** The guarantee is *blockage <= `BATCH_MS` + the cost of one
   tick*, **not** a latency cap: a 3-second tick (the §6 freeze scenario) still blocks 3 seconds. Put
   that in the AC1 argument and in the proposed AC1 amendment, so the fix is not read as something it
   isn't.
7. **Trim the `ponytail:` comment** to the repo's documented two-line `ponytail: <ceiling>, <upgrade
   path>` form (`CLAUDE.md:102-110`). Four lines of ceiling prose on a one-line constant is the thing
   ponytail is against.
8. **Drop the `break` -> `return` paragraph.** Pick one and move on.
9. **Note the new (small) real-clock dependency at `replay.test.mjs:266`:** 38 warmed headless ticks
   must cost < 16.67 ms of real `performance.now()`. They will, by ~2 orders of magnitude — but it is
   a real-clock dependency newly introduced into the determinism suite, and one line makes a future
   flake diagnosable.
10. **The browser-suite risk is mischaracterised and SMALLER than stated.** `sound()` and the
    `clock_page` match install Playwright's fake clock, which fakes `performance` too
    (`fakePerformance(clock, ...)`, `now: () => clock.performanceNow()`), and the fake clock does
    **not** advance inside a synchronous batch — so the bound cannot trip on those pages at all. The
    residual risk is only the non-clock pages under real CI load, where nothing asserts
    ticks-per-wakeup. Still run the suite; describe the risk correctly. (The `browser.test.mjs:227`
    note the plan cites is about `wind_until`'s fastForward ceiling, not CI load.)

## VERIFIED CORRECT (do not re-derive)

- **`test/replay.test.mjs:266` DOES enter `pump()`** (`behind.game.start()`), and `:267-271` asserts
  `room.now() === 38` synchronously. **The issue's AC6 rationale ("never enters the loop") is
  factually wrong.** A tick cap below 38 would break that assertion — the plan's primary
  justification for a wall-clock bound holds. File this as a comment on the issue.
- Edit B's placement: `var now = timeGetTime();` is `game.js:127`, `if (room.gap() > 0)` is `:141`,
  its re-seed `next_time = now + 1000/60;` is `:142`. A bound inserted after `:127` is genuinely
  unreachable-past for the sprint branch — **AC3 is placement, one bound, no second path.**
  Rejecting the carried-debt alternative is right: it diverges without limit and buys a recovery
  sprint at 100% CPU with no room gap behind it.
- **The `performance.now()` swap is safe.** `timeGetTime()` has exactly three references, all in
  `src/game/game.js` (`:51`, `:127`, `:170`), all pacing-local. `next_time` is only ever compared
  with, or seeded from, `timeGetTime()`; nothing persists it, serialises it, or assumes epoch
  magnitude. No `Date`-derived comparison anywhere near it.
- The local-room seed is `src/interaction/viewmodels.js:552` (`seed: Date.now() | 0`) — a **different
  call site**, untouched. `browser.test.mjs`'s pinned-clock sound walk pins it via Playwright's faked
  `Date`, which the swap does not disturb.
- `performance` exists as a global in Node 22 (and 16+) and in every target browser;
  babel-preset-env transpiles syntax only and adds no polyfill burden for a global object.
- **All three test seams are real, no production seam needed**: `globalThis.performance` is
  `{get, set, configurable}` and assignable from ESM strict mode (checked by running it);
  `globalThis.setTimeout` is writable; `renderer` is `Game`'s 4th constructor arg (`game.js:7`) and
  `renderer.clear_pobs()` is the first statement of `game_iteration()` (`game.js:98`).
- **Determinism holds**: `game_iteration()`/`this.step` gain no clock read, every read stays in
  `pump`/`start`, `src/game/game.js` imports only `./env.js`, `../game/player.js`, `../game/level.js`,
  and `performance` is a platform global rather than an import. The checksum assertions run through
  `game.step()` and `room.catch_up(game.step)`, **never through `pump`**, so they cannot move.
- **AC2 holds by construction**: the new exit is after `game_iteration()`, so every wakeup runs at
  least one tick and none is skipped; `room.step()` increments `tick` exactly once per iteration
  (`src/net/room.js:295`).
- `MAX_CATCH_UP = 3600` (`room.js:8`) with the `:134` guard is the real sprint ceiling, so "3600
  sprint iterations between draws" is accurate post-#80.
- **Ponytail**: ~8 production lines in one file is the right rung. Edit A is one line and pays for
  itself twice (monotonic guard + a clean test seam versus stubbing the `Date` constructor); the
  `ponytail:` comment on `BATCH_MS` is warranted — the nested-`setTimeout(0)` 4 ms clamp is a genuine
  measured ceiling and the 540 ms -> ~670 ms arithmetic checks out.
