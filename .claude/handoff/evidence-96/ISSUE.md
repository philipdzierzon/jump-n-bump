# A seat handed to the AI keeps its last human frames on the client that sent them, and the two simulations part for good

**state:** proposed  **labels:** bug, ready-for-agent

> Verified independently of the finding that surfaced it. Nothing was fixed; nothing was committed.

## Parent

#81 §10 — the loop/relay/flow audit. Surfaced while building #96's tick-by-tick assertion, which is
what makes it visible; #96 already puts "fixing the desyncs this makes visible" out of its own scope.

## What the code does today

A tick's frames and the room's driver table are two separate sources of truth about one question —
who is steering a seat — and nothing reconciles them.

`src/game/game.js:64-73` — the simulation decides the AI steers a bunny **purely from whether a
frame exists** for that seat this tick:

```js
function update_player_actions() {
    var frames = room.step();
    for (var i = 0; i != player.length; ++i) {
        var frame = frames[i];
        player[i].ai = !frame;          // <- frame presence, not the driver table
```

and `src/game/ai.js:31-34` steers exactly the seats with `player[i].ai` set.

`src/net/room.js:291` — every tick, a client writes its **own** frame into its own schedule, `d`
ticks ahead, and sends the same frame to the relay:

```js
schedule_input(tick + self.d, seats);
transport.send({ type: "input", t: tick + self.d, seats: seats });
```

`src/net/room.js:302-323` — when that tick comes round, `step()` reads `input_at[tick]` and then
only ever **adds** released frames, for seats whose driver is `"local"`. It never removes a frame
for a seat the room has since handed to the AI:

```js
var frames = input_at[tick] || {};
...
drivers.forEach(function (driver, seat) {
    if (driver !== "local" || frames[seat]) return;
    frames[seat] = RELEASED;
```

So a client that held a seat at tick `T-d` has a frame sitting in `input_at[T]` even if the room
hands that seat to the AI at `T`. The relay, meanwhile, agrees with the driver table: it refuses to
ring a substitute for a seat that is not `"local"` on that tick (`server/index.js:703-709`,
`driver_at`), and it drops a frame that misses its deadline outright (`server/index.js:1112`,
`if (msg.t < room.due) return void room.late++`).

The result: for the `d` ticks that follow every `local -> ai` handover, the sender of those frames
runs the seat on released keys while every client that did not get the frame runs it on the AI.
The two bunnies move differently from that tick on. `room.js:304-313`'s claim that a missing frame
"cannot manufacture a divergence" holds only while the driver table says `"local"`.

## The symptom, measured

