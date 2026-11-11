---
name: codebase-cleanup
description: >
  Audit the codebase and the AI-harness artifacts after implementation
  rounds and produce a consolidated cleanup report: hygiene findings
  (spec-reference residue, stale memory, workspace leaks, health baseline)
  and a simplification backlog (duplication, error handling, complexity,
  dead code, public surface, inconsistencies). Every finding carries a
  canonical type and a dispatch classification, so the consolidated report
  groups findings by type across scopes — a whole type group (e.g., all
  dead code) can be dispatched as a single Agent Work Unit instead of one
  package per scope. Strictly read-only: the report is read and judged by
  a human, who dispatches the execution. Typical trigger: /codebase-cleanup.
---

# Codebase Cleanup

## Purpose

Analyze the requested codebase scope and relevant AI-harness artifacts after one or more
implementation rounds (spec commits) and produce a **consolidated, prioritized
cleanup report** with two product classes:

1. **Hygiene findings** — violations of invariants the project's
   authoritative documents already declare:
   - Agent Work Unit identifiers persisted in code or tests;
   - stale, redundant, incorporated, or process-distorting memory entries (e.g., rules/notes that alter standard development or testing flows);
   - completed-but-unremoved Agent Work Units in `.harness/workspace/awu-packages/`;
   - formatter/lint drift and a red health baseline (build, tests).
2. **Simplification backlog** — duplication, error-handling inconsistencies,
   complexity, dead code, surface reduction, and internal inconsistencies.

The skill is **strictly read-only**. It changes no code, test, configuration,
memory, or workspace artifact; its only writes are the report files under the
output directory. The report is a decision-support artifact: a human reads it,
judges each finding, and dispatches the execution — as Agent Work Units compiled by
the `awu-compiler` skill or as a normal development cycle per `AGENTS.md`.

The skill optimizes for:

- verified findings (every claim cites evidence; every duplication claim
  lists all occurrences);
- respect for fixed project decisions (spec-pinned behavior is never
  reported as a problem);
- a canonical type and a dispatch classification for every finding
  (mechanical / mechanical-with-verification / needs owner decision), so
  findings of the same type merge across scope reports into a single
  dispatchable group;
- separation of hygiene from structural changes;
- parallel, disjoint analysis with a single consolidated synthesis.

## Definitions

- **Hygiene** restores invariants declared by authoritative project
  documents.
- **Simplification** reduces design debt.
- A new check belongs in this skill only if it restores a declared invariant.
  Dependency updates, coverage targets, and structural refactors are out of
  scope.

## Hygiene invariants

The hygiene checks enforce invariants declared elsewhere in the toolkit:

1. Agent Work Unit identifiers must not persist in production source code or tests
   (`awu-compiler` → Agent Work Unit traceability). Issue numbers and external
   work-tracking IDs used as bug-provenance references are legitimate and
   must not be flagged.
2. Implemented Agent Work Units must be removed from `.harness/workspace/awu-packages/`
   (`awu-compiler` → Agent Work Unit lifecycle).
3. Memory must stay curated and process-aligned: no obsolete, redundant, incorporated entries, or behavioral/procedural overrides that distort standard agent workflows or alter development/validation flows (e.g., instructions to execute test suites twice, add sleep delays, or bypass gates) (`AGENTS.md` → Manutenção da memória).
4. The tree must be green: build, fast hermetic tests, formatter, linter
   (`development-guideline` → Before you call it done).
5. Harness sources must remain tracked and searchable. Global exclusion of
   `.harness` sources is a finding; deliberate runtime/evidence exclusions are
   valid under [artifact retention](references/artifact-retention.md). Read
   ignored operational paths only with explicit scope. Active packages are
   never garbage by age.

## Finding taxonomy and dispatch classification

Every finding — hygiene or simplification, in any scope report — must
carry a **canonical type** from this table and a **dispatch
classification**. Types are stable identifiers: they are what lets the
synthesis merge findings across scope reports into per-type groups (e.g.,
a single `Código morto` section containing every dead-code finding from
every report), which the maintainer can then dispatch as one Agent Work
Unit compiled by `awu-compiler` instead of one package per scope.

