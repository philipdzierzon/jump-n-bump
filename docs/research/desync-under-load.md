# Research: what makes a client fall out of step, and what it costs to put back

Answers [#70](https://github.com/philipdzierzon/jump-n-bump/issues/70). Rests on the detection
built in [#41](https://github.com/philipdzierzon/jump-n-bump/issues/41) (PR #69), which is what
made any of this visible.

---

## The finding in one line

**A CPU-starved client's own frames are late leaving it — essentially every one of them — and the
divergence lands on everybody else, not on it.** Its incoming stream is nearly perfect, its tick
counter keeps up, and it cannot see a thing wrong. Meanwhile the host substitutes all-keys-
released for that client's seat on a third of the match's ticks, while the client itself steers
its bunny with the real input nobody got in time.

Two of the issue's three suspicions are wrong, and the numbers say so plainly:

| Suspicion (#70)                                           | Measured                                                          |
| --------------------------------------------------------- | ----------------------------------------------------------------- |
| Frames reach the socket late under load                   | **Yes. 936 of 955, 98%, median 3 ticks late against a `d` of 2.** |
| A repair is expensive on a client short of CPU            | **No. Under 10 ms, all in, for a 94-tick gap.**                   |
| The substitution is the divergence, and nothing counts it | **Yes, and now something does.**                                  |

---

## How it was measured

`Room` counts four things per match, client-side, and `Game_Session` prints them
(`src/net/room.js`, `src/interaction/game_session.js`):

- **substituted** — every tick a seat somebody drives had no frame and was read as all keys
  released. Not the first `d` ticks, where every seat is substituted by definition, and not a
  replayed gap.
- **arrived / late** — every `input` message, and how many of them named a tick this client had
  already stepped.
- **worst margin** — the fewest ticks of slack any frame landed with. It starts at `d`, the best
  any frame can do, and falls from there, so a clean match reports how close the stream came to
  being late rather than a floor of zero.
- **late by** — every late frame by how many ticks. A single worst case cannot say what a bigger
  `d` would have to cover; this can.

A repair additionally prints its own cost, split into decoding the snapshot, building the object
graph, unpacking the state and replaying the gap. The line says `repair` or `joined`: the same
payload has two triggers (#40), and they are not the same measurement.

The reproduction is two real Chromium pages in one browser, one relay in-process, one page
throttled with CDP `Emulation.setCPUThrottlingRate`. Both pages hold a key down so the simulation
has something to disagree about. The harness was a throwaway, and does not need to exist again:
everything quoted below except §4 comes out of the shipped counters. To repeat it by hand, open
the built page twice against a local relay, throttle one window's CPU 6× in devtools, play, and
read both consoles. A 6× throttle is the setting #41's testing used, and it desyncs inside two
seconds, every time.

Runs below: 45 seconds of play, ~2700 room ticks, `d = 2`, two clients, one seat each.

---

## What the numbers say

### 1. The slow client's frames are late. Nearly all of them.

Host's console, guest throttled 6×:

```
match over at tick 2713: 953 frames substituted, 936 of 955 arrived late,
worst margin -6 ticks (d 2), late by -1:73 -2:143 -3:531 -4:185 -5:2 -6:2
```

98% of the stream. Not a tail, not a burst. How late:

| margin | −1   | −2    | −3        | −4    | −5   | −6   |
| ------ | ---- | ----- | --------- | ----- | ---- | ---- |
| frames | 73   | 143   | **531**   | 185   | 2    | 2    |
| share  | 7.8% | 15.3% | **56.7%** | 19.8% | 0.2% | 0.2% |

Median 3 ticks late, p99 4, worst 6. `d` was 2, so **`d` covered none of it.**

The relay here is in-process: the wire is nothing. The whole delay is the throttled client's own
event loop — `Room.step()` posts its frame from inside `pump()`'s synchronous catch-up batch, and
nothing reaches the socket until the batch ends. The bunched arrivals show the batches directly:
several frames landing on one tick, then a quiet tick.

The same run at **1× is spotless**: `0 frames substituted, 0 of 2705 arrived late, worst margin 1
ticks (d 2), late by nothing` — a whole match, no desync, and the tightest any frame cut it was
one tick of slack out of a possible two. This is a load fault and nothing else.

### 2. The slow client can barely see it.

Guest's console, same run:

```
match over at tick 963: 14 frames substituted, 4 of 968 arrived late,
worst margin -4 ticks (d 2), late by -1:1 -2:1 -3:1 -4:1
```

Four late frames against the host's 936, and twelve of the fourteen substitutions are repair
artifacts (§4). `Room.gap()` stays at zero on exactly the client that is failing, as #41 already
knew — and now the frame counters say the same thing from the other direction. **The divergence is
one-directional: the slow client's picture is right, everybody else's picture of it is a bunny
standing still.**

That is also why a repair cannot help. The relay replaces the slow client's state with the host's,
which is the state where _its own bunny did not move_. It is being corrected towards a picture of
itself that its own input contradicts on the very next tick. Six repairs in 45 seconds, then
dropped.

### 3. A repair is cheap. The expensive-rebuild theory is dead.

Six repairs, on the 6×-throttled machine:

| at tick | gap (ticks) | decode | graph | unpack | catch-up |
| ------- | ----------- | ------ | ----- | ------ | -------- |
| 121     | 0           | 0 ms   | 2 ms  | 0 ms   | 2 ms     |
| 151     | 30          | 0 ms   | 2 ms  | 0 ms   | 2 ms     |
| 275     | 34          | 2 ms   | 0 ms  | 0 ms   | 2 ms     |
| 424     | 63          | 0 ms   | 2 ms  | 0 ms   | 3 ms     |
| 575     | 94          | 0 ms   | 0 ms  | 0 ms   | 4 ms     |
| 723     | 2           | 1 ms   | 0 ms  | 5 ms   | 0 ms     |

Building the whole object graph — `Renderer`, `Objects`, `AI`, `Animation`, `Sound_Player`, `Sfx`,
`Movement`, `Game` — costs **0–2 ms**. Decoding and unpacking cost **0–5 ms**. Replaying 94 ticks
of history costs **4 ms**. The worry that a repair is a burden on the machine least able to pay it
does not survive contact with a stopwatch, and **"replace the state without rebuilding the object
graph" is not worth building**: it would save one or two milliseconds a repair.

### 4. A repair drops `d` ticks of the repaired client's own input.

The twelve substitutions on the repaired client that are not explained by a late frame land in
pairs, two per repair — `d` of them — and they are for **its own seat**. Traced with a temporary
log at the landing tick:

```
LAND tick=121 newest=122 catch_up_to=121 have=121,122 seats=["0","0"]
```

Frames are present for ticks 121 and 122, but only for seat 0, the host's. The client lands at
`newest - d`, which is `d` ticks past the last frame it had stamped for itself before the repair —
and it never stamps those ticks, because `step()` stamps `tick + d`. Its own bunny reads all keys
released for `d` ticks after every repair.

Small, but it is a hole the repair itself digs, on top of whatever it was repairing.

### 5. Send volume and event handling: nothing to see.

One `input` per client per tick, 60/s, unbatched — 2705 frames over 2704 ticks at 1×, with no
lateness at all. Volume is not implicated at two clients; batching would buy nothing and cost a
tick.

The event-handling audit found no leak. `Game_Session` is built lazily by `session()` in
`viewmodels.js` and dropped only through `end_match()`, which calls `stop()` first, and `stop()`
clears all three timers. The direct `document.onkeydown` assignment is load-bearing rather than
sloppy: it is what deposes the outgoing session's keyboard when a new one is built. Worth knowing
that it _only_ works because sessions never overlap.

---

## What this turns into

- **Relay-side substitution ([#42](https://github.com/philipdzierzon/jump-n-bump/issues/42))** is
  the fix, and the measurement backs it without reservation. If the relay stamps the substituted
  frame, every client reads the same input for that tick and the slow client's bunny stutters
  identically everywhere — a lag artifact instead of a desync.
- **[#71](https://github.com/philipdzierzon/jump-n-bump/issues/71): `d` is derived from ping, and
  ping is not what makes a frame late.** `input_delay()` is `ceil(worst_one_way / TICK_MS) + 1`,
  fixed at match start; the observed lateness is the sender's own event loop and has no ping term
  in it at all.
- **[#72](https://github.com/philipdzierzon/jump-n-bump/issues/72): the `d`-tick hole a repair
  digs** in the repaired client's own input. See §4.
- **`pump()`'s uncapped `while`** is where the lateness comes from, which ties the socket's
  behaviour to [#51](https://github.com/philipdzierzon/jump-n-bump/issues/51)'s loop pacing. The
  bunched arrivals are the evidence.
- **Not worth doing:** reusing the object graph across a repair. See §3.

---

## Postscript: the floor is late too ([#71](https://github.com/philipdzierzon/jump-n-bump/issues/71))

**#71's fix is in, and the 6× repro is unchanged: the throttled client still desyncs every
150 ticks and is still dropped after five repairs.** It does what it says — a client that knows
it is behind stamps at the relay's deadline instead of past it, and ~90 frames a match that the
relay used to drop are now accepted for a later tick. It just almost never knows. The floor is
`newest − d + 1`, and `newest` is read off frames that reached this client's event loop — the same
event loop that is three ticks behind, and the same three ticks that made its own frames late.
A client cannot compute a deadline from information that is late by exactly the amount it is
trying to correct for.

### 6. Four runs, two either side, same machine

The harness was rebuilt to the same shape as §"How it was measured": two Chromium contexts, one
relay in-process, `Emulation.setCPUThrottlingRate({rate: 6})` on the guest once both pages reach
`#play`, both holding <kbd>→</kbd>, 45 s, `d = 2`, one seat each. Throwaway again; the numbers are
the shipped counters and the relay's own log.

| run      | first desync | dropped at | relay dropped late | host substituted | guest rebases |
| -------- | ------------ | ---------- | ------------------ | ---------------- | ------------- |
| before 1 | tick 150     | tick 840   | 379                | 404              | —             |
| before 2 | tick 180     | tick 870   | 370                | 399              | —             |
| after 1  | tick 540     | tick 1230  | 269                | 398              | 93            |
| after 2  | tick 150     | tick 810   | 305                | 437              | 94            |

`after 1` looked like a cure and was noise; `after 2` is indistinguishable from either before.
The host's own line is the one that matters, and it says the same thing on both sides:

```
match over at tick 2705: 437 frames substituted, 438 of 943 arrived late,
worst margin -1 ticks (d 2), 0 rebases, shift 0, late by -1:438
```

The guest ends every match at `shift 0` having rebased ~93 times out of ~900 ticks: the floor
climbs above `tick + d` for a tick here and there and then falls back under it, because the
`newest` it is computed from is as stale as the frames it is meant to outrun. In the steady state
this failure mode actually has — the guest's _tick_ keeps up, only its frames leave late — the
floor sits a tick _below_ the natural stamp and the rebase never fires at all. #71's premise that
"the client can compute that number itself" holds only for a client that is behind in ticks. This
one is behind in wall-clock.

### 7. A rebase must never outrun `newest`

Worth recording, because the first implementation followed #71's formula literally and the room
reached tick 62700 in 45 seconds.

`newest − d` is not just an input to the stamp. `pump()` sprints while `room.gap()` is positive,
and `gap()` reads `newest − d` as _the tick the room's fastest client is on_ — an identity that
holds only while every stamp is its sender's own `tick + d`. #71's third term, `last_stamp + 1`,
breaks it: a client stepping a catch-up burst emits one stamp per step, so its stamps outrun its
tick, every other client reads that as a room that has run ahead, and sprints — which ratchets
_its_ stamps, and so on. Two clients drag each other to the end of time in about a minute:

```
match over at tick 62700: 91 frames substituted, 5 of 5080 arrived late,
worst margin -1 ticks (d 2), 43 rebases, shift 3857, late by -1:5
```

43 rebases and a shift of 3857 on the _unthrottled_ host. The fix is to drop the ratchet: stamp
`max(tick + d, newest − d + 1)`, which is never past `newest`, and skip the send for a tick
already stamped rather than stamping a later one. Only the client whose `tick + d` is highest
moves the room's clock on, which is the fastest one, exactly as before.

### What this turns into, still

- **#71 as merged is inert on the case it was filed for.** It is correct and it costs nothing when
  it does not fire — a client genuinely behind in ticks, after a repair or in a background tab,
  stamps where the relay will take it. It is not the cure for a client that cannot make 60 Hz.
- **The sender's own lateness is measurable locally, and nothing measures it.** Its tick against
  the wall clock is the quantity #71 needed and `newest` is not. `Room` is deliberately clock-free,
  so that is a design question rather than a patch.
- **[#51](https://github.com/philipdzierzon/jump-n-bump/issues/51) is now the live candidate** for
  this failure mode, not a parallel one. §"What this turns into" already named `pump()`'s uncapped
  `while` as where the lateness comes from; two runs either side of #71 say nothing else has
  removed it.
