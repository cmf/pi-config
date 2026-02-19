---
name: scientific-debugging
description: Apply a lightweight scientific-method debugging workflow by maintaining a single markdown investigation document during debugging. Use when diagnosing bugs, regressions, flaky tests, production incidents, unexpected behavior, integration failures, or performance anomalies.
---

# Scientific Debugging (Simple)

Maintain one investigation markdown file throughout the debugging session. Keep it current after every meaningful step.

## Investigation file

Create `investigations/<YYYY-MM-DD>-<short-slug>.md` if no active investigation file exists.

Use this template:

```md
# Debug Investigation: <title>

## 1) Problem
- Expected:
- Actual:
- Repro steps:
- Repro reliability baseline (e.g., fails 5/5):
- Environment (commit, versions, config, flags):
- Success criteria:
- Problem updates (new facts / revised understanding):
  - YYYY-MM-DD: ...

## 2) Observations (facts only)
- Raw observations (logs, traces, metrics, stack traces, outputs):
  - ...
- Contradictions / anomalies / trifles:
  - ...
- Background research checked:
  - Docs/specs:
  - Changelogs/recent changes:
  - Dependency/source/tests read:
  - Teammate/rubber-duck input:

## 3) Current State
- Best hypothesis:
- Alternative hypotheses (2-3 plausible competitors):
  1) ...
  2) ...
- Evidence for best hypothesis:
  - ...
- Evidence against / unresolved contradictions:
  - ...
- Next experiment:
- Why this experiment reduces search space:
- Prediction:
  - If hypothesis is true, expect ...
  - If hypothesis is false, expect ...
- Blockers:
- Open questions:
  - [ ] ...
- Question ledger (during investigation; keep status current):
  - [Q1][open] ...
  - [Q2][answered] ... (evidence: Obs #, cmd/test/file/doc)
- Investigation log (what was inspected, tied to Q#):
  - Q1 -> checked <file/command/test/doc>; found <facts only>
- Notes (interpretations):
  - ...

## 4) Experiment Log
| # | Hypothesis tested | Experiment (one intentional change) | Prediction | Raw observations | Decision | Search-space impact |
|---|---|---|---|---|---|---|

## 5) Resolution (fill when done)
- Actual cause (smallest meaningful difference between failing and non-failing worlds):
- Fix:
- Why this fix should work (final experiment logic):
- Verification evidence (original repro + relevant tests):
- Follow-up (tests/docs/alerts/runbooks):
```

## 5-phase workflow

### 1) Frame and reproduce
Fill `Problem` completely with current facts.
Do not assume the failure symptom location is the defect location; keep both open until evidence links them.
Reproduce the failure and record a reliability baseline before deep changes.
If reproduction is unstable, focus first on making it reliable enough to evaluate experiments.
Treat `Problem` as a living section: update it when evidence changes understanding.

### 2) Observe and research
Fill `Observations (facts only)` before choosing the next experiment.
Separate observation from interpretation:
- Observation: what was directly seen.
- Interpretation: what it might mean.
Do quick background research (docs/specs, recent changes, dependency internals/tests, peer input).
Reproduce key claims yourself when possible.

During initial investigation, run a question-ledger loop:
1. Keep questions as `Q1`, `Q2`, ... with status `open`, `answered`, or `parked`.
2. Before each investigation action, state which `Q#` the action is meant to answer.
3. After each action, log exactly what was inspected (file path, command, test, doc) and the factual result.
4. Update question statuses, and add/remove questions as understanding changes.

### 3) Hypothesize and design
Before setting `Best hypothesis`, answer at least 3 `Q#` items with evidence references in the question ledger.
Set `Current State -> Best hypothesis`, and keep 2-3 alternatives visible.
Record evidence for and against the best hypothesis.
Set one discriminating `Next experiment` with explicit prediction:
- If true, expect …
- If false, expect …

Choose experiments that reduce search space fast:
1. Prefer experiments that clearly split possibilities (A vs B).
2. Prefer high-probability, low-cost suspects first:
   - recent code/config/env changes
   - local app logic/data assumptions
   - dependency or integration boundaries
   - deeper runtime/platform causes
3. Prefer minimal repros over broad system tests.
4. Reject experiments with ambiguous outcomes.

### 4) Experiment and analyze
Before running, add a row in `Experiment Log`.
Run exactly one intentional change per experiment, collaborating with human partner as required.
Record raw observations immediately, then set `Decision`:
- `keep` (supports hypothesis)
- `reject` (falsifies hypothesis)
- `unclear` (insufficient signal)

Update `Current State`:
- keep or replace `Best hypothesis`
- update alternatives and evidence
- resolve or elevate contradictions/anomalies
- define the next experiment
- close or add `Open questions`

Update `Problem` if findings changed the real problem statement.
Loop phases 2-4 until ready to resolve.

### 5) Resolve
Fill `Resolution` with:
- actual cause (minimal causal difference)
- fix
- why the fix works (treat fix as the final experiment)
- verification evidence (original repro passes + relevant tests pass)
- follow-up actions

Do not mark done without written verification and causal explanation.
If you cannot explain why it now works, the investigation is not complete.

## Non-negotiable rules

1. No experiment without a prewritten hypothesis and prediction.
2. Reproduce first; record a baseline failure rate before deep debugging.
3. One experiment = one intentional change.
4. Every experiment must reduce search space; redesign experiments that do not.
5. Keep alternative hypotheses visible to avoid fixation.
6. Do not ignore contradictions/anomalies; resolve them or state why they are out of scope.
7. Do not close while any direct contradiction to the claimed root cause remains unresolved.
8. Keep observations separate from interpretations.
9. During initial investigation, tie each action to a `Q#` and keep question status (`open`/`answered`/`parked`) current.
10. Maintain `Open questions`, `Investigation log`, `Notes`, and `Problem updates` continuously.
11. If no progress after ~3 unclear experiments, minimize repro further or ask for help.

## Style

Keep entries short and factual. Prefer bullets and tables over narrative.