Simplification types (code scopes):

| Type | Covers |
| --- | --- |
| `duplicacao` | repeated code/logic candidates for extraction, including cross-file patterns |
| `tratamento-de-erros` | generic catch, swallowed errors, messages without offending value, inconsistent failure paths |
| `complexidade` | functions > 20 lines, files > 500 lines, nesting > 2 levels, missing early returns |
| `codigo-morto` | code with no traceable reference — no static use, no flow use, no reflection/dynamic invoke; obsolete comments attached to it |
| `superficie-publica` | public API surface larger than consumers require |
| `inconsistencia-interna` | the same thing done two ways in different places |
| `violacao-de-diretriz` | point violations of the development guideline (including obsolete/misleading comments) |

Hygiene types (harness scope and orchestrator baseline):

| Type | Covers |
| --- | --- |
| `config-ignore` | `.harness` ignored by `.gitignore`/`.rgignore` or untracked by git |
| `residuo-awu` | Agent Work Unit identifiers persisted in source/tests |
| `higiene-memoria` | obsolete, redundant, incorporated, or flow-distorting memory entries |
| `inventario-workspace` | completed/abandoned Agent Work Units left in the workspace, broken dependency graph |
| `retencao-plans` | old reports under `.harness/plans/` |
| `baseline-saude` | build/test/formatter/linter failures found by the health baseline |

Dispatch classification (every finding, both classes):

- `mecanico` — deterministic edit, no judgment, verified evidence; safe to
  batch with the other mechanical items of the same type;
- `mecanico-com-verificacao` — the edit is mechanical but gated on a
  verification the report names explicitly (e.g., confirm the absence of a
  reflection/dynamic reference before deleting dead code; verify acceptance
  criteria in tests before removing a completed Agent Work Unit);
- `precisa-decisao` — judgment call blocked on the owner (contract
  ambiguity, test-pinned behavior, constraint carriers needing
  promote-then-delete). Never batched for execution.

Types are the section titles of the consolidated report; the dispatch
classification is the prioritization axis inside each type: `mecanico`
items are the low-complexity, low-risk work that batches into a single
package, while `precisa-decisao` items wait for a decision.

Operational completion belongs to executor/guardian: exact owned cleanup,
evidence, learning and final gates. This audit neither performs those removals
nor runs automatically at the end of every package. No retention TTL or daemon.

## When to use

Use when the user asks to clean up, sanitize, or simplify the codebase, find
duplication or refactoring opportunities, review the code for hygiene, or
audit a series of implementation commits (e.g., a day of spec executions) for
consolidation debt. Typical trigger: `/codebase-cleanup`.

Do **not** use it to implement the findings. Implementation is dispatched by
the maintainer after reading the report and must follow `AGENTS.md` and the
development guideline normally.

## Relationship with project instructions

Before orchestrating, load and follow:

- `AGENTS.md`;
- `.harness/guidelines/development-guideline.md` (it defines the code-style
  limits the reviewers check: functions 4-20 lines, files under 500 lines,
  max 2 indentation levels, rule of three, error-handling rules);
- `.harness/skills/awu-compiler/SKILL.md` — it declares the Agent Work Unit
  lifecycle and traceability rules whose violations the hygiene checks
  audit;
- `.harness/memory/MEMORY.md`, when present — supporting context, verified against current code/tests/config/docs;
  read procedures/episodes only when related to the requested scope;
- open defect reports under `docs/` (e.g., `docs/defect-report-*.md`) —
  already-documented defects are out of scope for findings.

Memory is supporting context and follows the authority rules of `AGENTS.md`.

Hygiene checks must be able to search `.harness`. If it is ignored by
`.rgignore` or untracked by git, do not bypass the misconfiguration
silently: report it as a hygiene finding and search with explicit paths
during the audit.

## Orchestrator workflow

### 1. Load context, measure, and establish the health baseline

