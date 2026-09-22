# #110 — A seat handed to the AI keeps its last human frames on the client that sent them

Plan only. Repo `philipdzierzon/jump-n-bump`, read in the worktree
`/Users/philipdzierzon/Documents/sbx/jumpnbump/jump-n-bump/.claude/worktrees/90`, branch
`90-keyboard-screen-reader`, HEAD `96422cd` (the whole #81 stack: #82–#95 plus #92, #86, #93,
#87, #88, #89, #90). Every line number below is that tree's.

> **Anchors.** The implementer works on a **rebased** version of this stack — same content,
> different SHAs. Every `file:line` here is quoted with the exact text beside it.
> **Re-find each anchor by grep, never by line number.** Earlier issues in this chain shipped
> citations that had drifted.

**The whole production change is one line in `src/net/room.js`.** No new module, no new
message type, no new `Room` method, no relay change, no `game.js` change, no config. If a
review of this plan finds a frame-ownership abstraction, a driver-change queue, a validation
pass over `input_at`, or a second reconciliation in the relay, the review is reading the
wrong plan.

Stacks on top of #90. #96 lands after it, unmodified.

---

## 1. What the code does today

### 1.1 Two sources of truth about one question

Who steers seat *s* on tick *t*? The room answers twice.

**Answer A — the driver table.** Relay-owned. `server/index.js:675-686`:

```js
function stamp_driver(room, seat, driver) {
    const t = room.tick + 2 * room.d;
    ...
    broadcast_frame(room, { type: "driver", t, seat, driver });
    room.stamped.push({ t, seat, driver, was: room.drivers[seat] });
```

One number, one seat, one value, broadcast to everybody. Client applies it on that exact
tick, `src/net/room.js:277-281`:

```js
    this.step = function () {
        (drivers_at[tick] || []).forEach(function (change) {
            drivers[change.seat] = change.driver;
        });
        delete drivers_at[tick];
```

Measured: the two pages' tables are **identical** at the handover tick
(`evidence-96/verify/st-run-1.log` — `local,ai,ai,ai` on both).

**Answer B — frame presence.** `src/game/game.js:64-73`:

```js
    function update_player_actions() {
        var frames = room.step();
        for (var i = 0; i != player.length; ++i) {
            var frame = frames[i];
            player[i].ai = !frame;          // <- frame presence, not the driver table
            if (!frame) continue;
            player[i].action_left = frame.left;
```

and `src/game/ai.js:31-34` steers exactly the seats with `.ai` set.

Nothing reconciles A and B. `Room.step` is the only place both are in hand.

### 1.2 How B goes wrong: the `d`-tick tail

Every tick, unconditionally, a client stamps its own frame `d` ahead and schedules a copy of
it for itself — `src/net/room.js:283-292`:

```js
        if (!catching_up) {
            var seats = {};
            held.forEach(function (seat, scheme) {
                if (drivers[seat] === "local") seats[seat] = read_input(scheme);
            });
            schedule_input(tick + self.d, seats);
            transport.send({ type: "input", t: tick + self.d, seats: seats });
```

The `drivers[seat] === "local"` test is read **at schedule time**, `d` ticks before the
frame is used. The handover is stamped for a tick that has not arrived. So a client that
held the seat at `T-1` has frames sitting in `input_at[T] … input_at[T+d-1]` for a seat the
room hands to the AI at `T`. Exactly `d` of them.

`step` then never drops one — `src/net/room.js:314-323`:

```js
        drivers.forEach(function (driver, seat) {
            if (driver !== "local" || frames[seat]) return;
            frames[seat] = RELEASED;
```

`forEach` only ever **adds** a released floor for `"local"` seats. A frame for a seat that
is now `"ai"` is untouched, handed to `game.js`, and `player[i].ai = !frame` reads `false`.

`room.js:304-313`'s own claim — a missing frame "cannot manufacture a divergence" — is true
only while the table says `"local"`. Past a handover it is a frame *present* that
manufactures one.

### 1.3 Three ingresses for that stale frame, not one

The frame reaches `input_at[T]` by three routes, and the fix must cover all three, which is
why it belongs at consumption and not at scheduling.

1. **The sender's own schedule.** `room.js:291` above. Always present on the sender.
2. **The relay's fan-out.** `server/index.js:1240` broadcasts a client frame to every other
   client with **no driver filter at all**:
   ```js
   broadcast_frame(room, { type: "input", t: msg.t, seats }, client);
   ```
   Only two guards precede it: `server/index.js:1209` `if (msg.t < room.due) return void
   room.late++` (a deadline, not a driver test) and the forged-seat check. So a peer that is
   *not* ahead of the deadline receives the stale frame too, and one that is ahead does not.
   **That race is the nondeterminism.** Whether a given client ends up with the frame depends
   on wire timing.
3. **The resume ring.** `server/index.js:1243` `room.inputs.push({ t: msg.t, seats })` —
   same unconditional push. The ring ships whole in the repair payload,
   `server/index.js:914-917`:
   ```js
   changes: ahead.map(({ t, seat, driver }) => ({ t, seat, driver })),
   ...
   inputs: room.inputs,
   ```
   and the client schedules every ring entry on `start`, `room.js:119-121`. So a client that
   replays the gap re-reads the stale frame **and** applies the `"ai"` change for the same
   tick. Confirmed by the filed evidence: the payload in `verify/nolie-run-4.log` carries
   ring entries for handover ticks 159 and 160 themselves.

Route 3 is why the divergence is **permanent**: the repair replaces the state and then
replays the poison back into it. Three consecutive disagreeing samples (180, 210, 240) in
`verify/nolie-run-4.log`, repair at 180 not curing it.

### 1.4 The relay agrees with the table; only frame presence does not

`server/index.js:744-750`, inside `substitute`:

```js
        for (const change of landing[t] || []) drivers[change.seat] = change.driver;
        const seats = {};
        for (let seat = 0; seat < SEATS; seat++) {
            if (drivers[seat] !== "local") continue;
```

The relay will not ring a released frame for a non-`local` seat, and `drivers_at`
(`server/index.js:708-712`) rebuilds the table per tick to do it. So the relay's own model
of "who steers seat *s* on tick *t*" is the driver table, full stop. The client's is frame
presence. **The client is the odd one out.**

### 1.5 Which handover the walk actually hits

Not settled by the evidence, and the fix does not depend on it. Two candidates, both
`local -> ai`, both covered:

- **`release()` on the way to the lobby.** `viewmodels.js:571` `if (played)
  game.release_seats();` → `game_session.js:168-170` → `room.release()` →
  `set_driver(seat, "ai")` per held seat. The very next statement is `game.stop()` →
  `game.pause()`, so the leaving client stops stepping and never consumes its own tail. Its
  frames still went out on the wire, so routes 2 and 3 carry them.
- **The relay's AI takeover.** `server/index.js:777-779`, after `AI_AFTER` missing ticks:
  `stamp_driver(room, seat, "ai")`. Same shape.

Either way the guest's `--AA` at tick 233 is a replay (`window.__steps` accumulates across
sessions in one page; the take-seat rebuilds the session but not the page), reading the ring
that the host's live step never saw. Route 3.

