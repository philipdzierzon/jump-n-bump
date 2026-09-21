# #86 — Input is level-sampled across a catch-up batch

Plan against `master` @ `af04c21`, assuming **#85** (`Keyboard.release_all`, blur/visibility flush)
and **#83** (bounded `pump` batch) have landed underneath.

Total diff: **~10 lines in one source file** (`src/game/keyboard.js`) and **~45 lines of test**
in `test/replay.test.mjs`. No change to `src/net/room.js`, `src/game/game.js` or
`src/interaction/game_session.js` beyond one line merged into #85's `release_all`.

---

## 1. What the code does today

### The read path, end to end

`src/game/keyboard.js:14` holds the only input state there is:

```js
var keys_pressed = {};            // keyCode -> bool, mutated by DOM events
```

`src/game/keyboard.js:19-27` reads it live, with no history and no latch:

```js
this.input_frame = function (scheme) {
    var keys = CONTROL_SCHEMES[scheme];
    if (!keys) return null;
    return {
        left:  !!keys_pressed[keys[0]],
        right: !!keys_pressed[keys[1]],
        up:    !!keys_pressed[keys[2]],
    };
};
```

`onKeyDown` (`:29-31`) sets `true`, `onKeyUp` (`:33-37`) sets `false` and fires the `M`/`P`
action bound in `key_function_mappings`. The map is mutated only from the two bare document
handlers in `src/interaction/game_session.js:452-457` (`is_typing` guard), plus — after #85 —
`release_all` from `window.onblur` / `document.onvisibilitychange`.

`src/interaction/game_session.js:75-80` is the room's `read_input`:

```js
var room = new Room(transport, function (nth) {
    return keyboard.input_frame(config.schemes()[nth]);
});
```

`src/net/room.js:248-297`, `Room.step()`, is the one consumer:

```js
if (!catching_up) {                                            // :254
    var seats = {};
    held.forEach(function (seat, scheme) {
        if (drivers[seat] === "local") seats[seat] = read_input(scheme);   // :257
    });
    schedule_input(tick + self.d, seats);                      // :262
    transport.send({ type: "input", t: tick + self.d, seats: seats });     // :263
    ...
}
var frames = input_at[tick] || {};                             // :273
```

So a sample taken on tick `T` is **stamped for and consumed at tick `T + d`** — `d = 0` on the
loopback, `d = 2` on the relay. Missing frames become `RELEASED` at `:285-294`.

`src/game/game.js:58-70` turns the delivered frame into the three action flags:

```js
function update_player_actions() {
    var frames = room.step();
    for (var i = 0; i != player.length; ++i) {
        var frame = frames[i];
        player[i].ai = !frame;
        if (!frame) continue;
        player[i].action_left  = frame.left;
        player[i].action_right = frame.right;
        player[i].action_up    = frame.up;
    }
}
```

### Exactly which ticks sample input — the issue's framing is imprecise, correct it

There are **three** kinds of multi-tick run in this codebase, and only two of them sample:

| Run | Driver | Samples input? | Stamps a frame? |
| --- | --- | --- | --- |
| Ordinary paced tick | `pump`, one tick per `setTimeout` wakeup | **yes**, once | yes |
| `pump` overrun batch — `time_diff <= 0`, loop `continue`s (`game.js:132-157`) | wall-clock debt this client owes | **yes, once per tick, all from the same frozen snapshot** | yes |
| `pump` gap sprint — `room.gap() > 0` (`game.js:141-144`) | ticks the *room* has already played | **yes, once per tick, all from the same frozen snapshot** | yes |
| `Room.catch_up(step)` — resume replay (`room.js:186-190`, called from `game_session.js:287`) | `catching_up = true` | **no** | no — those ticks use the relay's ring |

So: **the resume replay is not affected at all.** The issue's phrase "one synchronous catch-up
batch" means the `pump` batch (both its branches), not `Room.catch_up`. That is worth saying in
the PR body, because `catching_up` is the name a reader will reach for first.

