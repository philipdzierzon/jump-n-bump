# Plan — #83: `pump()` cannot yield when one tick overruns the frame budget

Target: `philipdzierzon/jump-n-bump`, branch `master` @ `af04c21`.
Everything below is quoted from that tree. Line numbers are as of `af04c21`.

**One-line summary of the fix:** bound the catch-up batch by *monotonic wall clock*, not by
tick count; put the bound above both the sprint branch and the pacing branch; yield through
the exit the loop already has. Net production diff: ~8 lines in one file.

---

## 1. What §1 and §7 of `docs/research/desync-under-load.md` establish

### §1 — "The slow client's frames are late. Nearly all of them."

A 6×-CPU-throttled Chromium page against an **in-process** relay (the wire is nothing):

```
match over at tick 2713: 953 frames substituted, 936 of 955 arrived late,
worst margin -6 ticks (d 2), late by -1:73 -2:143 -3:531 -4:185 -5:2 -6:2
```

- 98% of the stream late; median **3 ticks** late, p99 4, worst 6, against `d = 2`.
  **`d` covered none of it.**
- The same run at 1× is spotless: `0 substituted, 0 of 2705 late`. It is a load fault and
  nothing else.
- The doc names the mechanism in §1 itself: *"`Room.step()` posts its frame from inside
  `pump()`'s synchronous catch-up batch, and nothing reaches the socket until the batch
  ends. The bunched arrivals show the batches directly."*

**What that rules out:** the wire, `d`, ping-derived delay, and any theory that the guest can
see its own problem (§2: the slow client reports `4 of 968` late — it is blind to it).

### §7 — "Why it cannot fire: the backlog is drained before the socket is read"

`pump()` steps its whole tick backlog synchronously, so a client coming out of a stall steps
**and stamps** every one of those ticks *before* the event loop delivers the `input` messages
that would have told it the room moved on. `newest` is stale at exactly the moment the floor
is read from it, so `max(tick + d, floor)` collapses back to `tick + d`.

**What that rules out, with numbers:**

- **#71/#79 — stamping at the relay's deadline (`newest − d + 1`).** Built and measured. 6×
  throttle, 45 s ×2: master dropped after 5 repairs at tick 840/870; with the fix, 5 repairs
  at tick 990/840. The 3×3 s freeze scenario — the one the arithmetic was written for — was
  0 drops either way. *"A client cannot compute a deadline from information that is late by
  exactly the amount it is late."* **Do not re-propose.**
- **§3 — the expensive-rebuild theory.** Six repairs on the throttled machine, worst case
  10 ms all-in for a 94-tick gap. Repair cost is not the problem. **Do not re-propose.**
- **§8** additionally records that a stamp must never outrun `newest`, because `gap()` reads
  `newest − d` as *the tick the room's fastest client is on* and `pump` sprints while that
  gap is positive. Any fix that touches stamping risks two clients ratcheting each other
  (measured: tick 62700 in a 45-second match). **This plan touches no stamp.**

Both sections point at the same place: *"`pump()`'s uncapped `while` is where the lateness
comes from"* and *"#51 is the live candidate for this failure mode... Both halves of the
lateness are `pump()`'s loop."* #83 is that change.

---

## 2. What the loop does today

`src/game/game.js:124-157`:

```js
    function pump() {
        while (playing) {
            game_iteration();
            var now = timeGetTime();
            // Behind the room rather than behind its own clock. [...]
            if (room.gap() > 0) {
                next_time = now + 1000 / 60;
                continue;
            }
            var time_diff = next_time - now;
            next_time += 1000 / 60;

            if (time_diff > 0) {
                // We have time left, so the backlog is cleared: draw once for the whole
                // catch-up batch. Catch-up itself stays uncapped and no tick is ever
                // skipped -- a slow client loses frames, never simulation state (#30).
                renderer.draw();
                setTimeout(pump, time_diff);
                break;
            }
        }
    }
```

The clock (`src/game/game.js:51-53`):

```js
    function timeGetTime() {
        return new Date().getTime();
    }
```

