# Local commit checkpoints

Read while planning checkpoints or resuming their execution. This protocol is
execution metadata; it does not add a Git CLI, change branching policy, or make
awu-workspace understand new manifest fields.

## Planning and schema

Find independently valuable, technically verifiable outcomes and integration
boundaries. A small package can have one commit. Multiple checkpoints within a
large unit need explicit testable slices. Validation-only work can join evidence
and documentation at closure; do not manufacture an empty commit, commit-only
AWU, or a checkpoint based on elapsed time, file count, or failing WIP.

Keep the actual unit DAG. Independent branches remain independent. A checkpoint
requires technical implementation, validation, and review gates of `after_units`.
Only `owner_unit` completion waits for its checkpoint. Other technical providers
may complete before the documentation/final commit that consumes their evidence.
`before_units` contains actual consumers already dependent on the result; never
invent dependencies to serialize Git or create an owner completion cycle.

Close lifecycle ownership in the strategy before execution. If A creates a proof
that can expire only after real consumer I validates integration, assign closure
to I (or an existing final owner), register the pending obligation, and allow A's
technical completion/local checkpoint with the proof excluded. Do not require
I before completing A. Lifecycles expiring in A still close in A; unresolved
ownership blocks readiness, and any pending lifecycle blocks final delivery.

The manifest contains:

- `commit_policy`: local mode; capture HEAD/branch/worktree before first edit;
  operational state path; authorized scope; workspace, validation-only, raw
  evidence and credential exclusions; no intermediate publication; final
  validation/guardian cleanup/durable evidence gate;
- `commit_checkpoints`: proportional result boundaries with semantic `id`,
  `owner_unit`, `after_units`, `before_units`, `paths_from_units`,
  `validation_from_units`, observable `gate`, profile-conforming `commit_subject`,
  required `evidence`, and `temporary_policy`.

Each unit reference must exist. Owner must supply a technical gate for its
result. Path scopes identify authorized outcomes; executor resolves exact paths
from reviewed diff, not a broad directory or a compiler-invented file count.
Review table is a projection of this manifest, never a second planning source.
Compilation fills decisions, not future execution SHAs or fabricated success.

## Execution

1. Capture existing HEAD, branch, worktree/repository and preexisting working tree
   and staging state before first package edit. Baseline is not an empty commit.
2. Meet technical gates, then review diff and staging. Exclude owned temporary
   tests/helpers/configs, operational state, raw evidence, credentials, and
   unrelated changes. Permanent skill helpers/selftests can be committed in their
   authorized scope. A failed gate blocks checkpoint; changes after validation
   require affected revalidation, not a commit that asserts stale success.
3. Use the project's authorized local Git flow with exact selected paths. In a
   workspace front that flow is `workspace.mjs commit --paths`, whose output
   supplies SHA, parent and paths for the checkpoint record. Never
   use `git add -A` or broad staging unless the entire diff has been proved to
   belong to this checkpoint. Preserve unrelated existing staging; resolve
   isolation instead of resetting, stashing or discarding it automatically. A
   helper that stages everything is ineligible while other changes remain.
4. Commit locally only. Do not invoke `awu-workspace finish`, push, or PR as
   an intermediate checkpoint; finish can publish. Do not invent a checkpoint
   flag for that CLI. Existing final delivery remains after package completion.
5. Verify commit existence, ancestry, parent, branch/worktree, included paths,
   and matching validated input/config hashes. If Git synchronization changed a
   relevant input, block checkpoint and rerun affected validation. Do not claim
   old results for new inputs or rewrite history to conceal the difference.
6. Record actual SHA and evidence only after verification; then complete owner
   and release real consumers. No force push, amend, squash, reset, empty commit,
   or `--no-verify` to hide failure. With no diff, reuse a verified ancestral
   commit that actually supplies the result or record `no-change` with evidence;
   arbitrary HEAD is not proof.

## State and resume

Atomically maintain `.harness/workspace/commit-checkpoints/<package-id>.json`,
schema version 1, outside semantic memory, while execution is active. Store:

- package/execution/repository identity and original baseline;
- per checkpoint status `planned|committed|reused|no-change|blocked`;
- actual SHA/parent when applicable, branch/worktree, exact paths,
  validation references and relevant input/config hashes;
- pending gates and concrete blocked reasons.

Field shapes per checkpoint: `validation_refs` is a list of path strings that
appear in the validating unit's `evidence`; `input_hashes` is a map
`{ "<worktree-relative path>": "<sha256>" }`. Later units may edit a file
already delivered by a verified checkpoint: the executor reconciles the earlier
unit's inputs against the checkpoint commit, so declare such shared paths in
`diagnostics.couplings` and keep the units serialized by real dependencies.

Git is authority, not state JSON. On resume verify each commit still exists,
is ancestral to the executing branch/worktree, and corresponds to the required
result and evidence. Reuse valid commits, distinguish no-change, and reconcile
missing/diverged history; do not blindly create another commit. Independent
worktrees can complete in different orders, so retain each branch identity.
A SHA supports recovery/comparison; it never authorizes destructive rollback.
After verified final delivery, executor archives checkpoint facts and removes
the operational copy unless another active execution still consumes it. See
[operational retention](../../awu-package-executor/references/operational-retention.md).

## Guardian and final gate

Consume `test-suite-guardian` strategy; do not reclassify tests to unblock Git.
An intermediate implementation commit can coexist with registered temporary
proofs, excluded from staging. It does not close their lifecycle or deliver the
package. Final checkpoint requires eligible exact cleanup, resolved pending
conditions, `closed` registry, durable sanitized evidence, permanent discovery,
and affected checks passing. Never delete a failing durable regression.

Planejar também owner e condição de descarte do runtime próprio conforme a
[política de retenção](../../codebase-cleanup/references/artifact-retention.md).
Execuções E2E, traces/resultados/diagnósticos, builds de probes e instalações
transitórias não são entregáveis Git. Fechar esse descarte após último uso e
verificação das provas canônicas, antes da retirada final do pacote; não exigir
nova AWU só para limpar runtime da execução. Conferir exclusões e índice real em
cada checkpoint; gitignore sozinho não impede inclusão de arquivos já rastreados.

Preserve checkpoint summary and verified evidence references outside the package
before package/worktree removal. Disposable worktrees must first preserve their
operational state in the repository's durable `.harness` location. Document
prior SHAs and validated input revisions in the final versioned summary. Record
its own final SHA only after commit, in excluded operational state and handoff;
never create another commit merely to insert a self-referential hash.

Documentation-only commits do not require rerunning unchanged suites: reuse
actual evidence tied to the same inputs/configs, explicitly identifying their
validated revision rather than claiming tests ran on another SHA. Only remove
the active package after runtime, technical, lifecycle, evidence and checkpoint
gates; archive completion facts before retiring operational copies. Final delivery
uses the existing project flow.

## Behavioral validation

Use disposable copies and isolated repositories without remotes if Git exercises
are useful. Never mutate the real repo merely to evaluate these instructions.
Exercise small one-result packages, independent branches plus final integration,
verified resume, failed validation, unrelated/temporary staging, no-diff work,
and pending final cleanup. Inspect decisions, manifests and actual Git/file
invariants where applicable. Keyword/headings checks alone are insufficient.