- Read the files listed above.
- List the commits under review, e.g. `git log --since="midnight" --oneline
  --stat` (adjust the range to what the user asked about).
- Measure size per file to size the fan-out.
- Run the health baseline **once, in the orchestrator** (not per worker):
  build, the fast test suite, formatter check, and linter.
  - Criterion for the test suite: **hermetic, deterministic, cheap** — runs
    without environment, credentials, or side effects. Use the project's
    unit suite when it fits that criterion; do not run integration suites
    that require external setup.
  - Classify failures: failures caused by already-documented defects
    (DEF-xxx) are out of scope; new failures are hygiene findings and carry
    the failing evidence.
  - The baseline is read-only diagnosis: nothing is fixed by this skill.

### 2. Split into disjoint scopes

- **Code scopes** (simplification backlog): split by buildable project or
  cohesive area (for this repo the proven split is: protocol / host / test
  suites). Test suites may be a scope of their own — they accumulate
  duplication differently. Proportional fan-out; one per cohesive area,
  whichever fits better when parallel capacity is available. Serial review is
  valid for small scopes or unavailable delegation.
- **Harness scope** (hygiene findings): one cohesive review covering
  `.harness/memory/`, `.harness/workspace/awu-packages/`, `.harness/plans/`, the
  `.gitignore`/`.rgignore` configuration, and the spec-reference sweep
  across `src/` and `tests/`.
- Scopes must be disjoint; each worker may read other areas only to
  understand contracts.

### 3. Prepare the output directory

Create `.harness/plans/cleanup-<YYYY-MM-DD>/` with one report file per scope:
`review-<scope>.md` for code scopes and `review-harness.md` for the harness
scope.

### 4. Spawn workers in parallel

Use available delegation only when scope/capacity justify it, otherwise review
serially. No specific agent runtime or model is required. With delegation, use
one worker per scope and stable names. Code workers use `templates/review-worker.md`;
the harness worker uses `templates/harness-worker.md`. Fill `{output}` and
append the scope section. Key contract points that must not be dropped:

- **read-only** — no worker changes any project file;
- mandatory reads before analyzing;
- code workers report the simplification categories: (a) duplication,
  (b) error handling, (c) complexity, (d) dead code / public surface,
  (e) internal inconsistencies, (f) guideline violations;
- the harness worker reports the hygiene checks (ignore-file configuration,
  spec-reference residue, memory curation, workspace inventory, plans
  retention) with a **dispatch classification** for every finding
  (slugs: `mecanico` / `mecanico-com-verificacao` / `precisa-decisao`):
  - *mechanical* — deterministic, no judgment (dispatchable as a small unit
    work or a direct dev cycle);
  - *mechanical with verification* — the action depends on a verification
    first (e.g., a completed Agent Work Unit must have its acceptance criteria
    verified in code/tests before its removal is proposed);
  - *needs owner decision* — judgment call (abandoned/superseded specs,
    ambiguous memory entries, constraint carriers that need
    promote-then-delete);
- exclusion rules: verify memory against higher authority; never flag
  already-documented defects, never propose touching active Agent Work Units;
- evidence rules: every finding cites file:line for **all** occurrences
  (verify duplication by grep before reporting) and shows the concrete
  pattern; code findings also estimate impact (alto/médio/baixo) and effort
  (pequeno/médio/grande);
- taxonomy rules: every finding, in every report, uses its canonical type
  as a typed heading (`### [<tipo>] <título>`) followed by a `**Dispatch:**`
  line with `mecanico` / `mecanico-com-verificacao` / `precisa-decisao`;
  every report ends with an `## Índice por tipo` section (type → count →
  one-line entries with the main file:line) so the orchestrator merges type
  groups across reports without re-reading full findings;
- delivery: write the full report to `{output}` **and** reply to the parent
  with the runtime available, containing summary, per-type counts and report path.

Keep execution resumable and collect all scoped reports before synthesis.

### 5. Track progress

As each reply arrives, give the user a short progress update with the
headline findings of that scope. Do not consolidate until all workers have
reported (or failed — then re-spawn or narrow the scope).

