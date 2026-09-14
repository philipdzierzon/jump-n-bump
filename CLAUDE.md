# CLAUDE.md

HTML5/canvas port of Jump 'n Bump. Build with `npm run build` (webpack, `src/` → `game/`),
then open `game/index.html` directly — there is no dev server, no test suite and no linter,
so verification is manual: build, open, play.

Architecture notes for this port, and for the sibling C original it was translated from,
live in the workspace-level `CLAUDE.md` one directory up (`sbx/jumpnbump/CLAUDE.md`).

## Agent skills

### Issue tracker

GitHub Issues on `philipdzierzon/jump-n-bump`, driven through the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical roles, each label string equal to its name. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