---

## 2. Which side is wrong

Two one-line candidates. They are not equivalent.

| | **A — reconcile in `Room.step`** | **B — `game.js` reads the driver table** |
|---|---|---|
| change | drop `frames[seat]` when the table says not `"local"` | `player[i].ai = room.driver(i) !== "local"` |
| covers route 1 (own schedule) | yes | yes |
| covers route 2 (relay fan-out) | yes | yes |
| covers route 3 (resume ring) | yes | yes |
| new API | none | a `Room.driver(seat)` accessor |
| stale keys still written | no — the frame is gone | **yes** — `game.js:70-72` writes `action_left/right/up` from `frame` whenever `frame` is truthy; B must *also* skip that, so B is two lines |
| `frames` returned to callers | consistent with the table | still contradicts it; the next reader re-learns the lesson |

**Root is A.** The driver table is the room's authority: relay-stamped, applied on a tick
every client agrees on, and demonstrably identical across clients at the divergence. Frame
presence is a *derivation* of it. The derivation is performed in `Room.step` — the one
function that has both facts — and it is performed incompletely. `game.js:68` is the
**symptom**: it is downstream of a value that is already wrong when it arrives.

What B breaks if chosen wrongly, traced:

- `player[i].ai = !frame` is also how a seat with **no driver entry at all** is driven —
  `room.js:276`: *"A seat with no driver at all is one nobody is holding, which is the AI's"*.
  Under B that becomes `drivers[i] !== "local"`, and `undefined !== "local"` is `true`, so
  that case survives. It is not the trap it looks like. Two live shapes confirm it:
  `test/replay.test.mjs:216` sends `drivers: ["local", "local"]` (seats 2 and 3 absent), and
  `server/index.js:127` initialises `new Array(SEATS).fill(null)` before `begin` overwrites
  it at `:1091-1094`.
