# Plan review verdict — #91

**VERDICT: APPROVE WITH CHANGES.** The hoist is safe — `Sound_Player` owns nothing per-match, and
every load-bearing line number in `src/` is exact. The changes below are corrections to the plan's
*justification and risk list*, not to its code.

## MUST FIX

1. **The "existing suite asserts the next match opens on its music" claim is wrong.** §1 and §5 both
   cite `test/browser.test.mjs:1294-1298`. That assertion (really `:1295-1299`) is the **first** match
   of the `sound()` page — a fresh page, fresh session. The walk's second match (`:1333-1340`) calls
   `forget_sounds()` and then asserts only `jump.mp3`; **nothing in the suite asserts a second match
   restarts the track.**
   Criterion 4's narrowing is still defensible, but the real reason is the **session boundary**:
   `end_match()` (`viewmodels.js:544`) nulls the session on the way out of `#play`, and `apply_route`
   (`:928`) builds a new one on `#room`, so a lobby visit gets a new player and rewinds the music.
   Correct this before it is repeated in the PR body. **No code change.**

2. **Add to the risk list: the hoist deletes one property.** Today an outgoing `Game` that kept
   pumping past `game.pause()` would fire its one-shots into the *old, muted* player and be
   inaudible. With one player per session it fires into the live one, so **a stale simulation becomes
   audible rather than silent**. `game_session.js:172` `game.pause()` is the only thing preventing it
   (as it already is for the shared `player[]` array), so not a blocker — but it is the one property
   the hoist removes and it belongs in the risks section.

## SHOULD FIX

3. **Test-file citations drifted 1-3 lines** (`src/` citations are all exact):
   `:1294-1298` -> `:1295-1299`; `:1357-1362` -> `:1360-1364`; the "A match builds one Sound_Player"
   sentence starts on `:93`, not `:94`.
4. **§4 undersells the construction move.** A session that never plays a match (a lobby visit with no
   match; a reconnect landing in the lobby via `viewmodels.js:786-791`) now costs 7 elements where
   master cost 0. Still bounded by lobby visits, still far slower than #91's leak — but say that
   rather than calling it "strictly earlier preloading".
5. **The red/green run is non-optional.** `bumps <= 1` is the weaker of the two new assertions
   (autoplay-dependent); **`audio_made` is the one that must be seen red on master.**

## VERIFIED CORRECT (do not re-derive)

- `sound_player = new Sound_Player(muted)` at `game_session.js:269`; `var sound_player = null` at
  `:92`. `:269` is the session's only reference and overwriting it is the whole "release".
- **`Sound_Player` holds exactly `sounds` (6 fixed `src`s), `sfx_extension`, `muted`.** No `player[]`,
  no objects, no one-shot/pending state. The only per-match residue is on the bump element (`loop`,
  `currentTime`), which Edit C covers. **Hoisting is correct.**
- Session `muted` and player `muted` cannot diverge: `key_action_mappings["M"]` (`:433-434`) flips
  both, and `play()` (`:361`) re-syncs with `set_muted(muted)` on every entry. `viewmodels.js:568`
  passes `false`, per session — unchanged by the hoist.
- **Repair path traced end to end:** `on_start` (`:158`) -> `get_level` (`:189`) -> `build` (`:265`)
  -> `on_match_start` (`:293`) -> `viewmodels.js:597` -> `go("play")` -> hash already `#play` so
  `apply_route()` runs by hand (`:418`) -> `route.screen === "play"`, so **no** `end_match()`, **no**
  `session()` -> `:931 start()` -> `sfx.music()`. No new `Game_Session` on a repair; the session
  survives it.
- **Criterion 4 is unguaranteed today.** `play_sound` does `audio.currentTime = 0` unconditionally
  (`sound_player.js:42`) on a brand-new element, so a repair **does** restart the music from zero
  today. Edit C is required, not gold-plating.
- **`bump` is the only looping sound**: `sfx.js:15` is the sole `loop`-true caller, `Sfx` the sole
  `play_sound` caller, and nothing outside `game_session.js`/`sfx.js` touches `Sound_Player`
  (repo-wide grep; `replay.test.mjs` imports neither). The guard cannot swallow a legitimate replay,
  and cannot leave silence: `set_muted(false)` in `play()` re-`play()`s anything with `loop` set
  (`sound_player.js:31`), and `sfx.music()` is always followed by `play()` at `:423-424`.
- `record_audio` (`:98-111`) adds to `__audio` only inside the patched `play()`, so a silent leak is
  invisible to it. `Sound_Player` is the only `createElement("audio")` site in `src/` (3
  `createElement` calls total), so a counter in `record_audio` is the right place.
- No extra wait needed: `get_level("default")` is `Promise.resolve(create_default_level())`
  (`viewmodels.js:244`), so `build()` runs in a microtask, ahead of the 250 ms `sample_chrome` that
  raises `.reconnecting`.
- Removing the null guards at `:177` and `:413` is safe — `on_start` is only assigned at `:158`, long
  after `:92`, and `stop()` can no longer see a null player.
- **Existing assertions survive**: `:837`, `:900`, `:971`, `:1368` all rest on `stop()`/`on_start`
  still calling `set_muted(true)` (kept); `:1295-1299` is a fresh session with `loop === false`, so
  the guard does not fire; `:1360-1364` untouched.
- **Ponytail**: the hoist is a net deletion versus a `release()` method — the higher rung. Both
  `ponytail:` comments name a real ceiling with a real upgrade path. Warranted, not noise.

## Carried forward (do NOT widen this issue)

The plan flagged a separate, much slower leak: **sound players still accumulate one per lobby visit.**
That is a follow-up issue, not part of #91.