Two pages in one room, the guest walks back to the lobby and takes its seat again (#42). Tick 233,
probed inside both pages at `room.step()` — `-` is a frame, `A` is the AI, then the client's own
driver table (`verify/st-run-1.log`):

```
host   233 -AAA  local,ai,ai,ai     <- no frame for seat 1: the AI steers it
guest  233 --AA  local,ai,ai,ai     <- same table, but its own frame is still there
```

The driver tables are identical. The frame is not. The guest scheduled that frame at its tick 231
(`231 --AA local,local,ai,ai`, `d=2`), while the seat was still its own; the `{t:233, seat:1,
driver:"ai"}` change lands on tick 233 on both clients, and only the host is left with nothing to
read.

Seven ticks later the packed states differ. A second failing run, diverging at the same tick 233,
with its tick-240 snapshots dumped from both pages and byte-diffed (`verify/packdiff-tick240.txt`):

```
tick 240   host hash 1293850804   guest hash 808020089
DIFF [1]  rnd.state:          host=1303184589  guest=-1629195420
DIFF [36] player[1].x.pos:    host=13570048    guest=13631488
DIFF [37] player[1].x.velocity: host=-12288    guest=0
DIFF [38] player[1].y.pos:    host=-1080512    guest=500736
DIFF [65] player[3].action_left:  host=1  guest=0     <- the AI bunny reacting to it
DIFF [78] player[3].x.pos:    host=11083776    guest=11098112
```

In another failing run the same diff runs to 41 ints, including two object slots the host had used
and the guest had not (`object[8].used host=1 guest=0`) and the RNG state that the gore in them
drew from.

**It is a simulation divergence, not a checksum one.** The two pages' `level_hash` (#95) measured
equal in every run (`-1236555343` both), the two hashes are sent for the same tick and the tick is
inside the hashed bytes (`src/game/snapshot.js:63`), and the bytes themselves differ in player
position, velocity, animation and the RNG state. Fixing the hash would hide it.

**It is permanent, not a blip.** With #96's deliberate hash lie switched off, one run disagreed at
ticks **180, 210 and 240** — three consecutive samples, and the relay's repair at 180 did not cure
it. The repair payload for that run carries ring entries for the handover ticks 159 and 160
themselves (`verify/nolie-run-4.log`, the `start` at `#28`), so a replay from it plausibly re-reads
the very frame the divergence is made of — not measured per seat, and worth confirming before
relying on it. Runs that appear to recover do so only because a repair happens to land before the
next 30-tick sample.

## It is pre-existing, and the relay already says so

The **unmodified** suite at `f7c84fa`, with no new assertion and no fault injection, logs the relay's
own detection in the two-page room:

```
room DDJRF desync 1 at tick 150, repair 1 of 5
```

3 of 6 clean runs. (A floor, not a rate: the relay holds one pending hash per client
(`server/index.js:857-863`), stays silent until the host's first snapshot exists
(`server/index.js:889`), and will not log twice inside the repair cooldown — it misses more than it
catches.) The tick number is not meaningful: it is the first 30-tick boundary after the take-seat,
and the take-seat happens later in the walk once #96's waits are added, which is why the same bug
reads as tick 150 on the untouched suite and tick 240 with the new assertions.

The other `desync 1 at tick 30` line in every run is deliberate: `test/browser.test.mjs:989` has a
fake host send `{type:"checksum", h:1}` on purpose.

## Reproduction rate

| what was run | failures |
| --- | --- |
| unmodified suite, relay log only (`node test/browser.test.mjs`) | **3 / 6** |
| #96's branch as written (lie at tick 120, assert after the take-seat) | **4 / 5**, always tick 240 |
| #96's branch with the lie disabled | **2 / 5**, at tick 180 and at [180, 210, 240] |

The lie is not the cause — it only moves the clock. What the lie does is burn the relay's first
repair, so the real divergence is the one that goes unrepaired long enough to be sampled.

## Smallest repro

1. `npm run build`, then `node --no-warnings test/browser.test.mjs` on unmodified `master`.
2. `grep desync` the output. A line naming the fifth room created (`two_pages`, `room_e`) at a tick
   of 150 or higher is this bug. Three runs are usually enough.

To see the mechanism rather than the effect, two probes are enough, both in the built bundle
(`game/jump-n-bump.js`, which is unminified) — no production change:

- in `Room`, expose the table: `this.probe = function () { return drivers.join(","); };`
- in `update_player_actions`, record per tick:
  `(window.__steps = window.__steps || []).push((room.now() - 1) + " " +
   [0,1,2,3].map(function (i) { return frames[i] ? "-" : "A"; }).join("") + " " + room.probe());`

then read `window.__steps` off both pages and diff the ticks around the `driver ... "ai"` change.
The first differing tick is the handover tick.

## What would fix it

One reconciliation, in the one place both facts are in hand — `Room.step`, after
`drivers_at[tick]` is applied (`src/net/room.js:278-281`) and before the released-frame floor: drop
`frames[seat]` for every seat whose driver is not `"local"` on this tick. Frame presence and the
driver table then agree on every client, the relay's ring can no longer poison a replay, and
`game.js:68` keeps meaning what it says.

Not the only shape it could take — `player[i].ai` could read the driver table directly instead —
but the guard in `Room.step` is the smaller diff and covers the relay's ring as well as the
sender's own schedule.

## Acceptance criteria

- [ ] A seat whose driver is not `"local"` on a tick is AI-steered on **every** client for that
      tick, whatever frames any of them are holding for it
- [ ] A headless test in `test/replay.test.mjs` hands a client a frame for a tick on which the seat
      has gone to the AI and asserts its state still matches a client that never got one — it fails
      before the fix
- [ ] The two-page walk stops logging a relay desync in the `two_pages` room over 10 consecutive
      runs
- [ ] #96's post-repair assertion goes green on unmodified code

## Out of scope

- The checksum itself (#41) and the level hash chained in front of it (#95) — both measured correct
  here
- The relay's repair budget, cooldown and one-deep pending hash (`server/index.js:851-917`): they
  under-report this, they do not cause it
- Whether the input ring should be pruned of frames the relay itself would not ring — worth its own
  issue if the guard above turns out not to cover a replay

## Blocked by / relates to

Blocked by: none.
Relates to: #81 (parent audit), #42 (the take-seat path this fires on), #40 (the resume path whose
replay cannot cure it), #41 (the checksum that detects it), #7 (seat handover), #6 (a missing frame
is released keys), #96 (the assertion that surfaced it, and which stays red until this is fixed).