- The real cost of B is the second line: leaving the contradictory frame in the map means
  every consumer of `Room.step()`'s return value has to know about it. Today there is one
  consumer; adding a rule that only one caller honours is how a third source of truth starts.
- B also leaves the relay's ring poisoned on the wire. Same observable behaviour after B,
  but the payload still ships a frame nobody may use, and the "prune the ring" issue the
  filed report parks stays live. A retires it.

What A breaks if chosen wrongly — the one honest risk: **A is the first code in this room
that ever *removes* input.** Until now `step` only added a floor. If any path lets one
client's table disagree with another's at a given tick, A converts a one-tick disagreement
into an AI-steered bunny instead of a one-tick input difference. Exactly one path can do
that, and it already diverges without A: `room.js:179-183`,

```js
    function stamp_driver(change) {
        var t = change.t | 0;
        if (t < tick) drivers[change.seat] = change.driver;
        else (drivers_at[t] = drivers_at[t] || []).push(change);
    }
```

A change for a tick already stepped is applied **now**, with the existing `ponytail:` note at
`:175-178` saying so: *"applied late converges the driver table but not the state behind it,
and two clients that passed the tick at different moments disagree for that window."* A does
not create that lag and does not widen the window; it changes what the lagging client does
inside it from "uses its own keys" to "uses the AI" — which is what the non-lagging clients
already do. See §7.

---

## 3. The fix

`src/net/room.js`, in `step`. Grep anchor: `if (driver !== "local" || frames[seat]) return;`

```diff
         drivers.forEach(function (driver, seat) {
-            if (driver !== "local" || frames[seat]) return;
+            // The table and the frame set are one answer to one question, reconciled here
+            // because this is the only place both are in hand. A frame for a seat the room
+            // has since handed over was stamped d ticks ago, while the seat was still its
+            // sender's; the relay agrees with the table and rings nothing for such a seat
+            // (`substitute`), so keeping it makes the sender -- and any peer the fan-out
+            // reached in time -- the only clients running that bunny on keys (#110, #7).
+            if (driver !== "local") return void delete frames[seat];
+            if (frames[seat]) return;
             frames[seat] = RELEASED;
```

One behavioural line (`return void delete frames[seat];`), one condition split, one comment.
`return void <expr>` is this codebase's existing idiom — `server/index.js:1209`,
`:1211`, `:1270`.

Placement is load-bearing and must not be moved:

- **After** `drivers_at[tick]` is applied (`room.js:278-281`), so `driver` is the table *as
  of this tick*, not as of the previous one.
- **After** `var frames = input_at[tick] || {}; delete input_at[tick];`
  (`room.js:302-303`), so `frames` is the detached per-tick object — deleting from it cannot
  corrupt the schedule for another tick.
- **Inside** the existing `drivers.forEach`, so it runs on every path into `step`: live,
  `catch_up` replay, and the first `d` ticks of a match. Do **not** guard it with
  `if (!catching_up)`; the replay is the path that makes the bug permanent (§1.3, route 3).

Not done, deliberately: a filter in `schedule_input`. The handover is stamped for a tick
that has not happened when the frame is scheduled, so a schedule-time test cannot know. A
consumption-time test is not a shortcut — it is the only correct time.

**Known gap, accept it:** `drivers.forEach` visits only indices the table has. A table
shorter than `SEATS` leaves a frame for an unvisited seat in place. The relay always sends
four (`server/index.js:1091-1094`, `room.seats.map` over `SEATS`); only two test transports
send fewer, and neither has a frame for a missing index. Not worth a second loop.

