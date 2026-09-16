# CLAUDE.md

HTML5/canvas port of Jump 'n Bump. Build with `npm run build` (webpack, `src/` → `game/`),
then open `game/index.html` directly — there is no dev server and no linter, so rendering,
sound and input are verified manually: build, open, play.

`npm test` runs `test/replay.test.mjs`: the simulation replayed twice from one seed and one
input log, with no DOM, hashed to an FNV-1a checksum. Anything that makes the simulation
depend on wall-clock time, the environment or unseeded randomness fails it. Node runs
`src/` directly, which is why every relative import carries its `.js` extension.

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
