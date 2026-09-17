# CLAUDE.md

HTML5/canvas port of Jump 'n Bump. Build with `npm run build` (webpack, `src/` → `game/`),
then open `game/index.html` directly — offline play needs no server, and there is no linter,
so rendering and sound are verified manually: build, open, play.

Online play needs the relay in `server/`, which has dependencies of its own: `npm ci` in
`server/` once, then `node server/index.js` from anywhere serves the built client and the
WebSocket on one origin at `:8080`. `server/smoke.mjs` proves that end to end, and the
`Dockerfile` is how it actually ships.

`npm test` runs four files. `test/replay.test.mjs` replays the simulation twice from one seed
and one input log, with no DOM, hashed to an FNV-1a checksum: anything that makes the
simulation depend on wall-clock time, the environment or unseeded randomness fails it.
`test/relay.test.mjs` boots the real relay on a real socket and drives the protocol through
it. `test/router.test.mjs` covers the two pure pieces of the room flow -- which screen a
hash names, and which control scheme a jump key belongs to. `test/dom.test.mjs` walks the
rest of that flow in jsdom: it loads `src/jnb.html`, imports `viewmodels.js` so Knockout
binds for real, and clicks and types its way from the landing screen through the couch,
the lobby, a match and the board, then does it again through a relay on a real socket.
Node runs `src/` directly, which is why every relative import carries its `.js` extension.

What the DOM test cannot see is what is still verified by opening the page: jsdom has no
2d context (stubbed with a no-op, so the renderer runs but paints nothing) and no media
playback, so pixels and sound stay manual.

Architecture notes for this port, and for the sibling C original it was translated from,
live in the workspace-level `CLAUDE.md` one directory up (`sbx/jumpnbump/CLAUDE.md`).

## Agent skills

### Issue tracker

GitHub Issues on `philipdzierzon/jump-n-bump`, driven through the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical roles, each label string equal to its name. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

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