---

## 4. Determinism

**Claim: the fix cannot alter any replay that involves no handover.**

Proof, by enumerating every writer of `frames[seat]`:

1. `room.js:291` `schedule_input(tick + self.d, seats)` — `seats` is built at `:285-287`
   behind `if (drivers[seat] === "local")`. Only `"local"` seats.
2. `room.js:148` `schedule_input(msg.t, msg.seats)` from the relay — the relay forwards
   only seats the sender holds (`server/index.js:1234-1239`), and rings substitutes only
   for `"local"` seats (`server/index.js:749`).
3. `room.js:119-121` the resume ring — the same two writers, recorded.

So a `frames[seat]` entry exists only for a seat that was `"local"` at the tick it was
stamped for. With no driver change, `"local"` at stamp time is `"local"` at consumption
time, `driver !== "local"` is false for every seat that has a frame, and the new branch
never fires. `frames` is byte-identical. `game_iteration` is a pure function of `frames` and
the prior state (`game.js:76-88`, `ai.js:31-40`, and `rnd.js` reads nothing else), so the
state is identical and the FNV-1a checksum is identical.

`test/replay.test.mjs`'s `replay()` (`:120-135`) is exactly that case: `held = [0, 1, 2]`,
loopback drivers `["local","local","local","ai"]` (`loopback_transport.js:48-51`), no
`set_driver` call for 3600 ticks.

This chain treats a changed checksum as a bug in the change, not a number to update. So
**prove it with numbers, not with the argument above** — the #86 discipline: run old and new
over the same seeds and diff.

The suite asserts checksum *relations*, never a literal (`grep -n "assert.equal(replay"` →
one line, comparing two calls), so the numbers must be printed by a throwaway harness that
lives **outside the repo** and is deleted after.

```
# once, BEFORE editing room.js
cat > /tmp/110-checksums.mjs <<'EOF'
// throwaway: prints the three replay checksums test/replay.test.mjs asserts relations over.
// keep in sync with replay.test.mjs's own `replay()` by copy, then delete.
EOF
# fill it by copying, verbatim, from test/replay.test.mjs:
#   the imports, TICKS, fnv1a, checksum, input_log, no_renderer, no_sfx, start, replay
# then append:
#   const log = input_log(99);
#   console.log(replay(1234, log), replay(4321, log), replay(1234, log, { no_gore: true }));
node --no-warnings /tmp/110-checksums.mjs > /tmp/110-before.txt

# ... apply the one-line fix ...

node --no-warnings /tmp/110-checksums.mjs > /tmp/110-after.txt
diff /tmp/110-before.txt /tmp/110-after.txt && echo "DETERMINISM OK"
rm /tmp/110-checksums.mjs
```

`diff` must be empty. If it is not, **stop** — the fix is wrong, not the checksum.

Second determinism fact, stated because A makes it true and it was not before: after the
fix, `player[i].ai` is a pure function of the driver table, which is a pure function of the
`start` payload plus the ordered `driver` messages — all of which every client receives
identically. Frame timing on the wire can no longer change which bunny the AI steers. That
is the property #96's assertion is measuring.

---

## 5. Every path that hands a seat over

Enumerated, not just the one the walk hits. `local -> ai` is the only direction that can
strand a frame, because only a `"local"` seat ever has one stamped for it (§4).

