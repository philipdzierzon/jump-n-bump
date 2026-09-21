# Plan review verdict — #96

**VERDICT: APPROVE WITH CHANGES.** The premise checks out on every point, the seam claim is correct,
the pairing argument is sound. Four corrections, none structural.

## MUST FIX

1. **`record_checksums` must keep the FIRST hash per tick, not overwrite.** `hashes.set(msg.t, msg.h)`
   lets a later frame for an already-recorded tick clobber an earlier one. AC2 asserts
   `deepEqual(disagreements(...), lied)` — exact in both directions — so a single re-emission of a
   lied tick silently turns that assertion **green for the wrong reason**.
   Change to `if (!hashes.has(msg.t)) hashes.set(msg.t, msg.h);`. Two words, removes the whole class.
2. **AC4 must include `CLAUDE.md:70-72`.** Confirmed present: *"Nor do the two pages agree tick by
   tick: that needs a checksum the client exposes to a test, which it does not (#41)."* It becomes
   false with the same commit. **In scope — make the edit, don't just flag it.**
3. **The "red for a real reason" instruction is incomplete and needs a STOP.** "Don't weaken the
   assertion" is right but does not say whether a red PR may be opened. **It may not.**
   If `disagreements(...)` is non-empty on unmodified `master`: **stop before opening the PR**,
   capture the failing ticks and both hashes, keep `trace-host.zip`/`trace-guest.zip`, file the
   finding against #81, and **report back rather than opening a PR that leaves CI red.** Whether the
   assertion lands as a known-failing guard or waits on the fix is a **maintainer call**.
4. **Two lies should be ONE.** Each lie the relay sees triggers `desync()` -> a `start` carrying a
   snapshot -> `on_start` refetches the level, unpacks, and `catch_up` replays
   (`game_session.js:157-160`). Two lies means up to two full rebuilds inside the AC2 `until`'s 10 s
   budget. One lie proves capability identically (`disagreements` = `[t]`) and halves the churn.

## SHOULD FIX

5. **Tick 0 is a vacuous sample.** Both pages hash tick 0 before any `game_iteration`, from the
   relay's seed and the same level — it agrees by construction. So `paired().length >= 3` buys **two**
   meaningful samples (30, 60), not three. Either say so in the comment or raise the AC1 floor past 0;
   don't claim "a second and a half of match" when the first sample is free.
6. **The AC3 window boundary is the host's latest sample, not the repair instant.**
   `Math.max(...host_hashes.keys()) + 1` is conservative in the right direction, but if the guest
   crossed a multiple of 30 the host had not yet, one pre-leave guest sample lands inside the window.
   Harmless, but §3's "post-repair by construction" is really "post-*host's-last-pre-repair-sample*".
   Reword, or key off `guest_hashes`.
7. **Name the flakiest assertion**: AC2's `until(...)` — with a repair provoked mid-window, the guest
   must rebuild and replay inside 10 s. MUST FIX 4 is the mitigation. Everything else sits behind a
   genuine frame-arrival condition.

## ON AC2 — the adjudication (KEEP THE HASH LIE)

**Do not ask for real-state divergence.** AC2's text is *"A deliberately diverged client fails the
assertion — the test is shown to be capable of failing."* The clause after the dash is the
requirement, and the hash lie satisfies it exactly: it proves the recorder, the pairing and the
assertion go red on a disagreement, which is what this test is responsible for.
`replay.test.mjs:514-518` covers state->hash headlessly; this walk covers hash->assertion; the chain
is complete across the two. Real divergence in the browser means dropping an inbound `input` frame
and then racing `desync()`'s own repair — a timing dependency in exactly the test meant to have none,
and `server/index.js:841`'s `resync_t` gating makes the window worse, not better.
**Requirement:** the `ponytail:` comment stays, and the assertion message keeps its honest wording
(*"a client **reporting a hash** that is not the host's fails this assertion"*) — **not** "a diverged
client". Do not let it overclaim.

## VERIFIED CORRECT (do not re-derive)

- `room.checksum` declared `src/net/room.js:88`; sent `:269-270`, `tick % CHECKSUM_TICKS === 0`,
  `CHECKSUM_TICKS = 30` at `:13`, inside the `if (!catching_up)` at `:254`.
- Session installs it at `game_session.js:85-88` over
  `checksum_snapshot(pack_snapshot(rnd, objects, t))`; `config.local` is `!self.room_id()`
  (`viewmodels.js:563`), so **host and guest both hash**.
- `pack_snapshot` writes `tick` at `out[0]` (`snapshot.js:63`) and the message is keyed `t: tick` —
  an equal key is an equal moment. **Pairing by tick is the only correct comparison; AC1 is not
  weakened by it.**
- `replay.test.mjs:474` installs the identical expression; `:514-518` asserts
  same-state-same-hash / 150-ticks-behind-different-hash. Same `checksum_snapshot` from
  `snapshot.js:154`.
- **Lookalike warning is real and load-bearing**: `replay.test.mjs:39` is a *different*
  `checksum(objects)` — hand-rolled FNV over a field list, `>>> 0`. Confusing the two makes the test
  meaningless.
- `WebSocket_Transport.send` is `socket.send(JSON.stringify(msg))` (`websocket_transport.js:61-62`),
  prototype-resolved at call time, so the init-script patch lands.
- The `framesent` recorder exists at `browser.test.mjs:155-163` — **but it is bound to the single
  flow `page`, not to host/guest.** The plan's helper attaches new listeners, which is correct;
  §1e's "the suite already reads the wire" is true as *technique*, not as existing coverage of these
  two pages. **State it that way in the PR.**
- `addInitScript` precedents: `record_audio` at `:98-111` via `make_context:120`; socket keeper at
  `:1577-1587`.
- **AC3's pause is real**: `go_lobby` (`viewmodels.js:992`) -> `leave_match` -> `game.stop()` (`:536`)
  -> session `stop()` -> `game.pause()` (`game_session.js:413`, `game.js:175` sets `playing = false`).
  The guest genuinely hashes nothing in the lobby. Both repairs confirmed at
  `browser.test.mjs:1183-1206`.
- `until()` (`:187-192`) polls a condition for ~10 s and `assert.fail`s — not a sleep, not a retry.
  AC5 holds.
- Scope clean: nothing touches `snapshot.js`, `room.js`, `server/index.js`; no desync fixes; no
  AI-bunny load test.
- **Zero production lines change — true, and worth stating plainly in the PR.** The checksum is
  already JSON on the wire and Playwright reads the wire; the client grows no hook.
