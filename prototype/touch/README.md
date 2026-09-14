# Touch control prototype (issue #9) — THROWAWAY

Three touch control schemes over the *real* game, so the feel question gets answered on an
actual phone rather than on paper. Switch live with the pill at the top; `?variant=A|B|C`
and `?swap=1` are shareable.

| Variant | Steering | Jump | Dead zone |
| --- | --- | --- | --- |
| **A** invisible halves | steer half split in two fixed quarters | anywhere on the jump half | none — hard split |
| **B** thumb anchor | relative to wherever the thumb landed; slide without lifting | anywhere on the jump half | ±14 px around the anchor |
| **C** visible buttons | two 80 px ◀ ▶ pills, fixed | one 104 px ▲ circle | everywhere outside the buttons |

`swap hands` mirrors which half steers. The HUD shows the live `{left, right, up}` the
simulation actually receives, the most simultaneous touches seen, and a jump-while-moving
counter — the input that must never drop.

## How it works

The overlay never touches game code: it calls `document.onkeydown/onkeyup` with player 0's
arrow keycodes, which is exactly what `keyboard.js` listens to. It also flips players 2 and 3
to AI on start so there is something to bump.

```sh
sh prototype/touch/build.sh   # webpack, then game/index.html body + overlay -> artifact.html
node prototype/touch/test.js  # multi-touch correctness for all three variants
```

`artifact.html` is published as an Artifact to get a URL onto a phone.

One non-throwaway change rode along in `src/interaction/renderer.js`: `resize_canvas` floored
the scale to **0** on any viewport under 400×256 CSS px (every phone in portrait), leaving a
0×0 canvas. Now clamped to 1, with CSS doing the upscaling.