| path | direction | stale frame possible? | covered by the fix? | relay needs anything? |
|---|---|---|---|---|
| **Seat released to the AI mid-match** — `viewmodels.js:571` → `game_session.js:168` → `room.release()` (`room.js:262-266`) → `set_driver(seat,"ai")`, relay stamps at `room.tick + 2d` | `local -> ai` | **yes**, `d` frames | yes — routes 1/2/3 all consumed through `step` | no |
| **Client leaves / socket closes** — `vacate`, then `substitute`'s `AI_AFTER` counter stamps `"ai"` (`server/index.js:777-779`) | `local -> ai` | **yes** — the departing client's last frames are still in the ring and may still be in flight | yes | no |
| **Host migration** — `ensure_host` (`server/index.js:~629`) | none | n/a — host role, not a driver value; `grep -n "stamp_driver" server/index.js` shows `ensure_host` does not call it | n/a | no |
| **Take-seat (#42)** — `claim_seat` (`server/index.js:504-506`) and `resume`'s re-grant (`server/index.js:886-888`) | `ai -> local` | **no** — an `"ai"` seat has nobody stamping for it, so `input_at[T]` is empty at the changeover; every client falls through to the `RELEASED` floor for the `d` ticks until the new holder's first frame lands, identically | n/a, and correct today | no |
| **AI-fill at match start** — `begin` (`server/index.js:1091-1093`) | starts `"ai"` | **no** — tick 0, nothing stamped yet | n/a | no |
| **Disabled seat (`"off"`, AI-fill off)** | starts `"off"` | **no** | the new branch deletes nothing (no entry); `test/replay.test.mjs:573-578` pins `Object.keys(...)` = `["0"]` and stays green | no |
| **Resume / repair replay** — `room.js:119-126` schedules `msg.inputs` and stamps `msg.changes`, `catch_up` (`room.js:215-219`) steps the gap | replays any of the above | **yes — this is the permanent one** | yes: `catch_up` calls the same `step`, the changes are applied on their own ticks, the guard uses the same per-tick table every live client used | no |

**Does the relay's `substitute` need the same treatment?** No. It already has it:
`server/index.js:749` `if (drivers[seat] !== "local") continue;`, over a per-tick table from
`drivers_at`. The relay was never the disagreeing party.

**Should the relay also stop *forwarding* and *ringing* stale frames** (`:1240`, `:1243`)?
No — and this is the deliberate refusal. Adding a driver test there would put the same rule
in two places with two different tick models (`room.due`/`drivers_at` on the relay, the
applied table on the client) and re-create exactly the disagreement this issue is about. The
client guard makes every client discard identically whether or not the fan-out reached it,
which is strictly stronger than a relay filter: it also covers the sender, whom the relay
never echoes to (`broadcast_frame(..., client)` excludes it, `room.js:290-291` comment).

This also retires the filed report's own open question — *"whether the input ring should be
pruned of frames the relay itself would not ring — worth its own issue if the guard above
turns out not to cover a replay"*. It does cover the replay. **Do not file that issue.**

---

## 6. The test

**Headless. In `test/replay.test.mjs`. A browser walk is not needed and must not be used.**

Why headless works here, in terms of the code: the whole bug is one boolean —
`frames[seat]` present or absent at one tick — and every input `Room` needs to produce it is
a plain object delivered to `transport.receive`'s listener. `Room` imports nothing from
`src/interaction/`, touches no DOM and reads no clock. The file already has four transports
that hand `Room` a synthetic `start` (`:207-219`, `:248-256`, `:337-345`, `:431-446`) and one
that drives a whole `Game` from one (`:551-568`). Nothing about a handover needs a second
page, a socket or a relay process: a `start` payload carrying `changes` and `inputs` *is* the
relay, reduced to its output.

### 6.1 The case

Place it immediately after the existing `late` block (`test/replay.test.mjs:424-454`,
grep anchor `"a seat the room handed the AI seven ticks ago is the AI's here too"`) — same
subject, and it reads as that block's missing half: `late` covers a seat this client does
**not** hold, this covers one it does, plus the ring.

One transport, one `start`, three seats exercised at once:

- `d: 2` — the bug needs `d >= 1`; the loopback's `d = 0`
  (`loopback_transport.js:14`) schedules and consumes in the same `step`, which is why
  `test/replay.test.mjs:191-199`'s existing `set_driver(2, "ai")` case never saw this.
- `held: [0, 1]`, `drivers: ["local", "local", "local", "ai"]`.
- `changes: [{ t: 2, seat: 1, driver: "ai" }, { t: 2, seat: 2, driver: "ai" }]` — the
  handover, landing on tick 2.
- `inputs: [{ t: 2, seats: { 2: { left: true, right: false, up: false } } }]` — the relay
  ring's stale frame for a seat this client never held (route 3, the repair path).

Drive: `room.step()` three times.

- tick 0 — table `local,local,local,ai`; own frames for seats 0 and 1 scheduled at `t = 2`.
- tick 1 — own frames scheduled at `t = 3`.
- tick 2 — `changes` land, table becomes `local,ai,ai,ai`; `input_at[2]` holds seat 0's own
  frame, seat 1's **stale own** frame (route 1) and seat 2's **stale ring** frame (route 3).

Assert on the third return value:

```js
assert.deepEqual(
    Object.keys(third),
    ["0"],
    "a seat handed to the AI keeps no frame, whoever stamped it -- this client d ticks ago, or the relay's ring (#110)",
);
```

`Object.keys`, not two `!== undefined` checks: it pins **both** sides of the reconciliation
in one assertion (see §6.2).

Then the simulation-level half of AC1, via the file's existing `start()` helper and the same
transport object, placed at the **end** of the file with the other `start()`-based cases —
the file's own rule, `test/replay.test.mjs:549`: *"Last, because building a `Game` replaces
the `player` array."* Three `game.step()` calls, then:

```js
assert.deepEqual(
    player.map((p) => p.ai),
    [false, true, true, true],
    "and the AI steers it on this client too, which is what every other client is doing (#110)",
);
```

### 6.2 Mutations that must turn these specific assertions red

Run each, confirm red, revert. "Fails first" is not enough — each assertion is
mutation-tested on its own.

| # | mutation | assertion that must go red | what it proves |
|---|---|---|---|
| M1 | revert the fix: restore `if (driver !== "local" \|\| frames[seat]) return;` | `Object.keys(third)` → `["0","1","2"]` | the assertion sees the bug at all |
| M2 | delete unconditionally: `return void delete frames[seat];` as the first statement of the `forEach` | `Object.keys(third)` → `[]` | a fix that throws the baby out is caught; also proves the `["0"]` is not vacuous |
| M3 | drop only the ring route: guard the delete with `if (held.indexOf(seat) >= 0)` | `Object.keys(third)` → `["0","2"]` | the repair/replay path is really covered, not just the sender's own tail |
| M4 | drop only the own route: guard with `if (held.indexOf(seat) < 0)` | `Object.keys(third)` → `["0","1"]` | ditto, other way |
| M5 | move the delete behind `if (!catching_up)` and run the assertion through `room.catch_up` | `Object.keys` grows | the guard runs on the replay path |
| M6 | revert the fix | `player.map(p => p.ai)` → `[false,false,false,true]` | the `Game`-level assertion is not a restatement of a table lookup |

M1 and M6 are the same mutation read by two assertions; both are required, because M6 is the
only one that proves the frame-set fact reaches the simulation.

### 6.3 What this test deliberately does **not** do

The filed AC2 asks for *"a client that never got one"* — i.e. two clients compared by state.
This plan asserts the frame set plus `player[i].ai` on one client instead, and that is a
deliberate reduction, argued rather than skipped:

- `game_iteration` is a pure function of `(frames, prior state)`; the two hypothetical
  clients share seed, level and prior state by construction, so their *only* possible
  difference is `frames`. Asserting `frames` asserts the difference directly, one layer
  closer to the bug than a checksum would be.
- The link from `frames` to state is **already pinned** by an existing assertion —
  `test/replay.test.mjs:156-178`'s `drive_right` asserts `ai` tracks frame presence both
  ways — and is re-pinned by M6 here.
- A second-client harness (a second `Room`, a second `Game`, a fan-out transport between
  them, a `checksum` call) is ~40 lines that can only fail when one of the two assertions
  above already fails. Net new signal: zero.

Say so in the issue when closing it, so the AC is seen to be answered rather than dropped.

---

## 7. Success condition

The bar is not "the desync stops". It is **"#96's post-repair assertion passes on unmodified
runs"**, and a single green run proves nothing at the measured base rates.

### 7.1 Before touching anything — reproduce it red on *this* tree

The 3/6 rate was measured at `f7c84fa`. This stack's HEAD is `96422cd`. Re-measure first, or
a green run after the fix proves nothing about what the fix did.

```
npm run build
for i in 1 2 3 4 5 6; do
  node --no-warnings test/browser.test.mjs 2>&1 | grep -E "room .* desync [0-9]+ at tick ([0-9]{3,})" \
    && echo "RUN $i: REPRODUCED" || echo "RUN $i: clean"
done
```

The tick filter is deliberate: `test/browser.test.mjs:989` makes a fake host send
`{type:"checksum", h:1}` on purpose, and that always logs `desync 1 at tick 30`. Only a
three-digit tick (≥ 150) in the `two_pages` room is this bug. Expect roughly 3 of 6. If 0 of
6, **stop and re-derive** — something about this tree differs from the tree the evidence was
taken on.

### 7.2 After the fix — three gates, in order

**Gate 1 — determinism.** §4's `diff` is empty, and `npm test` is green (which runs
`replay.test.mjs`, `relay.test.mjs`, `router.test.mjs`, `browser.test.mjs` —
`package.json:22`).

