# CLAUDE.md

HTML5/canvas port of Jump 'n Bump. Build with `npm run build` (webpack, `src/` → `game/`),
then open `game/index.html` directly — offline play needs no server, and there is no linter,
so rendering and sound are verified manually: build, open, play.

Online play needs the relay in `server/`, which has dependencies of its own: `npm ci` in
`server/` once, then `node server/index.js` from anywhere serves the built client and the
WebSocket on one origin at `:8080`. `server/smoke.mjs` proves that end to end, and the
`Dockerfile` is how it actually ships. The site statistics (#46) are one SQLite row at
`STATS_DB` -- `:memory:` when unset, `/app/data/stats.db` in the image, which compose
bind-mounts from `./data/relay`, so backup is `tar` on `data/`. Operator metrics (#48) are
`/metrics` on a second listener at `:9090` (`METRICS_PORT`), never published and never routed
by the tunnel; they are live `jnb_*` gauges and counters out of memory, never SQLite, and no
label names a room. `compose.yaml` also runs Prometheus (`127.0.0.1:9090`, data in
`./data/prometheus`) and Grafana (`127.0.0.1:3000`, default admin/admin, one dashboard
provisioned from `monitoring/`), reached with `ssh -L 3000:127.0.0.1:3000`; while they run, a
relay started on the host needs `METRICS_PORT=0` (#49). An idle room (five minutes
without a key held) stops accruing minutes but is not closed.

`npm test` runs four files, and builds the client first because one of them opens a browser.
`test/replay.test.mjs` replays the simulation twice from one seed and one input log, with no
DOM, hashed to an FNV-1a checksum: anything that makes the simulation depend on wall-clock
time, the environment or unseeded randomness fails it. It is also where the match-end limits
are proved -- endless stays endless, and a bump or minute limit stops the match on the tick
the condition falls. `test/relay.test.mjs` boots the real relay on a real socket and drives
the protocol through it, several clients to a room. `test/router.test.mjs` covers the pure
pieces of the room flow -- which screen a hash names, which control scheme a jump key belongs
to, and the wording of the line above the board. `test/browser.test.mjs` walks the rest of
that flow in a real Chromium through Playwright: it opens the built page and clicks and types
its way from the landing screen through the couch, the lobby, a match and the board, then does
it again through a relay on a real socket. Node runs `src/` directly, which is why every
relative import carries its `.js` extension.

The browser itself is not in `node_modules`: run `npx playwright install chromium` once. By
default the suite boots its own server on a free port; with `JNB_BASE_URL` set it walks that
origin instead, which is how CI points it at the running container, so an asset missing from
the image fails the build. A failing run leaves a `trace-<context>.zip` behind for each
browser context it opened -- `npx playwright show-trace trace-flow.zip` replays the DOM, the
console and every action with timings. There are no retries: the simulation is seeded, so a flake is a real race worth a bug
rather than a rerun.

Two things a browser gives that jsdom could not, and that the suite now relies on: a click
refuses an element that is invisible, zero-sized, covered or still moving, and a `<details>`
panel really is closed until its summary is clicked. A fake clock stands in for the one thing
the browser took away -- the bundle exports nothing to reach into, so a match that ends by
itself is driven by fast-forwarding the one-minute time limit rather than by setting a bump
count from node.

Three more things a browser gives, all of them added in #66. **Two pages in one room**: a
browser context each, so storage is a player's own and the two never fight over one room
token, and what is asserted is that they agree -- the same seats and names, the same ready
flags, one countdown, `play` on both, and one final board row for row. **Sound**: the
elements really decode and really play, and every `play()` is recorded in order, so a sound
fired on the wrong event is caught. Chrome takes the **mp3s**, which jsdom's empty
`canPlayType` meant nothing had ever played. **Phone width**: a short second walk at 390x844,
landing through to the lobby, asserting the page never runs off the side.

A fourth walk, added in #42, **drops the socket under a live match**. Every `WebSocket` the
page opens is kept by an init script, so closing the last one is a real close the relay sees
as a real disconnect -- which is the point, since what is under test is the seat being held
and handed back. The page freezes under a `Connection lost` overlay, stays on `#play`, comes
back on the first retry a second later and is walked into the match it froze in. It then
walks to the lobby and presses **Take seat** on a bunny the AI is driving, which grows the
couch past the one participant it named at the names screen and hands it the match again.
The relay's own half of that -- the released frame it substitutes on its deadline, the seat
it gives the AI after thirty missing ticks, the frames it drops for being late or forged,
and a reservation that is exclusive to one token until it expires -- is `relay.test.mjs`'s.

A fifth, added in #141, **stalls the guest's uplink** through `test/lossy_proxy.mjs` while
the guest changes key, and asserts the two pages' checksums still agree with no repair: the
relay's frame for a tick the guest already stepped is rewound to from a one-second ring of
states. The seed is pinned with `clock.setFixedTime`, because a bunny that spawns against a
wall steps left and right alike.

A local room seeds itself from `Date.now() | 0`, so the sound walk pins the clock and plays a
known match: whether four bunnies bump each other inside a few seconds is the seed's
business, and a third of all seeds never do it at all. It then plays a second one with the
empty seats left empty, because `sfx.jump()` says a bunny jumped and not which -- alone in
the room, the only thing that can make a sound is the key this client is holding down, and
the silence after `M` is silence rather than a lull.

What the suite still does not check is what listening and looking check: whether the sound is
audible or at the right volume, whether the sprites look right, and a real autoplay block --
headless Chrome autoplays with no flag, so there is none here to reproduce. The two pages'
simulations are compared tick by tick, sampled three times across a match including after a
repair: #41's checksum is already a message on the wire, and the suite reads it off
`framesent` -- the client grows no hook for this (#96).

Architecture notes for this port, and for the sibling C original it was translated from,
live in the workspace-level `CLAUDE.md` one directory up (`sbx/jumpnbump/CLAUDE.md`).

## Agent skills

### Issue tracker

GitHub Issues on `philipdzierzon/jump-n-bump`, driven through the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical roles, each label string equal to its name. See `docs/agents/triage-labels.md`.

### Coding standards

Prefer the laziest solution that works: standard library before custom code, native
platform features before dependencies, one line before fifty. Question whether a piece
of work needs to exist at all. This repo is a hand-port of a 1998 DOS game with no test
suite, no linter and no framework — keep it that way unless there's a concrete reason not to.

Enforced by the `ponytail` plugin (`/ponytail` to set intensity, `/ponytail-review` on a
diff, `/ponytail-audit` on the whole tree). Intensity is a runtime mode, not repo config,
so there is nothing to configure here.

Deliberate shortcuts get a `ponytail: <ceiling>, <upgrade path>` comment at the point of
the compromise, e.g.:

```js
// ponytail: assumes 4 players max, same as the C original. upgrade path: read the count
// from the level header if we ever support more.
```

`/ponytail-debt` harvests those into a ledger so a deferral can't quietly become permanent.
The `code-review` skill reads this section as the repo's documented coding standards.

### Implementation workflow

One worktree per implementation, and never on `master`:

```bash
git worktree add .claude/worktrees/<issue> -b <issue>-<slug> master
cd .claude/worktrees/<issue>
ln -s ../../../node_modules node_modules          # deps are not copied into a worktree
ln -s ../../../../server/node_modules server/node_modules # `npm test` boots the real relay
```

Those two symlinks share one `node_modules` with `master`, which is the wrong thing for a
branch that changes dependencies or builds the image: `npm install` there prunes what
`master` still needs, and Docker's context walker follows the `server/node_modules` symlink
into a loop and refuses to build. Install into the worktree itself in that case -- delete
both links, then `npm install` and `npm ci --prefix server`.

`.claude/worktrees/` is git-ignored and Prettier-ignored, so a sibling worktree is never
committed and never formatted: the pre-commit hook checks the whole of the tree it runs
in, which in a worktree is that branch's changes and nothing else. Format and test from
inside the worktree.

When the work is done: commit on the branch, `git push -u origin <branch>`, then
`gh pr create --base master --fill` (see `docs/agents/issue-tracker.md` for the `gh`
conventions, and reference the issue the work came from).

**Never merge a PR.** Merging is the maintainer's call, on the maintainer's word --
finishing the work means an open PR, not a merged one. The worktree stays until then, so
review comments can be answered in it; `git worktree remove` once the PR is merged or
closed.

### Formatting

Prettier, pinned exact (patch releases change output, and a reformat-everything diff is
not a CI failure anyone wants to read). `npm run format` writes, `npm run format:check`
is the CI gate. There is no linter and no style debate: if Prettier accepts it, it ships.

`.prettierrc` deviates from the defaults in two places only:

- `tabWidth: 4` — the existing hand-port indentation, kept so the JS stays visually
  line-for-line with `main.c` in the `jumpnbump/` tree.
- `printWidth: 100` — the defaults' 80 rewraps ~200 lines of that port for no gain.

JSON and YAML override back to 2 spaces: npm copies `package.json`'s indent into
`package-lock.json`, so 4 there churns the entire lockfile on every install.

`.githooks/pre-commit` blocks an unformatted commit. It is a two-line shell script, not
husky — `npm install` runs a `prepare` script that points `core.hooksPath` at `.githooks`,
which is all husky does. It checks the whole repo rather than the staged files: that takes
under a second, so a WIP file you did not stage can block the commit. `git commit -n` skips
it; CI does not.

`.prettierignore` covers `game/` and `prototype/` (checked-in assets and build output)
and `src/jnb.html` — Knockout markup with whitespace-sensitive bindings and no automated
rendering check to catch a bad reflow. Format that one by hand.