### 6. Consolidate into `sintese.md`

Read all report files — starting from each report's `## Índice por tipo` —
and write `sintese.md` in the same directory, in the project's
documentation language (this repo: pt-BR). This is the cleanup report the
maintainer reads, judges, and dispatches from. It contains:

1. header: date, origin reports, health baseline (build/tests/format/lint —
   green or the classified failures);
2. **hygiene findings** (from the harness scope and the baseline), grouped
   by dispatch classification, each with evidence and the concrete proposed
   action;
3. **consolidation by type** — the dispatch unit of the report. One section
   per canonical type present in any scope report (e.g., `## Código morto`),
   merging every finding of that type from **all** reports into a single
   list; each entry cites its origin (scope report + file:line evidence),
   and entries are sub-grouped by dispatch classification. Each type
   section ends with a dispatchability verdict:
   - `pacote único` — every entry is `mecanico` or
     `mecanico-com-verificacao`; the whole type dispatches as one Agent
     Work Unit compiled by `awu-compiler`, with the named verifications
     turned into acceptance criteria;
   - `pacote parcial` — a dispatchable sub-set exists; list it explicitly
     and point the remaining entries to the pending-decisions section;
   - `bloqueado` — the type depends on owner decisions first.
4. **cross-cutting structural themes** (merge overlapping findings across
   scopes; state why each matters — e.g., past divergence fixed by a spec);
5. **pending decisions for the owner** — findings that are not blind
   cleanups (contract questions, test-pinned behavior, coverage gaps,
   abandoned Agent Work Units, ambiguous memory entries), each linked to
   the type group it blocks;
6. **prioritized batches**: trivial cleanups → local duplication →
   robustness → structural changes, in a numbered execution order, each
   marked with the suggested dispatch (Agent Work Unit / direct dev cycle).
   Batches reference **type groups** from the consolidation section (e.g.,
   "lote 1 — codigo-morto: pacote único de 5 achados mecânicos"), never
   individual scope reports;
7. positive signals confirmed with no action needed;
8. the standard validation commands for the dispatched changes (test suite,
   formatter, known gate caveats from MEMORY.md);
9. a note that findings suppressed by memory entries proposed for update
   must be re-checked after the dispatched memory updates are applied.

### 7. Close

- Present the synthesis: health baseline, top hygiene findings, pending
  decisions, suggested first dispatch. Link the report files.
- State explicitly that the skill changed nothing: every item awaits human
  judgment and dispatch.
- Close any delegated worker lifecycle using the available runtime.
- Learning extraction: per `AGENTS.md`, evaluate whether anything learned is
  worth persisting. When a hygiene finding reveals **why** an invariant
  leaked (e.g., executors skipping the Agent Work Unit removal step), promote
  that cause as process improvement. The reports and synthesis under
  `.harness/plans/` are the persistent artifact of this skill; only promote
  genuinely reusable knowledge to `.harness/memory/`.

## Quality bar

- A hygiene finding without evidence (file:line, command output) is not a
  finding — send it back.
- A finding without a canonical type and dispatch classification cannot be
  merged into a type group — send it back.
- A type group earns the `pacote único` verdict only when every entry is
  `mecanico` or `mecanico-com-verificacao`; one undecided item demotes the
  group to `pacote parcial` with the pending items named.
- A duplication finding without the full occurrence list is not a finding —
  send it back.
- A finding that contradicts memory must cite current higher-authority evidence;
  memory never suppresses a valid code/test/config/documentation finding.
- Never propose touching an active Agent Work Unit; executing Agent Work Units are
  out of scope.
- Prefer one verified high-impact theme over ten stylistic nits.
- The synthesis never mixes hygiene (restores invariants) with
  simplification (reduces design debt) in the same batch, and never mixes
  "dispatchable now" with "needs owner decision".

## Templates

- `templates/review-worker.md` — code-scope worker prompt (pt-BR, as used in
  this repo; adapt the language to the project's documentation language).
- `templates/harness-worker.md` — harness-scope worker prompt (hygiene
  checks).
