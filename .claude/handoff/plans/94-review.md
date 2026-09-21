# Plan review verdict — #94

**VERDICT: APPROVE.** No blocking changes. Apply these four non-blocking corrections when implementing:

1. **Loosen the `[9]` assertion.** The plan's `t: 9` justification covers `room.due` but not `substitute()`, which also broadcasts `{type:"input"}` frames to the room (`server/index.js:727-728`) once `room.tick` advances. The assertion does pass, but for a reason the plan never states. Use instead:
   `assert.ok(guest_heard.some((msg) => msg.type === "input" && msg.t === 9), ...)`
   — survives any future change to substitution timing and asserts exactly what AC3 asks.

2. **Drop the `ponytail:` marker on the new `catch`.** "One console line per dropped frame might be noisy" is not a ceiling anyone will pay down — it is the same `/ponytail-debt` ledger noise the plan itself objects to two paragraphs later. Keep ONE short sentence of *why* (the relay guards its parse; this is the asymmetry). Cut the rest: a 5-line comment block is longer than the code it guards.

3. **Line-number nits.** The quoted `server/index.js` block spans **1223-1232**, not 1223-1231 (the `switch` is 1232). `COUNTDOWN_MS` is *set* at `:379` and `:463` and *deleted* only at `:511` — not three set/delete pairs.

4. **Claim narrowing.** "`console.log` printf is the codebase's only reporting idiom" holds for `src/` and `server/` (zero `console.warn`/`console.error` there) but NOT repo-wide: `test/browser.test.mjs:1711-1723` uses `console.error`. Immaterial to the choice; don't restate the broader claim in a comment.

## Verified correct (do not re-derive)

- `src/net/websocket_transport.js:21` unguarded `JSON.parse(event.data)` in `socket.onmessage` (assigned `:20`); dispatch branches `:23/:28/:33/:36/:42`.
- It is the ONLY unguarded parse in `src/` — the other hit, `viewmodels.js:73`, is inside `recall`'s try/catch (`:71-77`). (`server/smoke.mjs:44` is relay tooling, out of scope.)
- `server/index.js:1223-1232` guards its parse exactly as quoted, bare `catch { return; }` included.
- `src/net/loopback_transport.js` neither serialises nor parses — `send` switches on a live object (`:31-68`), `to_client` hands one straight to the listener (`:16-18`). No hole there.
- **`catch {` cannot be used.** `.babelrc` is `{"presets":["env"]}` on babel-core 6.26.3; `babel.transform("try{}catch{}")` fails `Unexpected token, expected (`. Every `catch` in `src/` is `catch (e)`. No browserslist, so preset-env targets everything.
- `websocket_transport.js:48-49` is exactly the stale two-line `ponytail:` comment the issue names. `11292f3 (#42/#75)` shipped all three things it lists; `viewmodels.js` now branches on `"DISCONNECTED"` -> `lost_connection()` (~:801-811), reclaims the frozen match (~:787-791), handles `SEAT_TAKEN` (~:821-824). Delete BOTH lines, no replacement.
- Test mechanics: `"PARSE"` is a legal room id (5 chars, no I/O) and unused elsewhere in `test/relay.test.mjs`; `COUNTDOWN_MS` is read per call (`server/index.js:34`) so setting it mid-file works; `pressed` at `:277`, `connect`/`lobby` in scope at the insertion point; `server.close()` at `:1526`.
- Subclassing `globalThis.WebSocket` for one `connect()` is the smallest seam — `socket` is closure-private; no accessor exists or should be added. Verified on node 22 that the assigned `onmessage` is retrievable and directly callable, so `raw.onmessage({data:"{"})` throws synchronously at `af04c21` (loud red) and returns quietly after the guard. Restore the global immediately.
- Determinism risk nil: nothing in `src/game/` touched.
