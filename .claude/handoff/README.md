# Handoff: the #81 issue chain

**Date:** 2026-09-21 · **Repo:** `philipdzierzon/jump-n-bump` · **Base:** `master` at `af04c21`

Implementation of the fifteen issues (#82–#96) cut from the #81 audit. Seven shipped as a
stacked PR chain; eight remain, **all of them planned and plan-reviewed** — the expensive
thinking is done and is in this folder.

## What is in here

| Path | What it is |
| --- | --- |
| `plans/<n>-plan.md` | The implementation plan for issue `<n>`, written under ponytail **ultra** |
| `plans/<n>-review.md` | An independent review of that plan, verified against source |
| `issues/<n>.md` | The issue body as fetched, so a picker-up need not re-fetch |
| `FINDINGS.md` | Everything found that is **not** in scope of the issue that found it |

**The `-review.md` files are the operative documents.** Each plan was checked line by line by a
second agent against real source; several plans were materially wrong and the review says how.
A `MUST FIX` in a review is binding. Each review also carries a **VERIFIED CORRECT** section —
claims already checked against source, which a picker-up should trust rather than re-derive.

## Shipped — seven stacked PRs, none merged

Each PR's base is the previous PR's branch. **Do not merge out of order**, and review from the
bottom up.

| PR | Issue | Branch | Base |
| --- | --- | --- | --- |
| #97 | #82 relay message authorisation | `82-relay-message-authorisation` | `master` |
| #98 | #83 bound the catch-up batch | `83-pump-bounded-batch` | `82-…` |
| #99 | #84 per-match `Room` state | `84-room-across-match-boundary` | `83-…` |
| #100 | #85 release keys on blur | `85-release-keys-on-blur` | `84-…` |
| #101 | #91 one sound player per session | `91-one-sound-player-per-session` | `85-…` |
| #102 | #94 guard the client's parse | `94-guard-client-parse` | `91-…` |
| #103 | #95 level ban-map hash | `95-level-ban-map-hash` | `94-…` |

All green on CI at the time of writing. Every one was implemented under ponytail **full**, code
reviewed by an independent agent, and its tests verified to **fail before the fix**.

## Remaining — eight issues, planned and reviewed, not implemented

Ordered so no two fight over one file. Blocker edges: `92<-82`, `93<-82`, `86<-85`, `90<-88`
— all four blockers have shipped, so **every one of these is unblocked**.

| # | Issue | Verdict | Notes for the picker-up |
| --- | --- | --- | --- |
| 92 | snapshot / input-ring bookkeeping | APPROVE W/ CHANGES | **4 blocking fixes**, incl. a test that hangs `npm test` forever and a `prune` that is not equivalent to the filter it replaces. Read the review before the plan. |
| 93 | repair allowance survives reload | APPROVE W/ CHANGES | Lands after #92 on the same file; rebase. AC4 needs **no code**. |
| 86 | input edge latch | APPROVE W/ CHANGES | Needs a decision on the lobby-latch window (a key tapped in the lobby fires on the match's first tick). AC2 is only **partially** achievable. |
| 87 | three routing holes | APPROVE W/ CHANGES | One test assertion **can never pass** as written. Expect a textual conflict with #88. |
| 88 | five places the flow says nothing | APPROVE W/ CHANGES | Bundle by maintainer decision — **do not split**. Two `FLOW_TEXT` lines break `format:check` as written. |
| 89 | Connect/Rejoin in-flight state | APPROVE W/ CHANGES | A test phase **can never reach `#play`**; AC5 *is* testable (the plan said otherwise). |
| 90 | keyboard + screen-reader access | **NOT PLANNED** | Deliberately left: it attaches to markup #88 adds, so plan it once #88 has landed. |
| 96 | assert two pages agree tick by tick | APPROVE W/ CHANGES | **Zero production lines.** If the new assertion goes red for a real reason, **STOP** — do not open a red PR; file against #81 and report. |

`90` is the only issue with no plan, and that is on purpose.

## How this was run, and what it cost to learn

Per issue: plan (ponytail **ultra**) → independent plan review → implement (ponytail **full**) →
independent code review → stacked PR. Roughly four agents per issue.

**The review steps earned their keep and should be kept.** Plan review caught, among others: a
test that would have hung the suite forever; two tests that passed against the unfixed code; a
guard that would have burned a client's whole repair budget sending nothing; and an `MAX_RING`
deletion that removed the only hard bound on a client-fed array.

### The one lesson worth carrying forward

**Three assertions in this chain were vacuous** — they passed without the fix:

- **#85** — silence after a blur could not discriminate, because a *held* jump key fires once and
  is silent after (`jump_ready`, `movement.js:92`). **The plan and its review shared the wrong
  assumption.** Caught by the implementer running it.
- **#91** — `bumps <= 1` counted page-wide across five sessions. Caught by the implementer.
- **#91 again** — the replacement was *logically implied* by its sibling assertion, so deleting the
  entire implementation of AC4 left the suite green. **Caught only by code review mutating the
  source.**
- **#94** — the test could not tell a correctly-scoped guard from one wrapping the whole handler,
  which would have been *worse than the bug*. Caught by code review mutating the source.
- A **pre-existing** instance was found and marked in #85's PR (`browser.test.mjs`, the
  "muted is silent" assertion, same `jump_ready` cause).

So: **"prove it fails first" is necessary but not sufficient.** An implementer can watch assertion
1 go red and never notice assertion 2 is dead weight. **Mutation-test each acceptance criterion
separately** — delete the specific line that implements it and confirm a *specific* assertion goes
red. That is what caught the last two, and it is cheap.

## Repo conventions that bit during this session

- **`gh issue view` / `gh issue list` fail here** (Projects-classic GraphQL error). Use
  `gh api repos/philipdzierzon/jump-n-bump/issues/<n>`. `gh issue create`/`comment`/`edit --add-label`
  all work; body edits go through `gh api --method PATCH`.
- **Never `cp` in this sandbox.** It zeroed `src/net/websocket_transport.js` mid-session during
  #94 (3124 NUL bytes). Copy with `git show <rev>:<path> > file` or `git archive`.
- **Never `git checkout -- <path>` to undo a mutation test.** During #95 that wiped the
  implementer's own uncommitted work on the same file. Mutate a `git archive` export in a scratch
  directory *outside* the worktree instead — the worktree is where the work you cannot replace lives.
- **Amend before cutting the next branch.** #84 was amended after #85 was branched from it, which
  orphaned two branches and cost two rebases.
- One worktree per issue under `.claude/worktrees/` (git-ignored), two `node_modules` symlinks,
  never work on `master`, **never merge a PR**.
- `npm test` runs four suites and builds the client first. **No retries by design** — a flake is a
  real race worth a bug.

## Also worth reading

`FINDINGS.md` — 8 corrections to issue bodies and 5 genuinely new bugs, each confirmed by a second
agent, none in scope of the issue that surfaced it. Nothing there has been filed except the
correction to #83, which is already a comment on that issue.

---

## Status as of 2026-09-22 — the chain has shipped; this branch is now an archive

All fifteen issues (#82–#96) plus #110 are merged into `master` (`c01d3dd`) and closed. Nothing in
`plans/` or `issues/` is live work any more; they are kept as the record of how each fix was reasoned
about, next to the PR bodies that carry the measured results.

**`FINDINGS.md` has been actioned.** Each item was re-checked against merged `master` and either
filed or discarded:

- §B9 → #122 (relay `input` has no `started` guard)
- §B10 → #124 (a resume landing after `match_end` strands the client)
- §B11 → #123 (sound players accumulate per room entry)
- §B12 → **no longer applies.** #95 landed the reload clause in `scores_viewmodel.js:70-77`, which is
  the exit this finding asked for.
- §B13 → **no longer applies.** #89's `resume_failed` says so, and `can_rejoin` shows the way out.
- §A1 → already filed as a comment on #83. §A2–A8 correct the bodies of issues that have since
  shipped and closed; the PR bodies are the operative record, so they were **not** re-filed.
- §C14–C18 (contract lines that could not be tested) are recorded here and nowhere else — that was
  the point of writing them down, and they stay here.
- §D (the process findings on vacuous assertions) is carried into the mutation-testing acceptance
  criterion every issue filed on 2026-09-22 now has.

Findings that surfaced later, during implementation and review rather than planning, were filed the
same day: #116–#121, plus four relay abuse surfaces as a comment on #47.

## What was added on 2026-09-22

- `plans/90-*.md` and `plans/110-*.md` — the last two plan/review pairs, which only ever lived in a
  session scratchpad
- `evidence-96/` — the run logs, the packed-state byte diff and `ISSUE.md` behind #110's diagnosis

**The Playwright trace zips are deliberately not here** (22 MB of binaries against 400 KB of text).
They are regenerable: the suite writes `trace-*.zip` on failure, and CI uploads them as artifacts.
