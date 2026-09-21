# Plan review verdict — #95

**VERDICT: APPROVE WITH CHANGES.** The mechanism is right, the trace holds, ~8 production lines is
the correct rung. Two corrections are about what the fix is *for*, not how it works.

## MUST FIX

1. **The plan gets the severity BACKWARDS. The narrowing is wrong for the case the issue names.**
   Measured: the default map has **56 valid spawn cells of 352**; `position_player` takes ~6.3 draws
   per bunny, ~25 per match. A one-tile change alters the spawn validity of at most **2 cells** (the
   tile itself, and the tile above it via the floor test), so
   `P(one-tile diff perturbs the spawn RNG at tick 0) ~= 1 - (1 - 2/352)^25 ~= **13%**`.
   Not "most". A **wholly different** level under one name desyncs at tick 0 — near-certain, and
   rare. An **edited** level under the same name — a few tiles moved by a deploy, which is exactly
   the AC3 scenario — is caught at tick 0 **roughly one time in eight**, and otherwise only when a
   bunny happens to touch the tile.
   **So the bug is WIDER than the plan concedes, not narrower.**
   Replace "most differing ban maps already diverge at tick 0" with the split: *a different level is
   usually caught today; an edited one usually is not, and the stale-asset case is the edited one.*
   **Carry that into the PR body** — the current wording invites a reviewer to reject the fix as
   unnecessary.

2. **A stale-cache client is ejected from every match forever and is never told to reload.**
   `levels[name]` is deleted only on *fetch failure* (`viewmodels.js:255-260`); a successfully
   resolved stale promise is held for the tab's lifetime. Chain: eject from match 1 -> keep seat ->
   match 2 builds from the same stale `level_hash` -> eject again -> forever. "Eject from the match,
   never from the room" is honoured on paper and **violated in effect**.
   Fix is one clause, not a feature: `src/interaction/scores_viewmodel.js:69-73`, append to the
   desync string something like *"If it keeps happening, reload the page."* — the same instruction
   `unavailable()` already gives at `viewmodels.js:236`. Zero new state, zero new message, and it is
   the only thing in the plan that gives the stale client a way out. **Add it to §3.2**, which
   currently says "no code".

## SHOULD FIX

3. **§4.1's chosen tile contradicts its own comment.** Row 7 index 11 is `'0'` (VOID) — the hash
   assertion is sound. But row 6 index 11 is **also** VOID, so flipping (11,7) to SOLID makes
   **(11,6) a newly valid spawn cell**. That tile *does* change the spawn accept/reject. Drop the
   comment "exactly the kind of difference a bunny may not touch for minutes", or pick a tile with a
   non-VOID cell above it.
4. **§1.2's cache claim is factually wrong (harmlessly).** `express.static` with no options
   (`server/index.js:1201`) sends `Cache-Control: public, max-age=0` — not "no `max-age`". The
   conclusion survives (max-age=0 forces revalidation, so the window is only behind a CDN/proxy/SW),
   but state it right; §3.3 already has the honest version.
5. **`LEVEL_WIDTH` is NOT "already imported."** `test/replay.test.mjs:14` imports only
   `default_ban_map` from that module. The named export must be added; `BAN_SOLID` from
   `src/game/level.js` is a new import line.
6. **§2.4 reason 1 is overstated.** `preload()` (`viewmodels.js:283`) warms the cache the moment the
   lobby names a level, so a client's ban map may well be resolved before `start`. The adjudication
   still stands on reason 2 alone (`image`/`mask` still arrive by fetch) plus the relay having
   nothing — soften reason 1 rather than leaning on it.
7. **Nothing tests the production wiring.** `game_session.js` needs the DOM, so `hashed_after`
   re-implements the chaining expression by hand. That matches precedent (`replay.test.mjs:474` does
   the same for today's checksum) and is acceptable — just **don't claim AC5 covers the
   `game_session.js` line**.

## VERIFIED CORRECT (do not re-derive)

- `level.image`/`level.mask` **never reach `src/game/`** — the only `image` hits there are
  `obj.image`, a sprite-frame index from `animation_data`. `SET_BAN_MAP(level.ban_map)` at
  `src/game/game.js:36` is the simulation's entire level dependency. **AC4 is satisfiable.**
- `checksum_snapshot` is at `src/game/snapshot.js:154` exactly as quoted. Four call sites —
  `replay.test.mjs:434, 474, 479, 516` plus `game_session.js:87` — all single-argument; a defaulted
  `seed` leaves every one **byte-identical**.
- All **11** `start()` call sites in `replay.test.mjs` pass <=4 args, so a defaulted 5th `ban_map`
  param touches none. The file's own golden `fnv1a`/`checksum` (`:28-66`) is a separate hash, untouched.
- `room.checksum` is wired at `game_session.js:85-88`; the `build()` insertion point is real (`:251`
  guards, `:252` `var t1`, `:253` `rnd = make_rnd`). Placing the assignment **after** the guards is
  right: an early return leaves `level_hash` and the module-level `ban_map` both on the old level, so
  they stay consistent.
- `var` hoisting makes the `level_hash` declaration at ~:96 legal in the closure at `:87` — the same
  pattern `objects`/`rnd` already use.
- **The chain reaches the relay**: `room.js:269-270` sends `{type:"checksum",t,h}`, guarded by
  `if (!catching_up)`, and `server/index.js:844` compares `reference.h !== msg.h`. **Zero relay
  changes needed — confirmed.**
- `player.js:53-62` is rejection sampling against `GET_BAN_MAP`, as claimed.
- **Repair is structurally impossible**: a repair re-enters `on_start` -> `get_level` -> `build`, and
  `get_level` (`viewmodels.js:241-264`) returns the same cached promise. `resume()` replaces
  players/objects/RNG only.
- `MAX_REPAIRS = 5` (`server/index.js:82`), `repair_cooldown_ms` 2000 (`:65`), `repair_reset_ms`
  30000 (`:81`) — a 0.5s desync cadence never trips the reset, so ejection at ~10-12s is real and
  reachable. `keep_snapshot`'s `resume(other)` at `:760` does not spend a repair. `drop_from_match`
  (`:915`) keeps the seat.
- `.dat` ban maps are 374 (352 dense + 22-entry `BAN_SOLID` sentinel, `dat_level_loader.js:67-70`);
  `default_ban_map()` is 352 with no holes. Different lengths hash differently. No sparse-array hazard.
- `CUSTOM` is local-room-only (`viewmodels.js:178`, `:1165-1176`) and local rooms leave
  `room.checksum` null.
- `relay.test.mjs:766-1000` already covers host-reference comparison, repair, the not-yet-repairable
  case and `match_end reason:"desync"` (`:876`); `router.test.mjs:86` covers the wording. **Agreed —
  no new relay test.**
- The `{type:"level",h}` alternative is correctly rejected; seeding the existing checksum genuinely
  avoids a second hashing scheme. `ponytail:` comment warranted.