Why the snapshot is frozen for a whole batch: JS is single-threaded. `pump`'s `while` loop is
synchronous; no `keydown`/`keyup` can be delivered in the middle of it. So N ticks of one batch
read byte-identical `keys_pressed`. **This is the definition of a batch, and it is what makes the
headless test in §4 faithful: N synchronous `room.step()` calls with no key event between them
*is* a catch-up batch.**

### What actually goes wrong, precisely

Two distinct faults, not one:

**(a) The tap vanishes.** A `keydown` + `keyup` pair that both land between two wakeups leaves
`keys_pressed[k] === false`. Every tick of the next batch reads `false`. The jump never happened.
This is true even at 60 Hz with no stutter at all — a 12 ms tap between two frames is simply
dropped today.

**(b) The hold is misattributed.** The batch's N ticks stand for the wall clock that elapsed since
the last wakeup, but they all read the keyboard *as it is at the end of that interval*. Press
`right` 10 ms before a wakeup that owes 60 ticks and you get 60 ticks — one second — of running.
That is the "lurch".

Note what (b) is **not**: it is not `N > wall clock`. In the overrun batch, N ticks are owed
*because* N/60 s elapsed, so held-ticks equals elapsed-ticks exactly. See §2 for why that matters
to AC2, and §5 for the one case where it genuinely is exceeded.

### What #83 changes about the size of the problem

#83 bounds a batch by wall clock (`BATCH_MS = 1000 / 60`) as well as by the frame budget, and
applies the bound to the gap-sprint branch too. Consequences for #86:

- One frozen snapshot can no longer drive an **unbounded** run of ticks. Before #83 a client
  600 ticks behind sprinted all 600 off one snapshot (10 s of movement from one instant);
  after #83 it sprints at most one batch's worth, yields, the event loop delivers the pending
  key events, and the next batch reads a fresh snapshot.
- The bound is on *CPU time*, not tick count. A tick costs well under a millisecond on a healthy
  client, so a 16.67 ms batch can still be **tens to hundreds of ticks**. #83 shrinks the blast
  radius; it does not remove it.
- #83 does not touch fault (a) at all. A tap between two wakeups is dropped identically before
  and after #83.

So #86 is still worth building after #83, and the honest claim is "bounded, not fixed".

### Honesty about evidence

The issue says "Confirmed by reading; not measured", and that is all this plan can claim too.
Fault (a) is a straight read of `:19-27` — `keys_pressed[k]` is `false` after the keyup and
nothing else records that it was ever `true`. Fault (b) is a read of the loop. Neither was
reproduced at runtime, and the *player-visible* magnitude (how often a real stutter is long
enough to matter) is unmeasured. The headless test in §4 proves the delivered per-tick inputs
and nothing about frequency in the wild.

---

## 2. The design

### The mechanism: a per-key "went down since this scheme last handed a frame to a tick" latch

One extra map in `Keyboard`, OR-ed into the frame, cleared **per scheme** by the read.

That is the whole mechanism. It is rung 6 on the ladder — a handful of lines in the one file that
already owns the pressed-keys map — and it is deliberately **not** a per-tick queue of frames.
A queue does not buy anything the latch does not: see §6.

### Why AC1 and AC2 are one mechanism plus one argument, not two mechanisms

- **AC1 (tap reaches exactly one tick)** is the latch. `tapped[k]` is set on keydown and survives
  the keyup; the first read after it delivers one tick of `true`; the read clears it, so tick 2 of
  the batch reads `keys_pressed[k] === false`. Exactly one tick, by construction.

- **AC2 (a hold is not multiplied beyond wall clock)** needs **no code** for the batch the issue
  names, and the hint in the brief is the reason: **at a fixed 60 Hz, tick count *is* the measure
  of elapsed wall clock.** The overrun batch runs N ticks precisely because N/60 s of wall clock
  went unpaid. Delivering a held key on all N is delivering it for N/60 s of real time — equal to
  the clock, never more. The latch does not disturb that: a key that is genuinely held reads
  `true` from `keys_pressed` on every tick of the batch, exactly as today.

  The one run where ticks are *not* this client's elapsed wall clock is the `pump` gap sprint —
  those ticks are the room's history. That residue is flagged in §5 and **deliberately not built**,
  with a concrete reason (`gap() > 0` fires on one tick of ordinary jitter and is not a safe
  discriminator — see §5).