Seeded once per match (`src/game/game.js:170`): `next_time = timeGetTime() + 1000 / 60;`

**Trace of the lock.**

- The *only* `break` is `game.js:154`, guarded by `time_diff > 0` (`game.js:148`).
- `next_time` advances by exactly one 60 Hz frame per iteration (`game.js:146`). If a tick
  costs more than 16.67 ms of wall clock, `next_time − now` is monotonically decreasing.
  `time_diff > 0` is then never true again and the `break` is unreachable.
- The loop body calls nothing asynchronous. No draw (`game.js:152` is inside the dead
  branch), no keyboard event, no socket read, no timer. The tab is gone.
- The only other exit is `self.pause()` from `limit_reached()` (`game.js:102-111`), which
  sets `playing = false`. Both limits default to zero — endless — see `game.js:15-16`
  (`bump_limit`, `tick_limit`), so in the default match that exit never comes.

**Entrance 1 — a device that cannot sustain 60 Hz.** #51 measured simulation p95 at 4–7 ms
on an iPhone against a 16.67 ms budget. One GC inside a tick starts the compound.

**Entrance 2 — the sprint path.** `game.js:141-144` `continue`s past *both* the draw and the
`setTimeout`. The gap comes from `src/net/room.js:174-181`:

```js
    function target() {
        return Math.max(catch_up_to, newest - self.d);
    }

    this.gap = function () {
        return target() - tick;
    };
```

`newest` is raised by any peer's stamp (`src/net/room.js:156-159`, `schedule_input`). The only
ceiling is `src/net/room.js:133`:

```js
                if ((msg.t | 0) - tick > MAX_CATCH_UP) break;
```

with `MAX_CATCH_UP = 3600` (`src/net/room.js:8`). So a peer can hold `gap()` at up to 3600
*every tick*: the sprint branch is taken 3600 times between draws, forever. That is the
issue's "one drawn frame per several thousand simulated ticks".

