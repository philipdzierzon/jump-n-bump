# Loss calibration

```json
{
  "started": "2026-09-22T18:04:50.044Z",
  "kernel": "7.0.12-linuxkit",
  "node": "v22.23.2",
  "cpus": 6,
  "seconds_per_cell": 600,
  "tcp_congestion_control": "cubic",
  "tcp_early_retrans": "3",
  "tcp_recovery": "1",
  "tcp_sack": "1",
  "tcp_thin_linear_timeouts": "0",
  "cells": [
    "50/0/1",
    "50/0/3",
    "50/5/3"
  ],
  "finished": "2026-09-22T18:34:51.205Z"
}
```

600 s per cell. Excess is one-way latency over the configured delay, in ms. Ticks late counts frames, a stall is a run of consecutive frames each over a tick late.

| one-way ms | jitter ms | loss % | dir | p50 | p99 | p99.9 | max | 1-3 ticks | 4-7 | 8-15 | 16-29 | 30+ | lost | stalls/min | longest stall (frames) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 50 | 0 | 1 | up | 1.2 | 130.1 | 184.8 | 353.2 | 2611 | 1374 | 198 | 8 | 0 | 0 | 131.3 | 27 |
| 50 | 0 | 1 | down | 1.2 | 130.1 | 171.5 | 328.1 | 2618 | 1368 | 184 | 7 | 0 | 0 | 129.3 | 19 |
| 50 | 0 | 3 | up | 4.7 | 161 | 263.1 | 368.6 | 8403 | 3477 | 1037 | 33 | 0 | 0 | 398.7 | 31 |
| 50 | 0 | 3 | down | 5 | 155.5 | 242.2 | 412.1 | 8721 | 3593 | 1006 | 17 | 0 | 0 | 403.2 | 26 |
| 50 | 5 | 3 | up | 8.8 | 166.6 | 272.3 | 416 | 9481 | 4003 | 1114 | 42 | 0 | 0 | 438 | 33 |
| 50 | 5 | 3 | down | 7 | 184.9 | 291.1 | 415.1 | 8791 | 3679 | 1195 | 76 | 0 | 0 | 410 | 40 |

## Which repair path TCP took (counter deltas per cell, both directions)

| one-way ms | jitter ms | loss % | RetransSegs | TCPFastRetrans | TCPLossProbes | TCPLossProbeRecovery | TCPTimeouts | TCPSlowStartRetrans | TCPSpuriousRTOs | TCPSACKReorder | TCPRenoRecovery | TCPSackRecovery |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 50 | 0 | 1 | 691 | 691 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 651 |
| 50 | 0 | 3 | 1620 | 1620 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1397 |
| 50 | 5 | 3 | 1804 | 1804 | 0 | 0 | 0 | 0 | 0 | 668 | 0 | 1474 |
