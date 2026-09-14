# Research: Workers + Durable Objects vs Node in Docker for a lockstep relay

Resolves [#23](https://github.com/philipdzierzon/jump-n-bump/issues/23). Blocks [#11](https://github.com/philipdzierzon/jump-n-bump/issues/11).
Rests on the architecture settled in [#6](https://github.com/philipdzierzon/jump-n-bump/issues/6): **the server runs no simulation.**

---

## Source note

All Cloudflare facts were gathered twice, and agree exactly both times.

The first pass read **Cloudflare's docs source** on GitHub —
[`cloudflare/cloudflare-docs`](https://github.com/cloudflare/cloudflare-docs) @ `production`, under
`src/content/` — because `developers.cloudflare.com` was blocked by the sandbox network policy at the time.
The second pass, after the policy was relaxed mid-research, re-read the **live rendered pages** and confirmed
every load-bearing quotation and every pricing figure verbatim: the compute billing table, the 20:1 WebSocket
ratio, free egress, 128 MB flat billing, the rounding rule, the full hibernation condition list, the 10-second
threshold, the 70–140 s eviction window, WebSocket termination on shutdown, and the `wrangler tail` WebSocket
log delay.

Citations below give the docs-source file path, which maps to the live URL as
`https://developers.cloudflare.com/<path minus src/content/docs/>`. Read 2026-09-14. What remains unverified
is listed in [Unverified](#unverified) — it is now a short list, and none of it changes the recommendation.

---

## Recommendation

**Node in Docker behind the existing Cloudflare Tunnel.**

Not because Durable Objects can't do it — they can, and the bill is smaller than the ticket feared. Because
the two things this project will actually do every week — **change a knob** and **watch a live room** — are
both things a Durable Object structurally cannot do, and a Node process does for free.

The three findings that decide it, in order of weight:

1. **You cannot watch a live room on Workers.** `console.log` inside a WebSocket handler is *withheld until
   the client disconnects*. Debugging a desync means debugging a room that has already ended.
2. **You cannot change a deployment env var without killing every live room.** Setting a var is a new
   deployment; a new deployment restarts every Durable Object; restarting a DO terminates its WebSockets.
   Every room in flight dies so you can widen a grace period by 200 ms.
3. **Hibernation does not apply during a match**, so the duration bill is a flat floor you cannot optimise
   away. It's a *small* floor (~$0.006/room-hour), but it means the DO's headline cost advantage —
   "you only pay when something happens" — is exactly the advantage this workload cannot claim.

Against that, DOs win one real thing: **per-room placement**. A DO lands near its players; a Docker box is
nailed to one city forever. For an all-EU room and an all-US room served by one EU box, the US room eats the
Atlantic. That is a genuine, load-bearing advantage for a global playerbase — and it is the one reason to
revisit this. See [Latency](#3-latency).

The tiebreaker is that Option B is already proven in the owner's other projects, and the ticket asked for
"boring and known" to be weighed honestly. It's worth about two weeks of not-fighting-the-platform.

**Cost of being wrong is low.** The relay is a few hundred lines with no game logic in it. Port it later if
the playerbase goes global.

---

## 1. Durable Objects + WebSockets: hibernation, and whether 60 Hz works at all

### The crux: hibernation is irrelevant while a match is running

A Durable Object hibernates only after **10 seconds of no incoming request or event**, and only if a list of
conditions all hold:

> "Hibernation can only occur if **all** of the conditions below are true: No `setTimeout`/`setInterval`
> scheduled callbacks are set […] No in-progress awaited `fetch()` exists […] No WebSocket standard API is
> used. No request/event is still being processed […] No active outbound TCP socket (`connect()`) or outbound
> WebSocket connection exists.
>
> After 10 seconds of no incoming request or event, and all the above conditions satisfied, the Durable Object
> will transition into the **hibernated** state."
>
> — `src/content/docs/durable-objects/concepts/durable-object-lifecycle.mdx`

A 60 Hz input relay receives a message every ~16.7 ms. The gap between events is never 10 seconds. **The DO is
in the `Active, in-memory` state for the entire duration of the match, and is billed wall-clock for all of
it.**

This is not a mitigable fact. It does not depend on message size, on how efficient the handler is, or on
whether you batch. Even at *one message per second* the DO never hibernates. The only thing that stops the
clock is the room going genuinely quiet for 10 s.

The billing rule confirming it:

> "A Durable Object incurs duration charges when it is actively executing JavaScript — either handling a
> request or running event handlers — or when it is idle but does not meet the conditions for hibernation."
>
> — `src/content/partials/durable-objects/do-faq-pricing.mdx`

> "Duration is billed in wall-clock time as long as the Object is active and not eligible for hibernation […]
> Duration billing charges for the 128 MB of memory your Durable Object is allocated, **regardless of actual
> usage**."
>
> — `src/content/partials/durable-objects/durable-objects-pricing.mdx`, footnotes 4 and 5

**So: can a 60 Hz relay use DOs at all without ruinous duration billing?** Yes — but read the sentence
carefully. Hibernation buys you *nothing during a match*. It buys you the **lobby**: a room sitting in lobby
with nobody typing goes quiet, hibernates after 10 s, and costs zero while its four WebSockets stay connected.
That is a real saving if lobby time is a meaningful fraction of room lifetime, and it is the reason to use
`ctx.acceptWebSocket()` rather than `ws.accept()` even though the match phase ignores it.

The duration bill during a match is **128 MB × wall-clock**, i.e. 0.128 GB-s per second of room lifetime —
**$0.00576 per room-hour of duration alone** (arithmetic in [Cost](#2-cost)). Not ruinous in absolute terms.
Ruinous only relative to a box you already own, and only once room-hours accumulate.

### Use the Hibernation API regardless

Two free wins even though the match phase never hibernates:

- `setWebSocketAutoResponse()` answers a fixed ping with a fixed pong **without waking the object**:
  > "If a request is received matching the provided request then the auto-response will be returned without
  > waking WebSockets in hibernation and incurring billable duration charges."
  > — `src/content/docs/durable-objects/api/state.mdx`

  Request and response are capped at 2,048 characters each. This handles lobby keepalive for free. It is
  **not** usable for RTT probing that the relay needs to see, since the DO never learns about it beyond
  `getWebSocketAutoResponseTimestamp()`.
- WebSocket protocol pings are handled by the runtime and never wake the object:
  > "Incoming ping frames receive automatic pong responses. Ping/pong handling does not interrupt hibernation.
  > The `webSocketMessage` handler is not called for control frames."
  > — `src/content/docs/durable-objects/best-practices/websockets.mdx`

### Connection limit per DO

> "The WebSocket Hibernation API permits a maximum of **32,768 WebSocket connections per Durable Object**, but
> the CPU and memory usage of a given workload may further limit the practical number of simultaneous
> connections."
>
> — `src/content/docs/durable-objects/api/state.mdx`

Four seats per room. Non-issue by four orders of magnitude.

### Can the DO hold the ~10 KB snapshot in memory, or must it round-trip storage?

**In memory, as an instance variable. No storage round-trip, no storage bill.**

- In-memory state persists across requests for as long as the object is not evicted
  (`src/content/docs/durable-objects/reference/in-memory-state.mdx`). During a match the object is never
  evicted, so a `this.latestSnapshot` field is simply there.
- 10 KB against a **128 MB** isolate budget is nothing
  (`src/content/docs/durable-objects/observability/metrics-and-analytics.mdx`).
- Received WebSocket message size limit is **32 MiB**
  (`src/content/docs/durable-objects/platform/limits.mdx`), so the 10 KB snapshot pushes fine.
- **Do not use `serializeAttachment` for it.** Attachments are capped at **16,384 bytes** and are per-connection,
  not per-room: "Maximum serialized size is 16,384 bytes"
  (`src/content/docs/durable-objects/best-practices/websockets.mdx`). A 10 KB snapshot would fit today and
  break the first time the packing gets 60% bigger. Attachments are for the seat-ownership entry, which is
  exactly what they're for — see below.

The cost of in-memory-only: an eviction, a host migration, or a deploy wipes it. Since clients push a fresh
snapshot every ~2 s (#6), the worst case is a joiner waiting ≤2 s for the next one. Acceptable. **Do not add
storage for this** — it would convert a free in-memory field into billed row writes every 2 seconds per room.

### The seat-ownership map, consulted once per frame

This is the one thing `serializeAttachment` is genuinely good for. Attach `{clientToken, seats[]}` to each
WebSocket at accept time; `ws.deserializeAttachment()` in `webSocketMessage` gives you the sender's seats with
no lookup and no storage:

> "Serialized attachments persist through hibernation as long as the WebSocket remains healthy."
>
> — `src/content/docs/durable-objects/best-practices/websockets.mdx`

Comfortably inside 16 KB. This drops the forged-input check (#7) to a per-message array membership test.

### The high-frequency warning Cloudflare puts in its own docs

Worth quoting in full, because it is the one place Cloudflare pushes back on this workload shape:

> "Each WebSocket message incurs processing overhead from context switches between the JavaScript runtime and
> the underlying system. **Sending many small messages can overwhelm a single Durable Object.** This happens
> even if the total data volume is small. […] For high-frequency data like sensor readings or **game state
> updates**, use time-based or count-based batching. Batch every 50-100ms or every 50-100 messages, whichever
> comes first."
>
> — `src/content/docs/durable-objects/best-practices/websockets.mdx`

50–100 ms of batching is 3–6 ticks of added input delay, on top of the delay already derived from worst RTT.
That is a direct tax on game feel, and it is Cloudflare's own recommendation for exactly this traffic shape.

Mitigation that costs nothing: the relay's **outbound** fan-out can carry all four seats' inputs for tick N in
one frame per client rather than four. That's 4:1 fan-in batching with zero added latency, because the tick's
inputs are already being handled together. The **inbound** side stays 240 msg/s/room and cannot be batched
without adding delay.

At 4 clients this is almost certainly fine. The warning is flagged, not weighted heavily — but it is a reason
not to be smug about the 32,768-connection ceiling.

### Things that will bite

- **Deploys kill rooms.** "Code updates disconnect all WebSockets. Deploying a new version restarts every
  Durable Object, which disconnects any existing connections."
  (`src/content/docs/durable-objects/best-practices/websockets.mdx`) — and separately, "WebSocket requests are
  terminated automatically during shutdown" (`…/concepts/durable-object-lifecycle.mdx`). Any deploy, at any
  time, drops every room in progress.
- **Mixed versions during rollout.** A request can reach a new-version Worker that calls a DO still on the old
  version, "typically seconds to minutes"
  (`src/content/docs/durable-objects/platform/known-issues.mdx`). The wire format (#12) has to be forward- and
  backward-compatible across a deploy, or the deploy desyncs rooms rather than merely dropping them.
- **CPU budget resets per message**, 30 s default — irrelevant here, the relay does no work
  (`src/content/docs/durable-objects/platform/limits.mdx`).

---

## 2. Cost

Numbers from `src/content/partials/durable-objects/durable-objects-pricing.mdx` (Workers Paid plan) and
`src/content/docs/workers/platform/pricing.mdx`, rendered as
`developers.cloudflare.com/durable-objects/platform/pricing/` and `…/workers/platform/pricing/`.

| Dimension | Included / month | Overage |
| --- | --- | --- |
| DO requests | 1,000,000 | $0.15 / million |
| DO duration | 400,000 GB-s | $12.50 / million GB-s |
| Worker requests | 10,000,000 | $0.30 / million |
| Account minimum | — | $5.00 / month |

Three billing rules that do all the work:

1. **20:1 WebSocket ratio.** "For compute requests billing-only, a 20:1 ratio is applied to incoming WebSocket
   messages […] 100 WebSocket incoming messages would be charged as 5 requests."
2. **Outgoing is free.** "There is no charge for outgoing WebSocket messages, nor for incoming WebSocket
   protocol pings." The 3× fan-out costs nothing.
3. **128 MB flat.** Duration bills 128 MB "regardless of actual usage". A 10 KB room bills the same as a
   100 MB one.

Billable usage is rounded up to the next million before the rate applies (same partial), and Cloudflare's own
worked examples round to the next whole million — followed below.

### Workload

Worst case, from #6: 4 clients × 60 Hz, every seat sending every tick.

- Incoming messages into the DO: **240 /s/room**
- Outgoing: 4 frames/tick = 240 /s — **free**
- Snapshot: ~10 KB every 2 s from one client = 0.5 /s — noise in the request count, and message *size* is not
  a DO billing dimension

### One room, 4 clients, 15 minutes (900 s)

**Requests**
```
incoming WS messages   240 /s × 900 s                = 216,000
billable (20:1)        216,000 / 20                  =  10,800
+ WS connection setup  4                             =  10,804
cost                   10,804 × $0.15 / 1,000,000    =  $0.00162
```

**Duration**
```
object-seconds         900 s   (no hibernation — never 10 s idle)
GB-s                   900 × 128 MB / 1000 MB        =     115.2 GB-s
cost                   115.2 × $12.50 / 1,000,000    =  $0.00144
```

**Front Worker**: 4 requests. "WebSocket connections made to a Worker are charged as a request, representing
the initial `Upgrade` connection […] **WebSocket messages routed through a Worker do not count as requests**"
(`src/content/docs/workers/platform/pricing.mdx`, footnote 2). Effectively $0.

> ### **One 15-minute 4-player room ≈ $0.0031. Roughly a third of a cent.**

Per room-hour: **$0.0122** ($0.00648 requests + $0.00576 duration).

### 50 concurrent rooms

50 concurrent rooms = 50 room-hours per wall-clock hour = **$0.61 per peak hour**.

Two monthly framings, because "50 concurrent" is a peak, not a duty cycle:

**(a) 50 rooms busy 4 h/day, every day** — 6,000 room-hours/month
```
Duration   6,000 × 460.8 GB-s        = 2,764,800 GB-s
           − 400,000 included        = 2,364,800 → round up 3,000,000 × $12.50/M = $ 37.50
Requests   6,000 × 864,000 msgs      = 5,184,000,000 incoming
           / 20                      =   259,200,000 billable
           − 1,000,000 included      =   258,200,000 → round up 259,000,000 × $0.15/M = $ 38.85
Minimum                                                                                $  5.00
                                                                                       ───────
                                                                                       $ 81.35 / month
```

**(b) 50 rooms pinned 24/7** (the pessimistic bound) — 36,000 room-hours/month
```
Duration   16,588,800 GB-s − 400,000 → 17,000,000 × $12.50/M = $212.50
Requests   31,104,000,000 / 20 = 1,555,200,000 − 1,000,000 → 1,555,000,000 × $0.15/M = $233.25
Minimum                                                                                $  5.00
                                                                                       ───────
                                                                                       $450.75 / month
```

Sanity-check against Cloudflare's own Example 3, which is 100 always-on DOs at 1 msg/s each:
$1.80 requests + $412.50 duration + $5 = $419.30/month. Our (b) is 50 DOs at 240× the message rate — duration
roughly halves as expected, requests dominate instead. Consistent.

### The duration floor is the interesting number

Requests scale with how chatty you are. **Duration does not.** It is $0.00576 per room-hour no matter what,
because the DO cannot hibernate mid-match. Even if you delta-encode inputs down to near zero:

**Delta-encoded variant** — send only on key change (~5/s/seat) plus a 1 Hz heartbeat, ≈24 msg/s/room:
```
6,000 room-hours: duration $37.50 (unchanged) + requests $3.75 + $5 = $46.25 / month
```
Request cost falls 10×. Duration doesn't move. **Below ~$46/month you cannot go on Workers at that volume**,
and the floor rises linearly with room-hours forever.

### Workers Free plan is not viable

Free plan: 100,000 requests/day and 13,000 GB-s/day (same pricing partial).

- Duration ceiling: 13,000 ÷ 0.128 = 101,562 object-seconds = **28.2 room-hours/day**
- Request ceiling: 100,000 × 20 = 2,000,000 incoming messages ÷ 240/s = 8,333 room-seconds = **2.3 room-hours/day**

Requests bind first, hard. And "If you exceed any one of the free tier limits, further operations of that type
will **fail with an error**" (`src/content/docs/durable-objects/platform/pricing.mdx`) — not throttle, fail.
Two and a half hours of play a day and the game breaks. **Workers Paid ($5/mo minimum) is mandatory.**

### Option B: Node in Docker behind a Cloudflare Tunnel

**Cloudflare-side cost: $0.**

- Cloudflare Tunnel supports WebSockets outright: "**Does Cloudflare Tunnel support Websockets?** Yes.
  Cloudflare Tunnel has full support for Websockets."
  (`src/content/docs/cloudflare-one/faq/cloudflare-tunnels-faq.mdx`)
- Proxied WebSockets need no extra product: "Cloudflare supports proxied WebSocket connections without
  additional configuration. […] WebSockets are supported on all Cloudflare plans."
  (`src/content/docs/network/websockets.mdx`)
- Bandwidth through the proxy is not metered on Free/Pro/Business. The one caveat in the Tunnel FAQ is the
  service-specific terms restricting **video and other large files** on those plans — 20-byte input frames are
  not that.

**Compute cost: the box, which already exists.** Marginal cost of adding this service ≈ $0.

If a box *did* have to be bought, this workload is at the bottom of every price list. DigitalOcean's cheapest
Basic Droplets, from [digitalocean.com/pricing/droplets](https://www.digitalocean.com/pricing/droplets):

| Price/mo | vCPU | Memory | SSD | Transfer |
| --- | --- | --- | --- | --- |
| $4.00 | 1 | 512 MiB | 10 GiB | 500 GiB |
| $6.00 | 1 | 1 GiB | 25 GiB | 1,000 GiB |

**Transfer is the binding constraint, not CPU or RAM.** At 50 concurrent rooms the relay emits ~0.72 MB/s
(see load figures below), which is ~311 GB/month at 4 h/day — comfortably inside the $6 tier — but ~1,866
GB/month if pinned 24/7, which overruns it. The 24/7 case wants either the next Droplet tier or a host with a
larger allowance (Hetzner's cloud plans list 20 TB included traffic for EU-located servers, though every plan
showed as unavailable with prices blank when checked). Even taking the worst reading, this is a **$6–$20/month**
line item against Workers' $81–$451.

Load, so the "already exists" claim is checkable rather than hand-waved. 50 concurrent rooms:

```
inbound    50 × 240 msg/s                        = 12,000 msg/s
outbound   50 × 240 × 3 (fan-out to the other 3) = 36,000 msg/s
bytes out  36,000 × ~20 B (payload + WS framing) ≈ 720 KB/s ≈ 5.8 Mbit/s
snapshots  50 × 10 KB / 2 s                      ≈ 250 KB/s in
memory     50 × (10 KB snapshot + few KB state)  ≈ 1 MB
```

One Node process on one core. The relay does no simulation — it reads a tick number, checks an array, and
calls `send()` three times.

### Cost verdict

| | 1 room × 15 min | 50 rooms × 4 h/day × 30 d | 50 rooms 24/7 |
| --- | --- | --- | --- |
| Workers + DO (60 Hz) | $0.0031 | **$81.35/mo** | $450.75/mo |
| Workers + DO (delta-encoded) | ~$0.0011 | **$46.25/mo** | ~$225/mo |
| Node + Tunnel (existing box) | $0 | **$0** | $0 |
| Node + Tunnel (if a box had to be bought) | — | **$6/mo** (DO Basic Droplet) | $6–20/mo (transfer-bound) |

At one room, DOs are free-in-practice and the $5 minimum dominates. At 50 concurrent rooms the DO bill is
**real money for a hobby project**, and — the part that matters — it is **unbounded and grows linearly**,
while the VPS bill is flat until the box saturates, which on these numbers is a long way off.

---

## 3. Latency

### What the docs actually say about placement

> "Durable Objects do not currently change locations after they are created. **By default, a Durable Object is
> instantiated in a data center close to where the initial `get()` request is made.** This may not be in the
> same data center that the `get()` request is made from, but in most cases, it will be in close proximity."
>
> "It can negatively impact latency to pre-create Durable Objects prior to the first client request or **when
> the first client request is not representative of where the majority of requests will come from.**"
>
> — `src/content/docs/durable-objects/reference/data-location.mdx`

`locationHint` on the first `get()` overrides it, coarsely (`wnam`, `enam`, `weur`, `eeur`, `apac`, `apac-ne`,
`apac-se`, `oc`, plus `sam`/`afr`/`me` which "currently do not spawn" and fall back — South America spawns in
Eastern North America). "Hints are a best effort and not a guarantee." Only the **first** `get()` respects it,
and relocation is "planned for the future."

### The comparison is closer than the ticket assumes

The ticket frames this as "DO placement vs a single fixed Docker origin". But **the Docker origin is behind a
Cloudflare Tunnel**, which means both options put the client's first hop at the client's nearest Cloudflare PoP
and carry the long leg over Cloudflare's backbone:

> "`cloudflared` establishes outbound connections (tunnels) between your resources and Cloudflare's global
> network. […] Each connector sends traffic to the nearest Cloudflare data center."
>
> — `src/content/docs/cloudflare-one/networks/connectors/cloudflare-tunnel/index.mdx`

So the "public internet vs Cloudflare backbone" advantage people usually credit to DOs **does not
differentiate these two options**. Both get it.

What differentiates them is one thing: **where the terminating process sits.**

| | DO | Docker + Tunnel |
| --- | --- | --- |
| Regional room (all-EU) | lands in EU | wherever the box is — EU if the box is EU, +Atlantic if not |
| Regional room (all-US) | lands in US | +Atlantic every time, if the box is EU |
| Split room (EU + AU) | wherever the *first* client was | fixed, predictable |
| Can be steered | `locationHint`, once, at creation | no — one box, forever |
| Can follow the room as players join | no, "do not currently change locations" | n/a |

**Does nearest-to-first-client hurt a geographically split room, versus a single fixed origin?** Answering the
question as asked:

- **For a split room specifically: no worse, and often better.** A fixed origin is *always* far from somebody.
  A DO is far from somebody too, but at least it's near *someone*. The DO's worst case (first client is the
  geographic outlier — one Australian joins first, three Europeans follow, DO lands in Sydney) is genuinely
  bad and genuinely worse than a well-placed fixed box. But it is a *coin flip on join order*, not a standing
  condition, and `locationHint` is the fix.
- **For regional rooms — the common case, and the case #6's matchmaking is explicitly designed to produce
  ("Matchmaking prefers nearby players") — the DO wins clearly.** An all-US room served by an EU box eats a
  trans-Atlantic round trip on *every* frame, forever. A DO doesn't.

Because input delay is derived from the **worst** RTT in the room (#6), this lands directly on game feel: the
whole room is slowed to its most distant member's one-way trip.

### What this means for the recommendation

This is the one axis where Option A is straightforwardly better, and it is the reason to keep the port on the
table. It only bites if the playerbase is genuinely multi-continental. For a game shared with friends, or a
playerbase that clusters where the owner's box already is, one fixed origin is fine and the DO advantage is
theoretical.

**Mitigations if Option B is chosen and the playerbase does go global:** a second Node instance in another
region joined to the same tunnel, with room-id → region pinning; or switch to Option A at that point, since
the relay is small enough to port in a day.

**Mitigation if Option A is chosen:** pass an explicit `locationHint` derived from the *host's* region at room
creation rather than letting the first `get()` decide, and accept the caution that hints are best-effort.

### Idle-timeout and keepalive (applies to both)

Cloudflare closes idle WebSockets: "Cloudflare will close a WebSocket connection when no data is transmitted in
either direction for a period of time" — duration unstated for non-Enterprise, custom values Enterprise-only
(`src/content/docs/network/websockets.mdx`). Client→CF keep-alive is capped at **400 s** and CF→origin proxy
idle at **900 s** (`src/content/docs/fundamentals/reference/connection-limits.mdx`).

A lobby can easily sit idle past these. **Both options need a client-side heartbeat**, which Cloudflare
recommends directly ("Implement a keepalive"). On DOs, `setWebSocketAutoResponse()` makes it free; on Node it's
a `setInterval` ping. Also, for both: "When Cloudflare releases new code to its global network, we may restart
servers, which terminates WebSockets connections." Reconnect-and-resync is mandatory infrastructure either
way — which the snapshot mechanism (#6) already provides.

---

## 4. Broadcast: fan-out primitive, or an N-times loop?

**An N-times loop. There is no fan-out primitive.** Confirmed by Cloudflare's own code samples, which write
`broadcast` as a hand-rolled `for`:

```ts
// src/content/docs/durable-objects/best-practices/rules-of-durable-objects.mdx
private broadcast(message: string) {
  for (const client of this.ctx.getWebSockets()) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}
```

`ctx.getWebSockets()` "returns an `Array<WebSocket>` which is the set of WebSockets attached to the Durable
Object", optionally filtered by tag (`src/content/docs/durable-objects/api/state.mdx`). Tags are ≤256 chars,
≤10 per socket — usable to address a subset, but still a loop over the returned array.

**This is a non-difference.** Node's `ws` is the identical `wss.clients.forEach(c => c.send(...))`. At N=4 the
loop is four `send()` calls per tick either way.

Two footnotes worth keeping:

- **Outgoing messages are free on DOs** (pricing partial, footnote 2), so 3× fan-out costs nothing in
  requests. The billing asymmetry favours fan-out-heavy workloads, which is exactly what this is.
- One `CLOSING`-state gotcha: "`getWebSockets` may still return WebSockets even after `ws.close` has been
  called" — hence the `readyState === OPEN` guard in Cloudflare's own sample. Copy the guard.

---

## 5. The env-var knob (ready-gate grace period), changed without a redeploy

**Neither option gives you this natively. Option A makes the workaround a binding; Option B makes it five
lines.**

### Option A: Workers + DO

The native mechanism is `[vars]` in `wrangler.jsonc`, or the dashboard:

```jsonc
{ "vars": { "READY_GATE_GRACE_MS": "3000" } }
```
read as `env.READY_GATE_GRACE_MS` (`src/content/docs/workers/configuration/environment-variables.mdx`).
Per-environment overrides exist via `env.staging.vars` / `env.production.vars`; note `vars` is a
*non-inheritable* key and must be repeated per environment.

**Changing it requires a deployment, and a deployment kills every live room.** Chain of three citations:

1. Dashboard: "Under **Variables and Secrets**, select **Add** […] Select **Deploy** to implement your
   changes." (`…/workers/configuration/environment-variables.mdx`)
2. CLI: "`wrangler secret put` **creates a new version of the Worker and deploys it immediately.**"
   (`src/content/docs/workers/configuration/secrets.mdx`) — and "To your Worker, there is no difference between
   an environment variable and a secret" (`src/content/partials/workers/env_and_secrets.mdx`).
3. Consequence: "Code updates disconnect all WebSockets. **Deploying a new version restarts every Durable
   Object, which disconnects any existing connections.**"
   (`src/content/docs/durable-objects/best-practices/websockets.mdx`)

`wrangler versions secret put` + `wrangler versions deploy` lets you stage the version and control the rollout
via gradual deployments, but the rollout itself still restarts objects — gradual deployment changes *when*
rooms drop, not *whether*.

**The real answer on Workers: don't put it in a var.** Put the grace period in Workers KV or a small config
Durable Object, and have each room DO read it once at room creation. Then changing it is a KV write — no
deploy, no restart, live rooms untouched, new rooms pick it up. This works well. It is also a binding, a
second storage system, a cache-invalidation question, and a thing to explain. It's maybe 30 lines and a
`wrangler.jsonc` entry.

### Option B: Node in Docker

`docker run -e READY_GATE_GRACE_MS=3000`, or `environment:` in `docker-compose.yml` + `docker compose up -d`.

Changing it via the env var also requires a container restart, which also drops every connection. **Same
problem, same shape.**

The difference is the escape hatch. A long-lived process can be told things:

```js
// ponytail: process-local config, no persistence — fine while rooms die with the process anyway
let graceMs = Number(process.env.READY_GATE_GRACE_MS ?? 3000);
process.on("SIGHUP", () => { graceMs = Number(readFileSync("/etc/relay/grace", "utf8")); });
```

Or a three-line authenticated `POST /admin/config`. Either changes the value live, with zero dropped
connections and zero new infrastructure. On Workers there is no long-lived process to signal, so the KV
binding is not an optimisation — it's the only door.

### Verdict on bullet 5

Honest score: **both need a non-env-var path for live changes; Option B's is free and Option A's is a
component.** And Option A carries a second, sharper cost that Option B does not: on Workers, *any* change of
*any* kind — a var, a secret, a one-character code fix — drops every room in progress. That is a standing tax
on iteration, not a one-off setup cost.

---

## 6. Operational shape

### Logs

**Option A — this is the finding that decides the ticket.**

> "When using `wrangler tail` with **WebSocket event handlers**, any `console.log` statements within those
> handlers are **hidden until the WebSocket client closes the connection**. Once the `close` is received, all
> messages are flushed, printing everything to the terminal at once."
>
> — `src/content/docs/workers/observability/logs/real-time-logs.mdx`

Repeated in the DO known-issues page: "`wrangler tail` logs from requests that are upgraded to WebSockets are
**delayed until the WebSocket is closed**. `wrangler tail` should not be connected to a Worker that you expect
will receive heavy volumes of traffic."
(`src/content/docs/durable-objects/platform/known-issues.mdx`)

**You cannot watch a live game room.** The entire relay lives inside `webSocketMessage`. Every log line from
it is withheld until the player disconnects — at which point the room is over and you get the whole thing in
one dump. For debugging a desync *while it is happening*, this is disqualifying.

Worse, from the same known-issues page: "Enabling `wrangler tail` or Cloudflare dashboard logs **requires a
software update**" — listed among the things that can replace a Durable Object. Turning on logging can itself
drop live rooms.

Other Option A log constraints: real-time logs cap at **10 concurrent viewers** (dashboard sessions +
`wrangler tail` combined) and enter **sampling mode** under load, dropping messages.

The persisted alternative is **Workers Logs** — set `"observability": { "enabled": true }` in wrangler config,
deploy, then read the **Logs** tab on the Durable Object namespace
(`src/content/docs/durable-objects/observability/metrics-and-analytics.mdx`). Limits:
**7-day retention**, 5 billion logs/account/day (1% head-based sampling after), 256 KB/log
(`src/content/docs/workers/observability/logs/workers-logs.mdx`). This is a workable post-mortem tool. It is
still not live, and it is aggregated by script + class name rather than by room.

**Option B:** `docker logs -f`, or any log shipper. Live, unlimited viewers, no flush-on-close, no sampling,
retention is whatever the disk holds. `node --inspect` attaches a debugger to a running room.

### A live view of active rooms

**Option A: nothing built-in, and the closest thing doesn't do it.** The REST API for listing objects in a
namespace returns, per object, exactly two fields:

```go
// cloudflare/cloudflare-go @ main, durable_objects/namespaceobject.go
type DurableObject struct {
    ID            string `json:"id"`
    HasStoredData bool   `json:"hasStoredData"`
}
```

An opaque id and a stored-data flag. **No connection count, no phase, no participants, no liveness.** And
these rooms deliberately never persist anything (#6, "Rooms are never persisted"), so `hasStoredData` is
`false` for every one of them — the listing is uninformative even about existence.

Dashboard **Metrics** are namespace-level, or filterable to a single object only if you *already know* its ID
or name (`…/observability/metrics-and-analytics.mdx`). GraphQL exposes
`durableObjectsInvocationsAdaptiveGroups`, `durableObjectsPeriodicGroups`, `durableObjectsStorageGroups`,
`durableObjectsSubrequestsAdaptiveGroups` — aggregates, not an inventory. And the WebSocket metrics have their
own lag: "Metrics for a WebSocket connection itself is represented in `durableObjectsInvocationsAdaptiveGroups`
**once the connection closes**. Since WebSocket connections are long-lived, connections often do not terminate
until the Durable Object terminates."

So on Workers, "which rooms are live right now" is **something you build**: a registry Durable Object that
every room registers with on creation and deregisters from on teardown, plus a heartbeat so crashed rooms age
out — because a room DO that dies leaves no trace and nothing tells the registry. That is real code with a
real failure mode.

**Option B:** the rooms are a `Map` in the process.
```js
app.get("/admin/rooms", (_, res) => res.json([...rooms.values()].map(summary)));
```
Done. Already accurate, because it *is* the state, not a projection of it.

Note that #3's map already lists the public room list and site-wide statistics as features. On Option B the
admin view is the same `Map` those read from. On Option A the registry DO has to exist anyway for the public
room list — so this cost is partly already committed. Fair to Option A: **the registry is not purely
observability overhead.**

### Debugging a desync in production

The #6 snapshot mechanism is the instrument on both: clients push ~10 KB every ~2 s, and divergence shows up as
a snapshot mismatch at a known tick.

**Option A.** The relay holds the latest snapshot in memory but can't show it to you. To see it you write an
authenticated admin path into the DO's `fetch()` that dumps `this.latestSnapshot` and the per-seat input ring.
Then: hit the room's URL, get the blob, diff offline. Workable, but every diagnostic is a feature you build and
deploy first — and deploying it drops the room you were trying to observe. In practice you are always
debugging the *next* occurrence, never this one.

**Option B.** `curl localhost:PORT/admin/rooms/:id/snapshot`, or attach a debugger and inspect. Write the
mismatching snapshots to disk on detection and diff them at leisure. Add a diagnostic without restarting
anything if it goes behind the SIGHUP-reloaded config.

### Uptime and maintenance — the honest cost of Option B

Where Option A wins, and it should be stated plainly:

- **Nothing to patch, restart, monitor or wake up for.** No box, no OS updates, no cloudflared version drift,
  no disk filling with logs.
- **No single point of failure.** A Docker host going down takes every room with it. A DO host failure takes
  one room.
- **Scaling is automatic.** 500 rooms is 500 DOs and a bigger bill. On one box it's a capacity question you
  have to have thought about.
- **Cloudflare Tunnel needs `cloudflared` kept current**
  (`…/cloudflare-tunnel/downloads/update-cloudflared.mdx` exists for a reason).

Against this: rooms **already** die with their host (#3 vocabulary: "Lives exactly as long as its creator is
connected"), and reconnect-and-resync is mandatory anyway because Cloudflare restarts terminate WebSockets on
both options. So a relay restart is a degraded experience the protocol already handles, not a data-loss event.
The blast radius of a box reboot is "everyone reconnects", which is the same thing a Workers deploy does —
except on Workers it happens every time you change a variable.

---

## Summary table

| | Workers + Durable Objects | Node in Docker + Tunnel |
| --- | --- | --- |
| Hibernation during a match | **Never** (needs 10 s idle; gaps are 16.7 ms) | n/a |
| Hibernation in lobby | Yes — free while idle | n/a |
| Duration billing | 128 MB flat × wall-clock, irreducible | n/a |
| 1 room × 15 min | $0.0031 | $0 |
| 50 rooms × 4 h/day × 30 d | $81.35/mo (60 Hz) / $46.25 (delta) | $0 (box exists) |
| Free plan viable? | No — 2.3 room-hours/day, then hard errors | n/a |
| Connections per instance | 32,768 | OS limits, far beyond 4 |
| 10 KB snapshot | In-memory instance var, free | Same |
| Seat map | `serializeAttachment`, ≤16 KB | Plain object |
| Placement | Near first client; `locationHint` once, best-effort; never relocates | One fixed city, forever |
| Regional rooms | **Wins** — lands near the players | Loses if players aren't near the box |
| Split rooms | Coin-flip on join order | Predictably mediocre |
| Broadcast | `getWebSockets()` loop | `clients.forEach` loop |
| Live logs | **Withheld until client disconnects** | `docker logs -f` |
| Persisted logs | Workers Logs, 7-day retention | Whatever you want |
| Live room list | Build a registry DO | 1 line over the existing `Map` |
| Change a knob live | Needs a KV/config-DO binding | SIGHUP or admin endpoint |
| Any deploy | **Drops every room in progress** | Drops every room in progress |
| Ops burden | None | Box, patching, cloudflared, uptime |
| Single point of failure | No | Yes |

---

## Unverified

Stated explicitly, per the ticket's instruction not to guess. **Every Cloudflare pricing figure and every
load-bearing quotation in this document was verified against the live docs site** — what follows is what was
*not*.

1. **No RTT measurements.** The latency section reasons from Cloudflare's documented placement behaviour, not
   from measurement. Actual figures for "EU client → DO in `enam`" vs "EU client → Tunnel origin in EU" were
   not measured and are not in the docs. `https://where.durableobjects.live/` — referenced by Cloudflare's own
   data-location page as the way to find where objects actually land — returns **403 and was not reachable**
   even after the network policy was relaxed. **This is the one open question that could overturn the
   recommendation**; if the playerbase is multi-continental, measure before choosing.
2. **Cloudflare's WebSocket idle timeout for non-Enterprise plans has no published number** — the docs say
   only "a period of time", with custom values Enterprise-only. The 400 s client keep-alive and 900 s proxy
   idle limits *are* published. Both options need a heartbeat; the exact interval should be set empirically.
3. **The DO REST object-list semantics** were read from the `cloudflare-go` SDK struct
   (`durable_objects/namespaceobject.go` @ `main`) rather than the API reference page. The struct's two fields
   are unambiguous, so the "no connection count, no phase, no liveness" conclusion is solid. Whether a
   never-persisted object appears in the listing *at all* is **inferred** from `hasStoredData` being the only
   liveness-adjacent field, not confirmed.
4. **Whether the 50–100 ms batching guidance actually bites at 4 clients.** Cloudflare states that many small
   messages "can overwhelm a single Durable Object" but gives no threshold. 240 inbound msg/s is well inside
   the 32,768-connection design envelope and almost certainly fine; this was not load-tested.
5. **Hetzner pricing was not obtained** — every plan on the cost-optimized page showed "This product is
   currently unavailable" with prices blank. The 20 TB included-traffic figure was readable; the price was
   not. DigitalOcean's figures ($4/$6 tiers) *are* cited and are sufficient to bound the cost.
6. **The 20-byte-per-frame wire estimate is mine, not measured.** It drives the bandwidth figures and hence
   the VPS transfer tier. #12 owns the actual wire format; re-derive once it exists.

---

## Sources

All Cloudflare citations read 2026-09-14 from
[`github.com/cloudflare/cloudflare-docs`](https://github.com/cloudflare/cloudflare-docs) @ `production`, and
cross-checked verbatim against the live pages at `developers.cloudflare.com`.

| Claim | File under `src/content/` |
| --- | --- |
| Hibernation conditions, 10 s threshold, 70–140 s eviction, deploy shutdown | `docs/durable-objects/concepts/durable-object-lifecycle.mdx` |
| Hibernation API, batching guidance, `serializeAttachment` 16 KB, ping/pong, deploys disconnect WebSockets | `docs/durable-objects/best-practices/websockets.mdx` |
| `acceptWebSocket`, 32,768 connections, `getWebSockets`, `setWebSocketAutoResponse`, tags | `docs/durable-objects/api/state.mdx` |
| Rates, 20:1 ratio, free egress, 128 MB flat, rounding, Free-plan limits | `partials/durable-objects/durable-objects-pricing.mdx` |
| Worked billing examples, Free-plan hard failure | `docs/durable-objects/platform/pricing.mdx` |
| "When does a DO incur duration charges" | `partials/durable-objects/do-faq-pricing.mdx` |
| 32 MiB message size, 30 s CPU/request | `docs/durable-objects/platform/limits.mdx` |
| Placement, `locationHint`, no relocation, supported regions | `docs/durable-objects/reference/data-location.mdx` |
| In-memory state across requests, 128 MB isolate | `docs/durable-objects/reference/in-memory-state.mdx` |
| `wrangler tail` WS delay, code-update version skew, tail requires software update | `docs/durable-objects/platform/known-issues.mdx` |
| Workers Logs setup, GraphQL datasets, WS metrics lag, memory chart | `docs/durable-objects/observability/metrics-and-analytics.mdx` |
| `console.log` withheld until WS close, 10-viewer cap, sampling | `docs/workers/observability/logs/real-time-logs.mdx` |
| 7-day retention, 5 B/day, 256 KB/log | `docs/workers/observability/logs/workers-logs.mdx` |
| `[vars]`, dashboard Deploy step, per-environment vars | `docs/workers/configuration/environment-variables.mdx` |
| `wrangler secret put` deploys immediately, `versions secret put` | `docs/workers/configuration/secrets.mdx` |
| Secrets and env vars are the same thing at runtime | `partials/workers/env_and_secrets.mdx` |
| Worker request pricing, WS Upgrade = 1 request, WS messages free | `docs/workers/platform/pricing.mdx` |
| Broadcast written as a `for` loop | `docs/durable-objects/best-practices/rules-of-durable-objects.mdx` |
| Proxied WebSockets on all plans, idle timeout, CF restarts terminate WS, keepalive advice | `docs/network/websockets.mdx` |
| 400 s keep-alive, 900 s proxy idle | `docs/fundamentals/reference/connection-limits.mdx` |
| Tunnel WebSocket support, large-file terms | `docs/cloudflare-one/faq/cloudflare-tunnels-faq.mdx` |
| `cloudflared` outbound-only, nearest data center | `docs/cloudflare-one/networks/connectors/cloudflare-tunnel/index.mdx` |

Non-Cloudflare-docs sources:

- DO object-list API shape — [`cloudflare/cloudflare-go`](https://github.com/cloudflare/cloudflare-go) @ `main`, `durable_objects/namespaceobject.go`
- Droplet pricing — [digitalocean.com/pricing/droplets](https://www.digitalocean.com/pricing/droplets)
- Cloud server specs (prices unavailable) — [hetzner.com/cloud/cost-optimized](https://www.hetzner.com/cloud/cost-optimized/)
- Architecture context — jump-n-bump issues [#3](https://github.com/philipdzierzon/jump-n-bump/issues/3), [#6](https://github.com/philipdzierzon/jump-n-bump/issues/6), [#7](https://github.com/philipdzierzon/jump-n-bump/issues/7), [#23](https://github.com/philipdzierzon/jump-n-bump/issues/23)
