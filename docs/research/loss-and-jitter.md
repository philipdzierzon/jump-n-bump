# Research: what packet loss and jitter do to the input stream

Answers §3 of [#136](https://github.com/philipdzierzon/jump-n-bump/issues/136). It measures
what the two earlier runs in `desync-under-load.md` could not, because both used an in-process
relay: what a real kernel's TCP does to a 60 Hz stream of small frames when the link delays,
jitters and drops packets.

The tool and the raw data are in `loss-calibration/`. `results/full/` holds 24 conditions of
60 s each. `results/tail/` holds three harsh conditions of 600 s each.

---

## The finding in one line

**No lost packet ever took the game down: no data was lost and no seat went to the AI. But
at 50 ms one-way, every lost packet stalls one player's frames for about 8 ticks, while `d`
covers only 1. So 1 % loss replaces about 12 % of that player's frames with released keys,
and 3 % loss replaces about 38 %.**

| Question                                            | Measured                                                                                               |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Does TCP wait for its retransmit timeout (≥ 200 ms)? | **No.** Across ~6 000 retransmits: 4 RTOs, none at 50 ms. Almost all were fast retransmits (SACK/RACK). |
| How long does one loss stall the stream?            | **About 1.33 × RTT**, then 1-2 aftershocks of about 0.3 × RTT from the congestion window.               |
| Does anything reach `AI_AFTER` (30 ticks)?          | **No.** The worst stall in 30 min at 1-3 % loss was 416 ms, about 23 missing ticks.                       |
| How many frames are replaced with released keys?    | **About 12 % at 1 % loss and about 38 % at 3 % loss**, at 50 ms one-way.                                |

---

## How it was measured

`loss-calibration/calibrate.mjs` runs in a container with `NET_ADMIN`. It applies netem to the
container's own loopback and sends one 72-byte frame per tick in each direction over plain TCP
with Nagle off. Both ends share a clock, so every frame's one-way latency is exact.
"Excess" means latency beyond the configured delay. A **stall** is a run of consecutive frames
that each arrived more than a tick late. For every condition, the kernel's TCP counters are
compared before and after.

The run used Docker Desktop's `7.0.12-linuxkit` kernel with `cubic`, SACK and RACK
(`tcp_recovery=1`). netem's loss is uniform and independent, and it hits data and ACKs in both
directions, so RTT is twice the one-way delay.

## §1. Loss is repaired in about one RTT, not by a timeout

`TCPTimeouts` is 0 in every condition at 50 ms, and in the long runs it is 0 across 4 115
retransmits. A 60 Hz stream always has the next frames in flight behind a lost one. Their
SACKs expose the hole within one RTT, and RACK repairs it without waiting for a timer. The
textbook worry (a 200 ms RTO that doubles to 400 ms) does not apply to this traffic.

Stall peaks as a multiple of RTT, over 16 000+ events at 50 ms one-way:

| Kind                                     | Peak           | Share of stall events | Cause                                           |
| ---------------------------------------- | -------------- | --------------------- | ----------------------------------------------- |
| main stall                               | ~1.33 × RTT    | ~⅓                    | one lost segment, fast retransmit               |
| aftershock, within one RTT of a main one | 0.2-0.35 × RTT | ~⅔                    | cubic cuts the congestion window after the loss |
| double loss (the retransmit lost too)    | 3-4.2 × RTT    | 1-3 per 10 min at 3 % | a second repair round                           |

The aftershocks are the kernel effect that a proxy placed above TCP could never have
produced. Before this run it was written off as irrelevant. It turns out to be the most common
kind of stall, although each one is only 1-2 ticks.

At 10 and 20 ms one-way, the same shapes appear stretched by the tick. A 20 ms RTT is shorter
than the time until the next frame exposes the hole, so there a main stall is about 2 × RTT.

With no loss, there were 2-8 one-tick "stalls" per minute. That is the noise floor of Node's
timers in a container, not the network.

## §2. What that costs the game: `d` absorbs one tick of it

`input_delay()` sets `d = ceil(one_way / tick) + 1`. At 50 ms one-way that gives `d = 4` and
**16.7 ms of slack** beyond the trip. A main stall is about 133 ms late, so every frame inside
it misses the relay's deadline and `substitute()` releases the keys. Frames from the upstream
direction:

| One-way | Loss  | Frames > 1 tick late | Main stalls / min |
| ------- | ----- | -------------------- | ----------------- |
| 50 ms   | 0.5 % | ~5 %                 | ~18               |
| 50 ms   | 1 %   | ~12 %                | ~36               |
| 50 ms   | 3 %   | ~36-41 %             | ~80-90            |

In the game, each main stall freezes that player's bunny for about 7 ticks on everyone else's
screen, more than once a second at 3 % loss. It is the same symptom as research §1 of
`desync-under-load.md`, with a different cause: there the slow client's event loop, here the
wire.

There are two ways out:

- **Rollback (#136 §1).** A predicted frame costs a correction a few ticks long instead of a
  frozen bunny, and `d` can shrink as well. This is what the numbers argue for.
- **A bigger `d`.** Absorbing one main stall would take about `1.33 × RTT` more, so +8 ticks at
  100 ms RTT, up to the cap of 10. Everyone pays that in input lag on every tick, to cover a
  loss that happens on a few.

## §3. `AI_AFTER` holds, with a margin that shrinks as RTT grows

`substitute()` counts a seat's consecutive missing ticks and hands the seat to the AI at 30.
A stall of `excess` ms costs roughly `(excess - slack) / tick` missing ticks. The worst of
16 000+ stalls in 30 min at 1-3 % loss was 416 ms, about 23 missing ticks, so the margin is 7.

This part is **extrapolated, not measured**. The worst case is about 4.2 × RTT. With `d`
growing as above, it crosses 30 missing ticks at about **65 ms one-way with 3 % loss**, and
about 75 ms with 1 % loss. Beyond that, a player who is still connected could have their bunny
handed to the AI.

It was deliberately left unmeasured. In production, a player's TCP connection ends at the
nearest Cloudflare edge (`server-runtime.md`), so a loss on the player's side is repaired over
the player-to-edge RTT, which is usually short, and not over the full distance to the relay.
The CI regression checks it directly instead: the proxy injects a 4 × RTT stall at 90 ms
one-way and asserts the seat stays with its player.

## §4. The proxy's stall model

This is what the proxy injects, for each direction independently, at loss rate `p`:

- Each frame's packet is lost with probability `p`.
- A loss stalls the stream for `1.33 × RTT`, and everything behind it arrives together when the
  stall ends.
- 1-2 aftershocks of `0.2-0.35 × RTT` follow within the next RTT.
- With probability `p`, the stall is a double loss of `3-4.2 × RTT` instead.
- No timeouts, and no loss of data.

## What this does not cover

- **Bursty loss.** netem drops packets independently. Real Wi-Fi drops them in bursts, which
  makes double losses, the only thing that approaches `AI_AFTER`, more common than
  measured here.
- **One kernel.** The results depend on the kernel's recovery settings (RACK, cubic), and
  another OS or tuning could behave differently. Chrome runs on the player's OS, so the
  upstream direction is that OS's TCP, not Linux's.
- **The Cloudflare tunnel.** A loss between Cloudflare and the relay stalls every player at
  once. Only a match played through the real deployment can show that.
- **WebSocket.** The run used plain TCP with the same frame sizes and Nagle off. The WebSocket
  header adds 2-6 bytes and changes nothing at the TCP level.
