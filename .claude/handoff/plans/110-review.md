# Plan review verdict — #110

**VERDICT: APPROVE WITH CHANGES.** The one line is right. Proven, not argued: replay checksums
identical, browser walk 3/5 red → 0/5 red, #96's assertions green 3/3. The **fix** survives. The
plan's **gates and mutation table** do not — one gate is unsatisfiable on a correctly-fixed tree,
and one named mutation is green against the shipped test.

> **Anchors, before you start.** The plan and this review were both written against
> `90-keyboard-screen-reader` at HEAD `96422cd`. The implementer works on a **rebased** version of
> that stack: #88 has since been amended (a CI-only failure — `process.env.RESERVE_MS` is inert
> when the relay runs in the container, now driven by the page clock instead), so #89 and #90 moved
> too. **The fix branches off `55cea8a`, not `96422cd`.** Content is the same, SHAs are not. Every
> `file:line` below was true at `96422cd` and is quoted beside its text so you can find it —
> **re-find each anchor by grep, never by line number.** Earlier issues in this chain shipped
> citations that had drifted.

> **Where this review's work lives.** `/tmp/110-review`, nothing inside any worktree:
> - `base/` — `git archive` of `96422cd`, unmodified. Reference tree.
> - `fix/` — the same, plus the one-line fix in `src/net/room.js`. Both have `node_modules` and
>   `server/node_modules` symlinked to the main checkout's.
> - `M2/ M3/ M4/ M5/` — the same plus each mutation, built by `mut.py`.
> - `repo/` — a `--shared` clone of the repo at `96422cd`, with the one-line fix **and** #96's diff
>   applied three-way and its one conflict resolved. This is the Gate 3 tree.
> - `probe.mjs`, `append.py`, `mut.py`, `walk.sh`, `gate3.sh`, `96.patch`, and every run log
>   (`base-run-N.log`, `fix-run-N.log`, `gate3-run-N.log`).
>
> `walk.sh <tree> <n>` rebuilds and runs the browser walk `n` times with a correct exit-code
> harness; `gate3.sh` does the same for `repo/`. Re-run a measurement rather than rebuilding it.

> **Worktrees.** `90` untouched (`git status --porcelain` empty). `96` untouched — still only its
> own pre-existing two-file diff. Main checkout clean. Nothing committed.

---

## MUST FIX

**1. Gate 3's second condition is unsatisfiable. It fails on a fixed tree, 100% of the time.**

§7.2 Gate 3: *"**and** no run logs a three-digit-tick desync, even when it passes."*

Measured. `/tmp/110-review/repo` = `96422cd` + the one-line fix + #96's diff. Three runs:

```
GATE3 RUN 1: exit=0 desync_ge100=1
GATE3 RUN 2: exit=0 desync_ge100=1
GATE3 RUN 3: exit=0 desync_ge100=1
```

and the lines themselves:

```
== run1 ==
room EJDSF desync 1 at tick 30, repair 1 of 5
room FDKLS desync 1 at tick 120, repair 1 of 5
== run2 ==
room KVLNU desync 1 at tick 30, repair 1 of 5
room DBDVK desync 1 at tick 120, repair 1 of 5
== run3 ==
room CUPXW desync 1 at tick 30, repair 1 of 5
room CSWUX desync 1 at tick 120, repair 1 of 5
```

Tick 120 is **#96's own deliberate lie** — `window.__lies = 1`, caught at the guest's next 30-tick
boundary. The plan itself names it (§"#96's branch as written (lie at tick 120, assert after the
take-seat)") and then forgets it when writing the gate. The plan carves out
`browser.test.mjs:989`'s tick-30 lie and misses #96's second one. An implementer running Gate 3 as
written scores 10/10 FAIL on a correct fix.

Correction — split the two conditions across the two gates, which already run on two different
trees:

