# Loss calibration (#136 §3)

A one-shot container that measures what a real kernel TCP does to a 60 Hz stream of small
frames under delay, jitter and loss. The result is the stall model for the seeded userland
proxy that the deep loss test and the CI regression run on. A proxy sits above TCP and can
only fake a loss's result. This run records the real one: which repair path TCP took (fast
retransmit, tail loss probe, RTO) and how long each loss held the stream up.

## Run it

```sh
docker build -t jnb-netem docs/research/loss-calibration
docker run --rm --cap-add NET_ADMIN -v "$PWD/calibration:/out" jnb-netem
```

It takes about 26 minutes: 24 cells of 60 s each, plus the drain. `-e CELL_SECONDS=10` shortens
every cell for a smoke run. When it finishes, `calibration/` holds:

- `calibration.md`: the tables. Paste it into the issue.
- `calibration.json`: the raw data, including every stall event. Attach it.

If `tc` cannot attach netem, the container says so and exits. On a Linux host, run
`sudo modprobe sch_netem` first. Docker Desktop's VM kernel ships the module.

## What it does

- It shapes the container's own `lo` with netem, so the host network is untouched. It runs
  every combination of one-way delay 10/20/50 ms, jitter 0/5 ms and loss 0/0.5/1/3 %. On
  `lo`, delay and loss hit data and ACKs alike, so RTT is twice the one-way delay.
- In each cell it opens a fresh TCP connection with Nagle off, as `ws` and Chrome do. It
  sends one 72-byte frame per tick in each direction, and it measures every frame's one-way
  latency on one shared clock.
- For every cell it reports:
    - latency over the configured delay (p50 to max), in ms
    - the frames that arrived 1-3, 4-7, 8-15 or 16+ ticks late
    - stalls: runs of consecutive frames that each arrived more than a tick late
    - the kernel's TCP recovery counters (`/proc/net/netstat`), diffed across the cell
- It also records the kernel version and the TCP sysctls, because they decide the RTO and the
  recovery path.