So: one latch, plus a written argument that carries AC2 for the batch and names what it does not
carry.

### Why it lives in `src/game/keyboard.js`, and how it stays clock-free and DOM-free

- `tapped` is a plain object keyed by `evt.keyCode`. It reads **no clock** — no `Date.now()`, no
  `performance.now()`, no `evt.timeStamp` — and touches **no DOM**: like `keys_pressed`, it is
  written from the two handlers that already accept a duck-typed `{ keyCode }`.
  `test/replay.test.mjs:91` builds `new Keyboard([])` under node and drives it with bare objects;
  that keeps working untouched.
- Clearing is driven by **the read**, i.e. by a tick, not by a timer. `Room.step()` is the sole
  caller of `read_input` (`room.js:257`), so "cleared on read" means "cleared once per tick per
  local seat" on every transport.
- Putting the latch any higher (in `Room`, or in `game_session.js`'s `read_input` closure) would
  split input state across two layers and put a keyboard concern in the net layer. Putting it any
  lower is not possible — `keys_pressed` is already the bottom.

### The one landmine: clear per scheme, not globally

`read_input(scheme)` is called **once per local seat per tick** (`room.js:256-258`). Couch play is
one client holding up to four seats, so a single tick makes up to four `input_frame` calls. A latch
cleared wholesale on any read would be eaten by scheme 0's call and scheme 1's tap would vanish —
a new bug, in the couch path only, invisible to a single-seat networked test.

Clearing only the three keycodes of the scheme being read makes every scheme's latch independent,
and makes the one-seat and four-seat cases identical.

---

## 3. The change, criterion by criterion

### AC1 — a tap between two wakeups reaches exactly one tick

**File** `src/game/keyboard.js`. **Functions** `Keyboard`, `input_frame`, `onKeyDown`, and (from
#85) `release_all`.

```js
export function Keyboard(key_function_mappings) {
    "use strict";
    var keys_pressed = {};
    // A key that went down since this scheme last handed a frame to a tick, whether or not it
    // is still down now. The pump steps a whole catch-up batch synchronously, so no key event
    // can land in the middle of one: a tap that begins and ends between two wakeups leaves the
    // pressed map exactly as it found it and a level sample never sees it at all -- the jump
    // that never happens during a stutter (#86). Not a clock and not a queue: the latch is
    // cleared by the read, and the read is a tick.
    var tapped = {};

    // One input frame, the wire format: 3 bits, unconditionally, whether or not anything
    // changed. Null for a scheme this client does not have -- the one guard, so callers
    // can hand it an unbound seat's index without checking first.
    this.input_frame = function (scheme) {
        var keys = CONTROL_SCHEMES[scheme];
        if (!keys) return null;
        var frame = {
            left: !!(keys_pressed[keys[0]] || tapped[keys[0]]),
            right: !!(keys_pressed[keys[1]] || tapped[keys[1]]),
            up: !!(keys_pressed[keys[2]] || tapped[keys[2]]),
        };
        // Cleared per scheme rather than wholesale: four humans on one keyboard is one client
        // holding four seats, so one tick reads four frames, and a latch the first read wiped
        // would swallow the other three participants' taps (#32).
        // ponytail: a latch, not a count -- two taps of the same key between two wakeups are
        // delivered as one. upgrade path: a per-key pending count, if a player is ever fast
        // enough for it to show.
        keys.forEach(function (key) {
            tapped[key] = false;
        });
        return frame;
    };

    this.onKeyDown = function (evt) {
        keys_pressed[evt.keyCode] = true;
        tapped[evt.keyCode] = true;
    };

    this.onKeyUp = function (evt) {
        keys_pressed[evt.keyCode] = false;
        var action = key_function_mappings[String.fromCharCode(evt.keyCode)];
        if (action != null) action();
    };

    // #85's clearing method, with the latch cleared too: a tap latched just before the tab lost
    // focus must not steer the bunny after it.
    this.release_all = function () {
        keys_pressed = {};
        tapped = {};
    };
}
```

`onKeyUp` is untouched — it must keep firing the `M`/`P` actions, which is the seam #85 was careful
to preserve.

**Merge note for the implementer:** `release_all` is #85's line. Rebase #86 onto #85 and add
`tapped = {};` to the method that is already there; do not re-add the method.

### AC2 — a hold is not multiplied beyond wall clock

**No code.** Carried by the argument in §2 plus the assertion in §4 (`right` delivered on exactly
the batch's ticks and no more). Record the argument in the PR body:

> A batch runs N ticks because N/60 s of wall clock went unpaid. At a fixed 60 Hz the tick counter
> *is* the clock, so N held ticks is N/60 s of holding — equal to elapsed wall clock, never more.
> The residue is the `gap() > 0` sprint, where the ticks are the room's history rather than this
> client's elapsed time; #83 bounds it and §5 says why closing it is a separate issue.

### AC3 — determinism; nothing in the simulation reads a clock or the DOM

**No code.** Two things to state and one to verify:

1. `tapped` reads no clock and no DOM (§2). `src/game/` still imports nothing from
   `src/interaction/`.
2. `test/replay.test.mjs` is **bit-identical** under the change, not merely still-passing. Its
   driver (`replay.test.mjs:110-121`) emits, for each tick and each key, exactly one
   `onKeyDown` **or** one `onKeyUp`, then calls `game.step()`. The frame changes only when
   `keys_pressed[k]` is `false` while `tapped[k]` is `true` — i.e. a down followed by an up with
   no read between — which that loop can never produce. So the FNV-1a checksum is unchanged, and
   `drive_right`, the `local` loopback block, the `delayed_room` block and the `behind`/`repaired`
   blocks all keep their current values.

   **Verify this by running `npm test` before and after** — it is the cheapest possible proof and
   the claim is falsifiable.

### AC4 — a headless test drives a catch-up batch with a tap and a hold

**File** `test/replay.test.mjs`, appended next to the existing bare-`Room` blocks (after the
`delayed_room` block, ~`:212`). See §4 for the code.

### AC5 — local and networked deliver the same per-tick input for the same key timeline

**No code.** The mechanism sits strictly *below* `read_input`, and `Room.step()` calls
`read_input` once per local seat per non-`catching_up` tick regardless of transport
(`room.js:254-258`). Neither `d` nor the transport type is visible to `Keyboard`. The two paths
therefore consume the latch on the same cadence, and the only difference is where the resulting
frame is *stamped*: `tick + d`, which is the input delay and is the design (`room.js:262`).

Stated as a testable claim: **the same key timeline yields the same frame sequence on both paths,
translated by `d`.** A tap latched before tick 0 is delivered at tick 0 on the loopback (`d = 0`)
and at tick 2 through a `d = 2` transport — one tick of `up` either way, in the same position
relative to the rest of that client's stream. §4 asserts exactly that, on both paths.

The way this criterion gets silently broken is the per-scheme clear (§2). The couch case in §4 is
its regression guard.

---

## 4. Tests

**One file: `test/replay.test.mjs`.** It is the home of every headless room block already
(`delayed_room`, `behind_transport`, `repaired_transport`), it runs under node with no DOM, and it
is what AC3 names. Nothing goes in `browser.test.mjs` — #85 already owns the blur walk there, and
a tap inside a batch is not reproducible through Playwright anyway.

**How the batch is driven headlessly:** a catch-up batch *is* N synchronous ticks with no event
loop turn between them. In node that is N back-to-back `room.step()` calls with no key event in
the middle. No fake clock, no `pump`, no `game` — matching the `delayed_room` idiom exactly.

```js
// A tap that begins and ends between two loop wakeups, and a key really held across the same
// batch (#86). The pump steps a batch synchronously, so no key event can land inside one --
// which is exactly N back-to-back steps with no event between them, and needs no clock.
const batch_transport = (d) => ({
    receive(fn) {
        this.to_client = fn;
    },
    send(msg) {
        if (msg.type !== "start") return;
        this.to_client({
            type: "start",
            t: 0,
            d,
            seed: 1,
            settings: {},
            held: [0],
            drivers: ["local", "ai", "ai", "ai"],
        });
    },
});

function batch_frames(d, ticks) {
    const keyboard = new Keyboard([]);
    const room = new Room(batch_transport(d), (scheme) => keyboard.input_frame(scheme));
    room.start({ seed: 1, settings: {}, held: [0] });
    keyboard.onKeyDown({ keyCode: CONTROL_SCHEMES[0][1] }); // right, held across the batch
    keyboard.onKeyDown({ keyCode: CONTROL_SCHEMES[0][2] }); // up, tapped and released inside
    keyboard.onKeyUp({ keyCode: CONTROL_SCHEMES[0][2] }); //   the gap between two wakeups
    return [...Array(ticks)].map(() => room.step()[0]);
}

const batch = batch_frames(0, 4);
assert.deepEqual(
    batch.map((f) => f.up),
    [true, false, false, false],
    "a tap between two wakeups reaches exactly one tick of the batch, rather than none",
);
assert.deepEqual(
    batch.map((f) => f.right),
    [true, true, true, true],
    "and a key really held is delivered once per tick -- one tick is one 60th of the wall clock the batch owes",
);

// The same key timeline through a transport with an input delay: the same one-tick pulse,
// translated by d and nothing else. Local and networked are one code path with two transports
// under it, and the latch is below the room, so it cannot tell them apart (#16, #33).
assert.deepEqual(
    batch_frames(2, 5).map((f) => f.up),
    [false, false, true, false, false],
    "a tap delivers one tick over a delayed transport too, d ticks later -- and d is the design",
);

// Four humans on one keyboard is one client holding four seats, so one tick reads four frames.
// The latch clears per scheme: a tap on scheme 1 must survive scheme 0's read of the same tick
// (#32).
const couch_keyboard = new Keyboard([]);
const couch_room = new Room(
    {
        receive(fn) {
            this.to_client = fn;
        },
        send(msg) {
            if (msg.type !== "start") return;
            this.to_client({
                type: "start",
                t: 0,
                d: 0,
                seed: 1,
                settings: {},
                held: [0, 1],
                drivers: ["local", "local", "ai", "ai"],
            });
        },
    },
    (scheme) => couch_keyboard.input_frame(scheme),
);
couch_room.start({ seed: 1, settings: {}, held: [0, 1] });
[0, 1].forEach((scheme) => {
    couch_keyboard.onKeyDown({ keyCode: CONTROL_SCHEMES[scheme][2] });
    couch_keyboard.onKeyUp({ keyCode: CONTROL_SCHEMES[scheme][2] });
});
const couch = couch_room.step();
assert.deepEqual(
    [couch[0].up, couch[1].up],
    [true, true],
    "one tick reads a frame per held seat, and one seat's read must not eat another's tap",
);
```

Cases covered, and what each would catch if the latch regressed:

| Case | Fails if |
| --- | --- |
| tap → `[true, false, false, false]` | no latch (all `false`), or the latch is not cleared (all `true`) |
| hold → `[true, true, true, true]` | the latch replaced level sampling and a hold became a pulse |
| `d = 2` tap → `[false, false, true, false, false]` | the mechanism is sensitive to `d`, or to the transport (AC5) |
| couch two-seat tap | the latch is cleared wholesale rather than per scheme (AC5, couch half) |

Notes for the implementer: `new Keyboard([])` makes `key_function_mappings["&"]` `undefined`, so
`onKeyUp` on the jump key is a no-op action — the existing blocks rely on the same thing. `d = 0`
means the sample on tick `T` is used on tick `T`; `d = 2` means the first two ticks are `RELEASED`
by `room.js:285-294`, which is why the `d = 2` expectation starts with two `false`.

Run `npm run format` before committing — the pre-commit hook checks the whole tree.

---

## 5. Risks

**Determinism (AC3).** The latch introduces no new state that a snapshot has to carry: it is a
client-local input detail that never reaches the wire. What crosses the wire is still the same
3-bit frame, stamped at `tick + d`, so every client in the room consumes the same bytes.
`pack_snapshot`/`checksum_snapshot` are untouched. Residual risk: near zero, and `npm test`
before/after settles it.

**AC5 parity — the thing most likely to break silently.** Two hazards, both named above:
1. *Wholesale latch clearing* breaks couch play only, because that is the only configuration with
   more than one `read_input` call per tick. Guarded by the couch case in §4.
2. *A latch cleared by anything other than a tick* — e.g. clearing it in `game_session.js`'s
   `read_input` closure, or on a timer — would desynchronise the two paths. The design clears it
   inside `input_frame`, so the clear is a tick by construction.

Not a hazard: the `d` difference. It shifts *where* the pulse is stamped, not *whether* one tick
gets it, and the `d = 2` case asserts that.

**Interaction with #83's bounded batch.** The latch's correctness does not depend on batch length —
it delivers one tick per tap whether the batch is 2 ticks or 200. #83 makes batches shorter and
more frequent, which means the latch is consumed sooner after the tap, which is strictly better.
No coupling to `BATCH_MS`, and no ordering requirement between the two beyond the rebase.

**Interaction with #85.** Same file, adjacent lines. `release_all` gains one line. If #85's blur
flush is expected to be *silent* — the tab lost focus, nothing should move — then clearing `tapped`
is required, or a tap latched microseconds before the blur would still steer the bunny for a tick.
That is the behaviour this plan chooses.

**The residue this plan does not close, and why.** The `pump` gap sprint (`game.js:141-144`) steps
ticks that are the *room's* history, not this client's elapsed wall clock, and it does sample live
input on each of them. A held key there is genuinely multiplied beyond the clock. The obvious
one-line fix — stamp `RELEASED` while `gap() > 0`, mirroring what `Room.catch_up` already does —
**is wrong and must not be attempted**: `gap()` is `target() - tick` and `target()` is
`newest - d`, so in a networked room a peer that is *one tick ahead* makes `gap() === 1`. Gating
input on that would blank a normally-jittery client's own bunny on most ticks. There is no
clock-free way for `Keyboard` to tell a 300-tick genuine hold from a 300-tick sprint, and no
safe existing discriminator in `Room`. That residue belongs with #83/#40/#72, where the loop's own
bound lives. Flagged, not built.

**Fairness, not desync.** Nothing here changes what is stamped or when. The frame this client
sends for `tick + d` is still one frame, still sent every tick, still the same bytes every client
consumes. The latch changes *which* three bits go into that frame — it makes them match the
player's fingers. A client that has this fix and one that does not would disagree only about their
own local input, which is not a shared value. Do not let review drift this into desync territory.

---

## 6. Deliberately not doing

- **A per-tick queue of input frames.** It fixes exactly what the latch fixes and costs a FIFO, a
  drain policy and a tail-hold rule; a queue does not help the sprint either, because it still has
  no idea how much wall clock a tick stands for.
- **Timestamping key events (`evt.timeStamp`, `performance.now()`) to attribute a batch's ticks
  accurately.** This is the only thing that would truly fix the "lurch", and it puts a clock in the
  simulation layer — AC3 forbids it, and `replay.test.mjs:91` drives `Keyboard` with bare
  `{ keyCode }` objects that have no timestamp.
- **Counting taps rather than latching one.** Two taps of the same key between two wakeups deliver
  one. Marked with the `ponytail:` comment in §3.
- **Stamping `RELEASED` during the `gap() > 0` sprint.** Unsafe discriminator; see §5.
- **Any change to `src/net/room.js` or `src/game/game.js`.** Neither is where the fault is; the
  fault is that `keys_pressed` has no memory.
- **A browser test.** #85 owns the blur walk; a tap inside a synchronous batch is not reachable
  from Playwright.
- **Touch input (#45).** Not touched. The latch is keyed on `evt.keyCode` and nothing in this
  change goes near a pointer or touch event.
- **Rebindable keys.** Not touched. `CONTROL_SCHEMES` is unchanged, still four fixed triples, and
  `jump_scheme` (used by `viewmodels.js:1134` and `router.test.mjs:33-39`) is untouched.