**Gate 2 — the unmodified suite stops logging it.** 10 consecutive runs of the command in
§7.1, **0** hits. Base rate 0.5 per run ⇒ `P(10 greens | unfixed) = 0.5^10 ≈ 1e-3`.
Ten runs is the number, not five.

**Gate 3 — #96 goes green on unmodified code.** Apply #96's diff on top of the fix —
the working-tree diff at `.claude/worktrees/96` (`git -C <that worktree> diff > /tmp/96.patch`;
**read it, do not edit that worktree**), apply to a scratch copy of this branch, rebuild,
then:

```
for i in $(seq 1 10); do
  node --no-warnings test/browser.test.mjs > /tmp/110-run-$i.log 2>&1 \
    && echo "RUN $i: PASS" || echo "RUN $i: FAIL"
  grep -E "room .* desync [0-9]+ at tick ([0-9]{3,})" /tmp/110-run-$i.log
done
```

Both conditions, both over 10 runs:

- every run exits 0 — in particular the assertion
  `"a client resumed from the host's snapshot hashes to the host's, tick for tick (#40)"`;
- **and** no run logs a three-digit-tick desync, even when it passes. The relay
  under-reports (one pending hash per client, `server/index.js:857-863`; silence before the
  host's first snapshot, `:889`; a repair cooldown, `:983-986`) and #96 samples only three
  ticks per window, so a passing run with a desync line is a near-miss, not a pass.

`P(10 green | unfixed)` at #96's measured 4/5 failure rate is `0.2^10 ≈ 1e-7`.

Report all 30 runs' outcomes in the PR body. Do not report a median or a "usually".

---

## 8. Scope and risk

### 8.1 Not fixed, on purpose

- **The relay's fan-out and ring (`server/index.js:1240`, `:1243`) keep forwarding and
  recording frames for a seat the table has handed over.** Reasoned in §5. A second filter
  is a second source of truth.
- **The ring is not pruned** of frames the relay would not ring. The guard covers the
  replay; the filed report's conditional follow-up issue does not get filed.
- **`stamp_driver`'s late-apply branch** (`room.js:179-183`) still converges the table
  without converging the state behind it. Pre-existing, already carrying its own `ponytail:`
  note and its own upgrade path (the resync payload). Untouched.
- **The checksum (#41) and the level hash (#95).** Measured correct here — both pages
  hashed the level to `-1236555343` in every run.
- **The repair budget, cooldown and one-deep pending hash** (`server/index.js:851-917`).
  They under-report this; they do not cause it.
- **`player[i].ai = !frame` stays.** After the fix it is exact, because `Room` now
  guarantees the frame set matches the table. Changing it too would be the second fix for
  one bug.

### 8.2 The single biggest risk

**This is the first code in `Room.step` that removes input rather than adding a floor.** The
guard is only as right as the driver table it trusts. One path can make two clients' tables
disagree at a tick: `room.js:181` `if (t < tick) drivers[change.seat] = change.driver;` — a
change for a tick already stepped is applied immediately instead of at its tick. A client
that took the change late now applies it to **all** of its remaining ticks, so from that
moment it suppresses frames for the seat while a client that has not yet reached the change
tick still delivers them.

Three things keep it acceptable, and the implementer should be able to say all three:

1. The lag is pre-existing and already divergent — that window is exactly what the
   `ponytail:` note at `room.js:174-178` describes, and the state the two clients build over
   it already differs today.
2. Without the fix, the lagging client is the one that *keeps* driving a bunny the whole room
   has handed over — strictly further from the room's answer. With the fix it converges on
   what every on-time client does.
3. The relay stamps every change at `room.tick + 2d` (`server/index.js:676`), which is past
   any client's current tick by construction; `t < tick` requires the change to arrive late
   *and* the receiving client to be more than `2d` ahead of the relay's idea of the room.
   Gate 2's ten runs exercise the live wire.

Secondary risks, each with its detection:

- **A client mid-match when the fix ships, in a room where the relay and other clients run
  the old code.** No wire format changes, no message changes, no payload changes — a
  fixed client simply discards a frame an old client still uses, which is the
  already-existing per-client race narrowed rather than widened. Gate 3 covers the
  mixed-timing case; a genuinely mixed-version room is a deploy question, and the
  GitHub Pages deploy replaces every client at once (`.github/workflows/deploy-to-gh-pages.yml`).
- **A bunny that visibly freezes instead of being AI-steered.** Would mean the table said
  `"ai"` where a human was still holding the seat. Gate 2's runs are visual-free, so watch
  for it in the manual pass of step 7 below.
- **A `drivers` table shorter than `SEATS`** leaves a frame in place (§3, known gap).
  No production path produces one.

---

## 9. Acceptance criteria → where each is met

| AC (from the filed issue) | met by |
|---|---|
| A seat whose driver is not `"local"` on a tick is AI-steered on every client for that tick, whatever frames any of them hold | §3's guard; §6.1's `Object.keys(third) === ["0"]` and `player.map(p => p.ai) === [false,true,true,true]`; mutations M1–M6 |
| A headless test in `test/replay.test.mjs` … fails before the fix | §6.1, placed after `replay.test.mjs:454`; M1/M6 prove it fails before. §6.3 states and argues the one reduction from the AC's wording |
| The two-page walk stops logging a relay desync in `two_pages` over 10 consecutive runs | §7.2 Gate 2, with the ≥150-tick filter that excludes `browser.test.mjs:989`'s deliberate one |
| #96's post-repair assertion goes green on unmodified code | §7.2 Gate 3, 10 runs, pass **and** no desync line |
| (implicit, this chain's rule) the replay checksum is unchanged | §4, old-vs-new `diff`, plus the argument that no writer of `frames[seat]` can produce a non-`"local"` entry without a handover |

---

## 10. Steps

1. Branch off `90-keyboard-screen-reader` at its rebased HEAD. **Do not edit the `90` or
   `96` worktrees** — another agent is reviewing `90`, and `96` holds uncommitted work.
   `git -C .claude/worktrees/96 diff > /tmp/96.patch` is a read; nothing else touches it.
2. §7.1 — reproduce red, 6 runs. Record the count.
3. §4 — build `/tmp/110-checksums.mjs`, capture `/tmp/110-before.txt`. **Before** the edit.
4. §3 — the one line in `src/net/room.js`. Nothing else in `src/`, nothing in `server/`.
5. §4 — capture `/tmp/110-after.txt`, `diff`. Empty, or stop.
6. §6.1 — the two assertions in `test/replay.test.mjs`. `npm test`.
7. §6.2 — M1 through M6, one at a time, each confirmed red then reverted. `npm test` green
   after the last revert.
8. `npx prettier --check .` (the repo has a `format:check` script and a `core.hooksPath`
   hook, `package.json:23-25`).
9. `npm run build`, open `game/index.html`, play one local match and one two-tab match,
   release a seat and watch the bunny: it must be AI-steered, not frozen. Rendering, sound
   and input have no automated check in this repo — this pass is the check.
10. §7.2 Gates 2 and 3 — 10 runs each. All 20 outcomes into the PR body, plus the 6 from
    step 2 as the before-measurement.
11. `rm /tmp/110-checksums.mjs`. Commit: one production line, one test block, no other file.

---

## 11. What a review of this plan should reject

- Any `Room` API addition. There is none here and none is needed.
- Any relay change. §5's table says why each relay path is already correct.
- Any change to `src/game/game.js`. §2 says why it is the symptom.
- A second test in `test/browser.test.mjs`. §6's opening says why the case is headless.
- Fewer than 10 runs at either gate. §7.2 gives the arithmetic.
- Updating an FNV-1a checksum instead of explaining why it moved. §4.