**The comment that is wrong** — `src/game/game.js:149-151`. "Catch-up itself stays uncapped
and no tick is ever skipped -- a slow client loses frames, never simulation state (#30)."
True only while the debt can be paid off inside one wakeup. Past that the client loses the
tab, not the frame.

**`test/replay.test.mjs` — read it before believing AC6.** See §5 "Flag 1": the file
**does** enter the loop, once, at line 266. That single fact is what picks the bound.

---

## 3. The change, criterion by criterion

All production changes are in **`src/game/game.js`**. Two functions: `timeGetTime` and `pump`.

### The whole production diff

**Edit A — `timeGetTime`, `src/game/game.js:51-53`.** A wall-clock bound that a clock step can
un-trip is not a bound. Current:

```js
    function timeGetTime() {
        return new Date().getTime();
    }
```

Replace with:

```js
    // Monotonic, which the name always promised: the Win32 timer this is named after counts
    // from boot and cannot be stepped. `Date.getTime()` can go backwards under an NTP
    // correction, and a backwards step is exactly what would un-trip the batch bound below
    // and put the loop back in the lock #83 is about. Global in every browser and in Node
    // 16+, so the headless replay pays nothing for it.
    function timeGetTime() {
        return performance.now();
    }
```

Precedent for `performance.now()` in this tree: `src/interaction/game_session.js:250-288`.
`next_time` is only ever compared against values from this same function
(`game.js:127`, `145`, `170`), so the epoch change is invisible. No other caller exists —
`grep -rn "timeGetTime" src/` returns only `game.js:51,127,170`.

**Edit B — `pump`, `src/game/game.js:124-157`.** Final shape:

```js
    // The most wall clock one catch-up batch may hold the event loop for. One frame: the
    // loop exists to hit 60 Hz, so blocking longer than the frame it is chasing is never
    // the right trade. Ticks are not capped and none is skipped -- what is capped is how
    // long the socket, the keyboard and the timer wait between two of them (#83).
    //
    // ponytail: a bounded batch yields through `setTimeout(pump, 0)`, which browsers clamp
    // to 4 ms once nested five deep, so a client that cannot keep up catches up at roughly
    // an 80% duty cycle instead of 100%. Upgrade path: `scheduler.yield()`, or a
    // `MessageChannel` ping, if catch-up throughput ever measures short.
    var BATCH_MS = 1000 / 60;

    function pump() {
        var batch_started = timeGetTime();
        while (playing) {
            game_iteration();
            var now = timeGetTime();
            // Above the sprint branch on purpose: a peer holding `gap()` positive drives
            // that branch past both the draw and the yield, and it is the entrance that
            // needs the bound most (#83, and `docs/research/desync-under-load.md` §7 --
            // a client that has not read its socket cannot know what the room is doing).
            if (now - batch_started >= BATCH_MS) {
                next_time = now + 1000 / 60;
                renderer.draw();
                setTimeout(pump, 0);
                return;
            }
            // Behind the room rather than behind its own clock. The ticks between here and
            // the newest frame anybody has stamped are ticks whose input has already
            // arrived, so stepping them is replay and not guesswork -- and a client that
            // paces them off its own clock instead never closes the gap, because it steps
            // at the same 60 Hz the room does. Every frame it sends is then stamped for a
            // tick the room has already passed, which the relay drops (#42).
            //
            // A rebuild is where that gap comes from: a resumed client replays to the tick
            // the room was on when the payload was built, and decoding a state, building an
            // object graph and replaying the gap all take time the room spends playing
            // (#40, #70). The budget is re-seeded rather than advanced, because the ticks
            // just stepped are the room's backlog and not this client's own schedule --
            // advancing it would sleep the gap straight back open.
            if (room.gap() > 0) {
                next_time = now + 1000 / 60;
                continue;
            }
            var time_diff = next_time - now;
            next_time += 1000 / 60;

            if (time_diff > 0) {
                // We have time left, so the backlog is cleared: draw once for the whole
                // catch-up batch. Catch-up stays uncapped in ticks and no tick is ever
                // skipped -- what bounds it is `BATCH_MS` of wall clock per batch, so the
                // loop always reaches this yield or the one above it. That bound is what
                // makes the old claim true: a slow client loses frames, never simulation
                // state (#30, #83).
                renderer.draw();
                setTimeout(pump, time_diff);
                return;
            }
        }
    }
```

Changed lines only, against `af04c21`: `var BATCH_MS` + its comment (new, before line 124),
`var batch_started = timeGetTime();` (new, line 125), the six-line bounded-exit block (new,
after line 127), `break` → `return` at line 154, and the reworded comment at lines 149-151.

`break` → `return` is cosmetic (the `while` guard makes them equivalent) but pairs the two
exits visually; keep `break` instead if you prefer a smaller diff.

---

### AC1 — "always yields within a bounded number of simulation ticks, however long an individual tick takes"

**File/function:** `src/game/game.js`, `pump`. **Edit:** the `batch_started` capture and the
`now - batch_started >= BATCH_MS` block above.

**Why this bound and not a tick count.** Three reasons, in order of force:

1. **A tick count breaks AC6.** `test/replay.test.mjs:266` calls `behind.game.start()` — into
   `pump()` — with `gap() === 38`, and asserts on line 267-271 that `room.now()` is `38`
   *synchronously on return*. Any tick bound below 38 makes that read `8`, or `4`, or whatever
   the cap is. A wall-clock bound of one frame does not trip: 38 headless ticks with
   `no_renderer` cost well under a millisecond. **AC6 and a tick cap cannot both be had.**
2. **Wall clock bounds the quantity that actually matters.** The harm is event-loop blockage
   — the socket not being read, per §1 and §7 — and blockage is measured in milliseconds, not
   ticks. A tick cap is a proxy that is wrong in both directions: 4 ticks × 30 ms on a phone
   is a 120 ms block that passes the cap, and 4 ticks × 0.15 ms on a desktop is a pointless
   yield that stretches a 3600-tick catch-up over 900 wakeups.
3. **It cannot regress.** `performance.now()` is monotonic (Edit A). `Date.getTime()` is not,
   and a backwards NTP step would make `now - batch_started` negative and restore the lock.

**Is AC1 literally met?** With `BATCH_MS` the loop yields after *at most one tick past* the
bound, so ticks-per-batch is `BATCH_MS / (cost of the cheapest tick)` — finite for any
non-zero tick cost, but not a fixed constant. AC1's clause "however long an individual tick
takes" is satisfied exactly: one slow tick can no longer prevent the exit. See §5 "Flag 2"
for the literal-reading version and why it should not be built.

### AC2 — "no tick is ever skipped"

**Edit:** none beyond the above; this is a property to preserve, and the plan preserves it by
construction.

`room.tick` advances by exactly one per `room.step()`, called once per `game_iteration()`
(`game.js:61`, via `update_player_actions`). `pump` calls `game_iteration()` once per loop
iteration and the new exit is *after* the call, never instead of it. Nothing anywhere skips
forward. Both exits yield; neither drops work.

**On the debt.** The bounded exit re-seeds `next_time = now + 1000 / 60` rather than carrying
the pacing deficit. That is the same thing the sprint branch already does at `game.js:142`,
for the reason its own comment gives (`game.js:138-140`). It means a client that genuinely
cannot do 60 Hz runs slower than wall clock and falls behind the *room* — and that is
precisely the outcome the issue asks for ("spread across wakeups, and is simply behind"),
and the room, not this budget, is what then pulls it forward: peers' stamps raise `newest`,
`gap()` goes positive, and the sprint branch drives it as fast as the batch bound allows.

Carrying the debt instead was considered and rejected: on a sustained overrun `next_time`
diverges without limit, and if the machine later recovers the client sprints through hours of
accumulated budget at 100% CPU with no room gap to justify it. Re-seeding is one line, has
precedent eleven lines below it, and matches the loop's own stated philosophy — it paces
against the room, not against its own clock.

Cost of re-seeding: a single transient GC pause is not paid back, so the client is one tick
behind the wall clock afterwards. It closes that through `gap()` if it matters to anyone, and
does not if it does not.

### AC3 — "the positive-gap sprint path is subject to the same bound"

**Edit:** placement. The bound check sits **above** `if (room.gap() > 0)` at `game.js:141`,
so the sprint branch cannot be reached without passing it. There is one bound, not two, and
no second code path to keep in step. This is the whole of AC3.

Side effect, deliberate and good: a catch-up sprint now draws once per `BATCH_MS` instead of
not at all. A 3600-tick worst-case catch-up at ~0.15 ms/tick is ~540 ms and ~33 draws — a
visible replay instead of a frozen canvas, at negligible cost.

### AC4 — the headless test

See §4 in full. **File: `test/replay.test.mjs`.** Two injectable seams needed, **both already
exist**, so no production seam is added:

- **the clock** — `globalThis.performance`, read at call time by `timeGetTime()` after Edit A;
- **the yield** — `globalThis.setTimeout`, read at call time by `pump`;
- **a slow tick** — the `renderer` collaborator, already a constructor argument of `Game`
  (`src/game/game.js:7`), whose `clear_pobs()` is the first call in `game_iteration()`
  (`game.js:98`). One line is added to the *test's own* `start()` helper to let a case pass
  its own renderer.

### AC5 — the comment

**File/function:** `src/game/game.js`, `pump`. **Edit:** replace `game.js:149-151`

```js
                // We have time left, so the backlog is cleared: draw once for the whole
                // catch-up batch. Catch-up itself stays uncapped and no tick is ever
                // skipped -- a slow client loses frames, never simulation state (#30).
```

with

```js
                // We have time left, so the backlog is cleared: draw once for the whole
                // catch-up batch. Catch-up stays uncapped in ticks and no tick is ever
                // skipped -- what bounds it is `BATCH_MS` of wall clock per batch, so the
                // loop always reaches this yield or the one above it. That bound is what
                // makes the old claim true: a slow client loses frames, never simulation
                // state (#30, #83).
```

The criterion asks for the *bound* to be stated, not the claim to be softened. It now names
`BATCH_MS`, says which yields exist, and says the claim holds *because* of them.

### AC6 — `test/replay.test.mjs` unaffected

**Edit:** none to any existing line of that file; one optional-parameter addition to its
`start()` helper (§4) which every existing call site ignores.

Verified by reading: the file is synchronous top-level `assert` statements; it steps by hand
via `game.step()` (lines 123, 147, 182, 184, 372, 378-383, 390-393, 428, 525, 529) and via
`room.catch_up(game.step)` (lines 286, 477, 502, 524). `Loopback_Transport` is fully
synchronous — no timers anywhere in `src/net/loopback_transport.js`.

**The one exception, and it is the whole reason the bound is wall-clock:** lines 264-272.

```js
const behind = start(9, {}, [0], behind_transport(40));
assert.equal(behind.room.gap(), 38, "the room is 38 ticks past the tick this client landed on");
behind.game.start();
assert.equal(
    behind.room.now(),
    38,
    "and the pump steps the backlog out before it paces itself, rather than one tick a frame",
);
assert.equal(behind.room.gap(), 0, "so the next frame it sends is for a tick nobody has passed");
behind.game.pause();
```

With `BATCH_MS = 1000 / 60` this passes untouched: 38 `no_renderer` ticks against a real
`performance.now()` take microseconds, so the bound never trips and the sprint branch runs to
`gap() === 0` exactly as today. See §5 "Flag 1" — the issue's stated reason for AC6 is wrong,
the criterion itself is right.

---

## 4. The test

**File: `test/replay.test.mjs`.** Justified from how each file is written:

| file | why not |
| --- | --- |
| `test/relay.test.mjs` | Runs a real server on a real socket (`start_server`, `WebSocket_Transport`) and is full of `await new Promise(r => setTimeout(r, 100))`. Stubbing global `setTimeout` there would stop the file dead. |
| `test/router.test.mjs` | Pure functions only — `screen_of`, `jump_scheme`, `match_result`. It never builds a `Game`. |
| `test/browser.test.mjs` | Needs Playwright and a browser. AC4 explicitly says the test must not. |
| **`test/replay.test.mjs`** | **The only file that builds a headless `Game` and already drives `pump()` (line 266). The existing pump-behaviour assertions live here, next to the `behind_transport` fixture this test reuses.** |

### The one helper change

`test/replay.test.mjs:90` today:

```js
function start(seed, settings, held, transport = new Loopback_Transport()) {
```

becomes

```js
function start(seed, settings, held, transport = new Loopback_Transport(), renderer = no_renderer) {
```

and the `no_renderer` passed as `Game`'s fourth argument at line 100 becomes `renderer`. The
`Animation` at line 99 keeps `no_renderer` — the slow-tick hook is `clear_pobs`/`draw`, both
called from `game.js`. Every existing call site passes four arguments or fewer and is
unchanged.

### The case itself

Appended after the `behind` / `repaired` / `absurd` block (i.e. after `test/replay.test.mjs:372`
or wherever the pump section ends):

```js
// #83: one simulation tick that costs more than a frame must not lock the loop. The pump
// advances its budget by exactly one frame per tick, so before the batch bound a tick that
// overran it left `next_time - now` monotonically decreasing and the break unreachable --
// no draw, no keyboard, no socket read, and in an endless match no exit at all. Both the
// clock and the yield are globals the pump reads at call time, so a fake clock here needs
// no seam the game does not already have.
{
    const real_performance = globalThis.performance;
    const real_setTimeout = globalThis.setTimeout;
    let fake = 0;
    let drawn = 0;
    let stepped = 0;
    const yields = [];
    // The fake clock only moves when a tick runs, so nothing here depends on how fast the
    // machine running the test is. 20 ms a tick against a 16.67 ms budget.
    const slow_renderer = {
        add_pob() {},
        add_leftovers() {},
        clear_pobs() {
            fake += 20;
            // A regression would hang rather than fail, so it is turned into a failure here.
            if (++stepped > 100) throw new Error("#83: pump spun instead of yielding");
        },
        draw() {
            drawn++;
        },
    };
    globalThis.performance = { now: () => fake };
    globalThis.setTimeout = (fn, ms) => yields.push(ms); // the wakeup is never run

    try {
        const slow = start(9, {}, [0], new Loopback_Transport(), slow_renderer);
        slow.game.start();
        assert.equal(stepped, 1, "the batch ends on the tick that overran the frame budget");
        assert.equal(yields.length, 1, "and the loop yields to the event loop rather than spinning");
        assert.equal(slow.room.now(), 1, "the tick it stepped is stepped, not skipped");
        assert.equal(drawn, 1, "a bounded batch still draws, so the tab is not frozen either");
        slow.game.pause();

        // AC3: the same bound above the sprint branch, which `continue`s past both the draw
        // and the yield and which any peer can hold open up to MAX_CATCH_UP every tick.
        fake = 0;
        stepped = 0;
        drawn = 0;
        yields.length = 0;
        const sprinting = start(9, {}, [0], behind_transport(40), slow_renderer);
        assert.equal(sprinting.room.gap(), 40, "the room is 40 ticks ahead before the first step");
        sprinting.game.start();
        assert.equal(stepped, 1, "a sprint is bounded by the same batch budget");
        assert.equal(yields.length, 1, "and yields instead of draining 40 ticks in one block");
        assert.equal(sprinting.room.gap(), 39, "the backlog is still there, to be run next wakeup");
        sprinting.game.pause();
    } finally {
        globalThis.performance = real_performance;
        globalThis.setTimeout = real_setTimeout;
    }
}
```

**The seams, named.**

- **Injectable today, no production change:** `globalThis.setTimeout` (`game.js:153`, and the
  new exit) and `globalThis.performance` (`game.js:52` *after Edit A*) — both resolved at call
  time from the global scope of an ESM module, so assigning to `globalThis` before
  `game.start()` is enough. `renderer` (`Game`'s 4th constructor argument, `game.js:7`).
- **Not injectable today, and deliberately not made so:** the clock is a module-private
  function, `timeGetTime` at `game.js:51`. Making it a constructor parameter would add a
  tenth argument to `Game` and a clock to the simulation layer's public surface for one test.
  The global stub costs nothing and touches no production file. **No new seam is needed.**
- **Before Edit A** the clock is `new Date().getTime()`, which is fakeable only by replacing
  the `Date` constructor — messier, and the whole point of Edit A is that a steppable clock
  here is the same hazard as a steppable clock in production.

**Without the fix, this test hangs** (the loop is genuinely infinite: `gap()` is `-1` on a
loopback after one step, `time_diff` is `16.67 - 20 < 0`). The `stepped > 100` throw turns
that hang into a named failure. Keep it.

`gap() === 40` in the sprint case, not 38: `behind_transport(40)` delivers frames for ticks
`0..40` with `d = 2`, so `target()` is `40 - 2 = 38` and `gap()` is `38 - 0 = 38` *before any
step*. **Check this against the file when implementing** — line 265 asserts 38 at tick 0, so
the assertions above should read `38` before `start()` and `37` after one tick. The shape is
what matters; take the numbers from the existing line 265.

**Run:** `node --no-warnings test/replay.test.mjs`. No new `npm` script; `npm test` already
runs this file first.

---

## 5. Risks and flags

### Flag 1 — AC6's stated reason is factually wrong, and it matters

> "`test/replay.test.mjs` is unaffected — it steps the simulation by hand and never enters
> the loop"

It enters the loop, once, at `test/replay.test.mjs:266` (`behind.game.start()`), and asserts
synchronously on the result. **Do not take "never enters the loop" as licence to cap ticks.**
The criterion (the file must be unaffected) is right and is met by the wall-clock bound; the
reason given for it is not. Worth a one-line correction on the issue.

### Flag 2 — AC1's literal "bounded number of simulation ticks" should not be built literally

A wall-clock bound bounds *blockage*, which is the harm §1 and §7 measured. A literal tick
cap additionally bounds tick count — and costs AC6, costs a slow phone (4 slow ticks is
still a long block), and costs catch-up throughput on a fast one. **Recommend: build the
wall-clock bound, amend AC1's wording to "within a bounded amount of wall clock".** Flagging
rather than dropping — if the reviewer insists on a literal tick cap, it must be paired with
a decision about `test/replay.test.mjs:266`.

### Risk — determinism

**The simulation gains no clock read.** `game_iteration()` (`game.js:97-112`) and
`this.step` (`game.js:116`) are untouched; every clock read stays inside `pump`, which is
pacing and which `test/replay.test.mjs` never relies on for state. `src/game/` still imports
nothing from `src/interaction/`. `performance.now()` is a platform global, not an import.

**One thing to watch:** `timeGetTime` lives in `src/game/game.js`, so `src/game/` does hold a
clock read — it already did, at line 52, and this plan does not add a second site. If a
future change moves a clock read into `game_iteration`, `test/replay.test.mjs`'s checksum
comparison is what fails. **Say it loudly to whoever implements this: do not read the clock
inside `game_iteration`.**

### Risk — the browser suite

`test/browser.test.mjs` plays real matches through `pump()`. Batches there are one or two
ticks and nowhere near 16 ms, so the bound should not trip; the risk is a heavily loaded CI
machine tripping it and changing how many ticks land per wakeup. Nothing in that file asserts
on tick counts per wakeup (it asserts on screens, sound, boards), but `test/browser.test.mjs`
has an existing timeout ceiling (`ponytail:` note at line 227) — **run the browser suite once
before merging** rather than assuming.

### Risk — how a match feels

- **Sustained overrun:** the client now yields every ~16 ms, so it stays responsive and its
  frames reach the socket during the backlog rather than after it — which is the §1/§7 fix.
  It also falls behind the room in wall clock, which is the intended trade: the relay handles
  behind-ness with substitution, AI takeover and resync (#40, #42).
- **Catch-up:** a 3600-tick sprint goes from one synchronous block to ~33 bounded batches,
  each followed by a `setTimeout(0)`. Nested `setTimeout(0)` clamps to 4 ms after five levels,
  so ~540 ms of work becomes ~670 ms. Acceptable; flagged in the `ponytail:` comment.
- **Nothing in the simulation changes**, so a match's outcome from a given seed and input log
  is bit-identical. `test/replay.test.mjs`'s checksum assertions prove it.

### Where the `ponytail:` comment goes

On `BATCH_MS`, as written in §3 Edit B: the ceiling is the `setTimeout(0)` 4 ms clamp costing
catch-up throughput; the upgrade path is `scheduler.yield()` or a `MessageChannel` ping. One
comment, at the point of the compromise, per `CLAUDE.md`'s "Coding standards".

---

## 6. Deliberately not doing

- **Capping or skipping catch-up ticks** — a skipped tick is a divergence; the issue puts it
  out of scope and so does this plan.
- **Stamping at the relay's deadline (#71/#79)** — built, measured, rejected; §7 says a
  client cannot compute a deadline from data it has not read yet.
- **Reusing the object graph across a repair** — §3: a repair is under 10 ms all in. Dead.
- **Deriving `d` from something other than ping** — §"What this turns into": ping is not what
  makes a frame late; a bigger `d` treats a symptom.
- **`requestAnimationFrame` pacing and the hidden-tab freeze** — #51's, explicitly out of
  scope here.
- **Making `BATCH_MS` configurable** — one constant, one call site, no evidence any client
  wants a different number. Add a knob when a measurement asks for one.
- **Injecting the clock into `Game`'s constructor** — a tenth argument for one test, when
  `globalThis.performance` is already the seam.
- **Carrying the pacing debt across a bounded exit** — §3/AC2: unbounded `next_time`
  divergence buys a recovery sprint nobody asked for.
- **A new npm script or test file** — `npm test` already runs `test/replay.test.mjs` first.
- **Touching `src/net/room.js`** — `gap()`, `target()` and `MAX_CATCH_UP` are read, not
  changed. §8 is a standing warning against touching stamps to fix pacing.