- **Gate 2** (fix only, no #96) keeps the desync-line condition. Measured on `fix/`: 5/5 runs
  `desync_ge100=0`, only `at tick 30` present.
- **Gate 3** (fix + #96) drops it and asserts **exit code only**. If a desync line is still wanted
  there, exclude the lied tick — #96 already records it in `window.__lied`.

**2. The shipped test never runs `catch_up`. M5 is green. Route 3 — "the permanent one" (§5) — is
unasserted.**

Measured on `/tmp/110-review/M5` (the delete guarded by `if (!catching_up)`), against the plan's
§6.1 test verbatim — three plain `step()` calls:

```
=== M5 ===
room keys per tick: 012 | 012 | 0
THIRD: ["0"]
AI: [false,true,true,true]
catch_up gap/ticks: 3 012 | 012 | 02
existing replay suite: GREEN
```

`THIRD: ["0"]` — **no assertion goes red**. Reason: the plan's synthetic `start` has no `until`, so
`gap() === 0` and `catch_up` is a no-op; the ring frame is consumed by a **live** step. A real relay
never sends `changes`/`inputs` without `snapshot` + `until` (`resume`, grep
`inputs: room.inputs`, vs `begin`, grep `type: "start",\n                t: 0,`) — route 3 is
*always* a `catch_up`, and the test models it as a live tick.

Correction. Make the transport a factory taking an `extra` object, and add one leg. Pasteable,
verified red-before / green-after:

```js
// --- #110 handover ---
function handover_transport(extra) {
    return {
        receive(fn) {
            this.to_client = fn;
        },
        send(msg) {
            if (msg.type !== "start") return;
            this.to_client(
                Object.assign(
                    {
                        type: "start",
                        t: 0,
                        d: 2,
                        seed: 1,
                        settings: {},
                        held: [0, 1],
                        drivers: ["local", "local", "local", "ai"],
                        changes: [
                            { t: 2, seat: 1, driver: "ai" },
                            { t: 2, seat: 2, driver: "ai" },
                        ],
                        inputs: [{ t: 2, seats: { 2: { left: true, right: false, up: false } } }],
                    },
                    extra || {},
                ),
            );
        },
    };
}

const handover_room = new Room(handover_transport(), no_keys);
handover_room.start({ seed: 1, settings: {}, held: [0, 1] });
handover_room.step();
handover_room.step();
assert.deepEqual(
    Object.keys(handover_room.step()),
    ["0"],
    "a seat handed to the AI keeps no frame, whoever stamped it -- this client d ticks ago, or the relay's ring (#110)",
);

// The same frame set, reached the way a repair reaches it: `until` gives the room a gap, so
// `catch_up` replays the ring rather than a live step consuming it (#40, #110).
const replayed_room = new Room(handover_transport({ until: 3 }), no_keys);
replayed_room.start({ seed: 1, settings: {}, held: [0, 1] });
let replayed_last = null;
replayed_room.catch_up(() => (replayed_last = replayed_room.step()));
assert.deepEqual(
    Object.keys(replayed_last),
    ["0"],
    "and the ring replayed through catch_up drops it too, which is the path that made it permanent (#110)",
);
```

Measured across all trees for that second assertion: base `["0","2"]`, M5 `["0","2"]`, fix `["0"]`.
With this leg added M5 goes red on a named assertion:

```
M5 -> RED
    AssertionError [ERR_ASSERTION]: and the ring replayed through catch_up drops it too (#110)
    actual: [ '0', '2' ],
    expected: [ '0' ],
```

Note `catching_up` suppresses this client's own schedule (`room.js`, grep `if (!catching_up) {`), so
the replay leg exercises route 3 alone — which is exactly right; route 1 is the live leg's.

**3. M2's named assertion is wrong. It can never be reached.**

Plan: *"M2 … assertion that must go red: `Object.keys(third)` → `[]`"*. Measured on
`/tmp/110-review/M2` running the real `test/replay.test.mjs`:

```
M2 -> RED
    AssertionError [ERR_ASSERTION]: no_gore changes the state, which is why settings are shared and not per-client
    actual: 3954727054,
    expected: 3954727054,
```

That is `test/replay.test.mjs`, grep `"no_gore changes the state"` — around `:144-148`. Node stops
there; the new block at ~`:455` is never executed. M2 deletes every frame, so both replays run four
AI bunnies and the two settings' checksums collapse to one number. The mutation *is* caught — by a
pre-existing assertion, which is not what the plan's table claims and not what "each assertion is
mutation-tested on its own" means.

Rewrite the M2 row to name `"no_gore changes the state, which is why settings are shared and not
per-client"`, or drop M2 entirely: M3 and M4 already prove `["0"]` non-vacuous, at `["0","2"]` and
`["0","1"]`.

M2 as literally worded is also not writable. *"move the delete behind `if (!catching_up)`"* — `frames`
is declared **after** that block (`room.js`, grep `var frames = input_at[tick] || {};` follows
`if (!catching_up) {`), so `delete frames[seat]` there throws on `undefined`. Word M5's mutation as a
guard, not a move.

**4. §7.1's run harness scores a crashed run as "clean".**

```
node --no-warnings test/browser.test.mjs 2>&1 | grep -E "room .* desync [0-9]+ at tick ([0-9]{3,})" \
  && echo "RUN $i: REPRODUCED" || echo "RUN $i: clean"
```

The pipeline's exit status is **grep's**. A run that throws, times out, or fails to launch Chromium
produces no matching line and is scored `clean`. That harness can manufacture ten greens at Gate 2
out of ten broken runs — and §7.1 is the before-measurement the whole success condition rests on.

Correction, pasteable — this is what produced every number in this review:

```bash
#!/bin/bash
# run from the tree under test; $1 = number of runs
npx webpack > /tmp/110-build.log 2>&1 || { echo "BUILD FAILED"; tail -5 /tmp/110-build.log; exit 1; }
for i in $(seq 1 "$1"); do
  node --no-warnings test/browser.test.mjs > /tmp/110-run-$i.log 2>&1
  rc=$?
  hits=$(grep -cE "desync [0-9]+ at tick [0-9]{3,}" /tmp/110-run-$i.log)
  echo "RUN $i: exit=$rc desync_ge100=$hits"
done
```

Report `exit` and `desync_ge100` per run in the PR body. A run with `exit!=0` is neither red nor
clean — it is a broken run and must be re-run, not counted.

---

## SHOULD FIX

1. **§2's differentiator "A retires it" is false.** A does **not** prune the relay's ring either —
   `server/index.js`'s `room.inputs.push({ t: msg.t, seats })` and `substitute`'s
   `room.inputs.push({ t, seats })` are untouched by both candidates. A and B are identical with
   respect to what ships on the wire, and both retire the filed report's follow-up issue for the
   same reason: the client discards it on replay. Delete that row. The two real differentiators
   survive and are enough — B needs a second line to skip `game.js`'s `action_left/right/up` writes,
   and B leaves `Room.step()`'s return value contradicting the table. **Choosing A is still right.**

2. **§4's invariant is stated backwards, and omits a writer.** *"a `frames[seat]` entry exists only
   for a seat that was `"local"` at the tick it was stamped **for**"* — that is precisely the bug's
   negation. The true invariant is "…at the tick it was stamped **at**", and the `d`-tick gap
   between the two *is* the issue. The conclusion (no driver change ⇒ stamp-time equals
   consumption-time ⇒ the branch never fires) still holds, but the sentence must not ship as the
   proof. Also add the fourth writer, `frames[seat] = RELEASED` (grep that literal in `room.js`) —
   gated on `driver === "local"` at the consumption tick, so harmless, but the enumeration claims to
   be exhaustive.

3. **§5's take-seat row gives a wrong reason.** *"an `"ai"` seat has nobody stamping for it, so
   `input_at[T]` is empty at the changeover"* — false when the `ai` window is shorter than `d`. The
   real timeline in the filed evidence is `t=224 seat 1 ai` then `t=228 seat 1 local`
   (`evidence-96/verify/st-run-1.log`, the `DEBUG timeline host #20`/`#22` lines) — a four-tick
   window at `d=2`; `input_delay` clamps `d` to 2..10, so a `d=10` room has windows far shorter than
   `d` routinely. The row's **verdict** is still correct — the fix only ever deletes for
   `driver !== "local"`, so a stale frame surviving into a *new* `local` window is untouched and
   pre-existing — but the stated reason is not a proof. Fix the reason, keep the verdict.

4. **Gate 3's "apply #96's diff" does not apply.** Measured:

   ```
   git apply --check /tmp/110-review/96.patch
     error: patch failed: test/browser.test.mjs:353
     error: test/browser.test.mjs: patch does not apply

   git apply -3 /tmp/110-review/96.patch
     Applied patch to 'CLAUDE.md' cleanly.
     Applied patch to 'test/browser.test.mjs' with conflicts.
   ```

   One conflict, `test/browser.test.mjs` around `:371-428`: #90's `focused` / `focus_in` / `tab_to`
   against #96's `record_checksums` / `paired` / `disagreements`. **Union resolve — keep both
   blocks.** That is what `/tmp/110-review/repo` holds, and it passes 3/3. The cause is that
   `.claude/worktrees/96` sits at `f7c84fa`, not at the stack HEAD. Say `-3` and "expect one union
   conflict" in §10 step 10.

5. **M1 and M6 cannot both be observed in one process.** Node stops at the first failing assertion,
   so on a reverted fix the room-level assertion dies first and the `player.map(p => p.ai)` block is
   never reached. To confirm M6 the implementer must run the game-level block on its own. Verified
   directly instead — see VERIFIED CORRECT.

6. **Ten runs bounds the residual rate; it does not zero it.** `0.5^10 ≈ 1e-3` and `0.2^10 ≈ 1e-7`
   are arithmetically right, and both answer "could the *unchanged* rate produce ten greens". They
   do not answer "is it fixed". Ten greens put a 95% upper bound on the remaining per-run failure
   rate at `1 - 0.05^(1/10) ≈ 26%`. The runs corroborate; the deterministic proof is the headless
   assertion plus M1/M3/M4/M5. Word the PR body "no longer detectable at the measured rate over N
   runs", not "fixed".

7. **Anchor nits** — low cost, since the plan already says re-find by grep. The `return void` idiom
   is at `server/index.js`'s `return void room.late++`, `return void room.forged++` (the
   `MAX_CATCH_UP` one, not the line after `late`) and `return void room.forged++` in the `driver`
   case — the plan's `:1211` is `:1219`. Only **one** test transport sends a driver table shorter
   than `SEATS` (`drivers: ["local", "local"]`), not two. `"Last, because building a Game replaces
   the player array"` is one line further down than cited.

---

## Every writer of `frames[seat]` / `input_at`

`input_at[t][seat]` is written in exactly one function, `schedule_input` (grep
`var frames = (input_at[t] = input_at[t] || {});`). `frames` inside `step` aliases `input_at[tick]`
and is detached from the schedule one line later by `delete input_at[tick]`, so deleting from it
cannot corrupt another tick — the plan's placement claim is correct. Four write sites total:

| # | site | gate | can it carry a seat the table says non-`local` at the consumption tick? | verdict |
|---|---|---|---|---|
| **W1** | own schedule — `schedule_input(tick + self.d, seats)` | `drivers[seat] === "local"` evaluated at `tick`; the frame lands at `tick + d` | **yes** — exactly `d` frames after a `local→ai` handover | The bug. Fix deletes. No real input lost: the table is identical on every client at that tick. |
| **W2** | relay `input` fan-out — `schedule_input(msg.t, msg.seats)` in the `"input"` case | the relay filters by `client.seats.includes(+seat)` — **seat ownership, not driver**; a client keeps `client.seats` across `release()` (see `stamp_driver`'s own comment, *"A client that walks back to the lobby keeps its seats and hands the AI its bunnies"*) | **yes** — the same `d`-tick tail. `substitute`'s own synthesised frames **are** driver-gated (`if (drivers[seat] !== "local") continue;`) | Covered. Measured live in `evidence-96/verify/st-run-1.log`: `DEBUG step host 225 --AA local,ai,ai,ai` — a route-2 frame on a client that never held seat 1. |
| **W3** | resume ring — `(msg.inputs \|\| []).forEach(...schedule_input...)` on `start` | none; the ring is a verbatim recording of W1 + W2 | **yes**, and it is the permanent one | Covered, *provided* the replay's per-tick table is right. It is: `resume` ships `drivers_at(room, room.snapshot.t)` plus the whole of `room.stamped`, and `room.js`'s `if (t < tick)` late-apply cannot fire on a resume start, because `prune` keeps only `change.t > floor` and `floor === snapshot.t === tick` there. Cleans the ring for a **mid-match joiner** as well as for a client that was present. |
| **W4** | `frames[seat] = RELEASED` inside `drivers.forEach` | `driver === "local"` at the **consumption** tick | **no**, by construction | **Omitted from the plan's §4 enumeration.** Harmless — but the enumeration claims to be exhaustive. |

Adversarial cases checked and cleared:

- **`ai → local` (take-seat, the direction the plan waves through).** No client stamps while its own
  table says `ai`, so nothing is stranded across the changeover *unless* the `ai` window is shorter
  than `d` (possible; SHOULD FIX 3). Either way the fix never deletes inside a `local` window.
- **A frame from the relay for a seat this client does not hold.** W2. Deleted identically on every
  client, because the delete reads only `drivers`, which is relay-stamped and applied on a tick every
  client agrees on.
- **`catch_up`'s replay.** W3. Same `step`, same `drivers.forEach`. Measured: base `["0","2"]` → fix
  `["0"]`.
- **A local / loopback room, no relay at all.** `d === 0` (`loopback_transport.js`, grep `var d = 0;`),
  so the stamp tick *is* the consumption tick and `drivers[seat] === "local"` is read in the very
  `step` that consumes it. The delete can never fire on a real frame. `replay.test.mjs`'s
  `local.room.set_driver(2, "ai")` case stays green.
- **The only path that can make two clients' tables disagree** is `room.js`'s
  `if (t < tick) drivers[change.seat] = change.driver;`. On the live wire it needs
  `c > room.tick + 2d` while `room.tick >= c_fastest + d + 1` — unreachable. On a resume it cannot
  fire (above). §8.2's three arguments hold.

---

## Checksum numbers, before and after

`test/replay.test.mjs`'s three `replay()` calls, printed by a throwaway harness built exactly as §4
prescribes (`sed -n '1,135p' test/replay.test.mjs` plus one `console.log`), run on a `git archive` of
`96422cd` with and without the one-line fix:

```
BEFORE  49795982  4247476968  1435155931
AFTER   49795982  4247476968  1435155931
```

`diff` empty. `test/replay.test.mjs`, `test/relay.test.mjs` and `test/router.test.mjs` are all green
before and after. `npx prettier --check src/net/room.js` → `All matched files use Prettier code
style!` on the patched file, so the two-line split needs no reflow.

The patched hunk as it lands (prettier-stable):

```js
        drivers.forEach(function (driver, seat) {
            if (driver !== "local") return void delete frames[seat];
            if (frames[seat]) return;
            frames[seat] = RELEASED;
```

---

## VERIFIED CORRECT (do not re-derive)

- **The one line fixes the measured case.** `evidence-96/verify/st-run-1.log`, tick 233:
  `DEBUG step host 233 -AAA local,ai,ai,ai` against `DEBUG step guest 233 --AA local,ai,ai,ai`.
  `drivers[1] === "ai"` on both, so both delete, so both read `-AAA`. The same line also converges
  the host's route-2 frames at ticks 225 and 234, and the guest's catch-up pass over 224-227.
- **The plan's §6.1 test, run verbatim, behaves exactly as claimed.** Room-level: base
  `["0","1","2"]` → fix `["0"]`. Game-level: base `[false,false,false,true]` → fix
  `[false,true,true,true]`:

  ```
  === base ===
  room keys per tick: 012 | 012 | 012
  THIRD: ["0","1","2"]
  AI: [false,false,false,true]
  === fix ===
  room keys per tick: 012 | 012 | 0
  THIRD: ["0"]
  AI: [false,true,true,true]
  ```

  `Object.keys` ordering is not a hazard: array-index-like keys enumerate numerically ascending, so
  `["0","1","2"]` is deterministic. Nor is the assertion vacuous in the other direction — if the
  synthetic `start` never reached the `Room` the keys would be `[]`, and if `changes` never landed
  they would be `["0","1","2"]`. Both fail the assertion.
- **The file's `start()` helper takes the transport as its fourth positional argument** —
  `start(seed, settings, held, transport, renderer, ban_map)` — and works with a plain object that
  only implements `receive`/`send`. The game-level leg needs no hand-built object graph.
- **Mutation results**, measured against a real `test/replay.test.mjs` run with the block appended:

  | mutation | room-level keys | verdict |
  |---|---|---|
  | base (M1 / M6) | `["0","1","2"]` | red ✓ |
  | M2 (delete unconditionally) | n/a — dies at `"no_gore changes the state…"` | MUST FIX 3 |
  | M3 (`if (held.indexOf(seat) >= 0)`) | `["0","2"]` | red ✓ |
  | M4 (`if (held.indexOf(seat) < 0)`) | `["0","1"]` | red ✓ |
  | M5 (`if (!catching_up)`) | `["0"]` — **GREEN** | MUST FIX 2 |

  M3 is load-bearing beyond what the plan says for it: it is the only mutation that would catch a
  silently-dropped `inputs` payload, which is the one way `["0"]` could pass while route 3 goes
  untested.
- **`delete` on an absent key is safe and invisible.** A non-existent property is a no-op returning
  `true`; `return void true` yields `undefined`; the `forEach` continues normally. `"use strict"`
  does not throw, because every property here is a configurable data property (assignment or
  `JSON.parse`). Nothing downstream distinguishes absent from deleted — `game.js` reads `frames[i]`.
  The only production consumer of `Room.step()`'s return is `game.js`; `test/relay.test.mjs` also
  reads it twice (`first_tick`, and a 40-tick `frames` array) and both stay green, as does
  `test/replay.test.mjs`'s `late.step()[1]`. §2's "today there is one consumer" is true of
  production only.
- **The `"off"` seat case stays green.** `replay.test.mjs`'s `short_handed` block, with
  `drivers: ["local", "off", "off", "off"]`, still asserts `Object.keys(short_frames)` is `["0"]` —
  the delete is a no-op on seats that never had a frame.
- **Stats are untouched.** A non-`local` seat returned early before the fix and returns early after
  it, so `stats.holes` / `stats.substituted` never see it. `replay.test.mjs`'s
  `{ substituted: 2, arrived: 0, late: 0, worst_margin: 2, late_by: {}, holes: 0 }` assertion stays
  green.
- **Reproduction on this tree** — §7.1's own precondition, which the plan is right to demand.
  `96422cd`, unmodified, 5 runs:

  ```
  base RUN 1: exit=0 desync_ge100=0
  base RUN 2: exit=0 desync_ge100=1     room GVDYZ desync 1 at tick 150, repair 1 of 5
  base RUN 3: exit=0 desync_ge100=1     room EHRMQ desync 1 at tick 150, repair 1 of 5
  base RUN 4: exit=0 desync_ge100=1     room MPVZL desync 1 at tick 150, repair 1 of 5
  base RUN 5: exit=0 desync_ge100=0
  ```

  **3/5**, matching the 3/6 measured at `f7c84fa`. With the one-line fix:

  ```
  fix RUN 1: exit=0 desync_ge100=0
  fix RUN 2: exit=0 desync_ge100=0
  fix RUN 3: exit=0 desync_ge100=0
  fix RUN 4: exit=0 desync_ge100=0
  fix RUN 5: exit=0 desync_ge100=0
  ```

  **0/5**, with only the deliberate `at tick 30` line left in each.
- **#96 goes green with the fix**: 3/3 runs exit 0, including
  `"a client resumed from the host's snapshot hashes to the host's, tick for tick (#40)"`. The plan
  quotes that assertion's text exactly.

---

## The manual check you still owe

Nothing automated in this repo covers rendering or input, and this is the one check that would catch
the fix deleting a frame for a seat a human is **still holding** — the failure mode §8.2 names and
no headless assertion can see. It is a required step, not a nicety, and its outcome goes in the PR
body.

1. `npm run build`, open `game/index.html` in two tabs, join one room, start a match.
2. From one tab, walk back to the lobby — `release_seats()` → `set_driver(seat, "ai")`.
3. Watch that bunny **in both tabs**. It must be **AI-steered**: moving, jumping, chasing. A bunny
   that stands still with all keys released is the fix deleting a frame it should have kept.
4. Take the seat again and confirm the bunny answers the keyboard from the next tick on, in both
   tabs.
5. Also play one **local** match (no relay, `d = 0`) and confirm nothing changed there at all.

Report it as performed, with what you saw, in the PR body next to the run counts.

---

## Unbuildable / unmeasurable as claimed — where to record it

- **Gate 3 as specified cannot pass.** Record the correction in §7.2 *and* in the PR body, so the
  next reader does not re-measure `desync 1 at tick 120` as a regression.
- **#96's diff does not `git apply` onto the stack HEAD.** Record `-3` plus the one union conflict
  in §10 step 10.
- **M2 and M5 as written do not test what their table rows claim.** Record the corrected rows in
  §6.2 before running the mutation pass, or the pass certifies nothing.
- **§7.1's harness cannot distinguish a clean run from a broken one.** Replace it before taking the
  before-measurement, not after.
- Not attempted in this review, still owed: the manual two-tab pass above.

**Ponytail.** The shape is right — one line, at the only place both facts are in hand, no new API,
no relay change, no `game.js` change, no config. Nothing to cut. What was under-thought is not the
code: it is the two places the plan stopped tracing — the `catch_up` path it calls "the permanent
one" and then never drives, and the second deliberate lie in the very tree it gates on.
