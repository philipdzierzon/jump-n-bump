# Plan review verdict — #82

**VERDICT: APPROVE WITH CHANGES.** The plan is sound; apply these before/while implementing.

## MUST FIX (blocking)

1. **The two `room`-message assertions read the wrong array and will throw.**
   `room` and `joined` never reach `socket.receive` — `src/net/websocket_transport.js` routes
   `case "joined"` / `case "room"` to `on_room` (the `connect()` recorder -> `client.events`), and
   only the `default` branch to `listener` (-> `host_saw`). So
   `forged.host_saw.filter((msg) => msg.type === "room")` is always `[]` and `.pop().labels` /
   `.pop().started` is a `TypeError` on `undefined`.
   The existing driver test already does it right (`test/relay.test.mjs:296-298` uses `sender.events`).
   **Change both to** `forged.host.events.filter((msg) => msg.type === "room").pop()`.

2. **The password test passes against `af04c21` — it tests nothing.**
   Today both sides do `msg.password || null` with no coercion, so `create` with the *number* `1234`
   and `join` with the *number* `1234` compares `1234 !== 1234` -> false -> joins fine.
   The real break is **create-with-number / join-with-string**, which is what a real client sends
   (`viewmodels.js:864,1024` pass a ko observable, always a string).
   **Change the joiner to `password: "1234"`** (and `mistyped` to `"9999"`). That is
   `ROOM_UNAVAILABLE` before the fix and `joined` after.

## SHOULD FIX

3. **AC9 deletion range is off by one at each end.** The stale paragraph is `server/index.js:73-76`;
   lines 72 and 77 are the `//` separators either side. Deleting 72-77 butts the "quiet period"
   paragraph against the `ponytail:` paragraph with no separator, against the block's own style.
   **Delete 73-77.**

4. **Line-number drift in test anchors** (cosmetic): `pressed_key` is `test/relay.test.mjs:1066`
   (not 1065), `two_seats` is `:1048` (not :1046), the `../src/game/` import assertion is `:1268-1270`.

5. **AC3 behaviour note the plan misses.** Both client-side `end_match` senders are already
   host-gated (`viewmodels.js:589`, `:995-997`), so nothing real breaks — but the client's `host` is
   its own copy of the relay's flag, so during a host migration a client that still believes it is
   host now has its `match_end` dropped in silence instead of ending the match. Acceptable (the relay
   is authoritative); worth **one clause in the comment, no code**.

## VERIFIED CORRECT (do not re-derive)

- `case "input"` bounds `t` below only (`server/index.js:1088`), drops late at `:1097`, raises
  `room.tick = Math.max(room.tick, msg.t + 1)` at `:1102`. `substitute()` (`:688`) loops
  `while (room.due <= room.tick - room.d - 1)` with `driver_at` (`:664`) and `holder_of` (`:655`)
  linear scans per seat per tick and a `broadcast_frame` per iteration. **The hang is real.**
- `late`/`forged` are room counters at `:161-163`; the "counted per room, read from the log line"
  promise is at `:155-158`. Counting the new rejection as `forged` is consistent.
- `case "driver"` (`:1139-1141`), `case "match_end"` (`:1157-1163`), `case "pong"` (`:1233-1235`)
  have no check of any kind. `case "input"` DOES enforce `client.seats.includes(+seat)` and
  `room.forged++` on violation (`:1113-1114`) — the idiom to copy is real.
- The switch at `:1055-1165` has no `default`.
- `create` `password: msg.password || null` (`:115`), `join` `room.password !== (msg.password || null)`
  (`:190`), `host_config` `String(msg.password) || null` (`:1035`). Asymmetry and `!==` confirmed.
  **Coercing `join` too is required, not scope creep** — coercing `create` alone would break
  number-in/number-in.
- `MAX_CATCH_UP` is `export var` at `src/net/room.js:8` (comment 3-7). The ONLY importers of `room.js`
  are `game_session.js:19`, `test/relay.test.mjs:10`, `test/replay.test.mjs:16` — the last two take
  `Room` only. So the `game_session.js:19` import split is exactly what is needed and nothing else
  breaks. `room.js` has no imports today; `room_config.js` is pure data/functions and already in the
  bundle via `viewmodels.js:10`. `replay.test.mjs` determinism untouched.
- The stale comment at `:73-76` is the "#17's substitution is #42's to build" paragraph, and it is
  false — `substitute()` ships and is proven at `test/relay.test.mjs:1069-1100`.
- **AC2 — agreed, no separate index check needed.** Every write to `client.seats` yields integers
  `0..3`: `:416` (`free_seats()` map/filter of indices), `:490` (`msg.seat | 0` after `:475`'s range
  check), `:503` (`[]`), `:520` (index map/filter). `includes` is strict, so one expression covers
  ownership, range and the arbitrary-property write.
- **AC4 — agreed, no second guard.** `client.one_way` is written in exactly two places: `:1215`
  (init `0`) and `:1234` (the pong). `input_delay` (`:626-634`) is its only reader. A guard in
  `input_delay` would be dead code.
- **AC6 config-null change — safe and in scope.** No client sends a non-string
  (`viewmodels.js:1187` sends `self.new_password()`); no test depends on it — password tests at
  `:110-120` and `:588-605` all use strings, and clearing is tested with `""`, which `password_of`
  still maps to `null`.
- Test mechanics: **`MAX_CATCH_UP + 1` is right**, and `1e9` really would block the shared event
  loop. Without the fix `room.tick` becomes 3602 and `substitute` broadcasts a released `t: 0` frame,
  so `until_seen` resolves on the substituted frame and the `deepEqual` on `seats` fails readably.
  `FRGZX`/`PNGXZ`/`PWDXZ` all match `/^[A-HJ-NP-Z]{5}$/` (`src/net/room_id.js:8`) and are unused.
  `two_seats`/`until_seen`/`awaited`/`pressed_key`/`connect`/`lobby` all exist with the assumed
  signatures; `two_seats` does name its clients `Steady`/`Quiet`. Pong-ordering note is correct:
  `PING_MS = 1000` and client->relay order is preserved, so no real pong lands between the bad one
  and `start`.
- No existing test breaks: the driver test at `:296` sends from `other`, which holds seat 1 (`:272`)
  with `driver: "ai"` — passes both halves of the new guard. All three test `match_end` senders are
  hosts. `replay.test.mjs:183`'s `set_driver` is on a `Loopback_Transport` room, never the relay.
- Both new import lines fit `printWidth: 100` (93/94 chars).

**Ponytail: clean.** `password_of` earns its place at three call sites; `DRIVERS` in the shared
module is what AC5 literally asks for; declining to rewrite the `"ai"`/`"off"` literals as
`DRIVERS[n]` is right; both `ponytail:` comments name real ceilings with real upgrade paths.
