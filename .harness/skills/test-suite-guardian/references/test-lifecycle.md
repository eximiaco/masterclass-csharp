# Test lifetime and exact cleanup

Read when classifying tests, reconciling a strategy, resuming work, or closing
an execution. This helper manages files and evidence, never runs a test command
from JSON. Functional interpretation belongs to the executor and native runners.

## Classification

**Durable:** protects an invariant, known bug, recovery behavior, or relevant
boundary that remains after delivery. Retire only with a verified equivalent
destination or an explicitly accepted residual risk within authorized scope.

**Validation-only:** proves a transition whose old/new comparison ceases to be
useful after the transition or whose future risk has identified durable coverage.
A passing package does not make a recurring business bug temporary. Resolve
doubt before closure, preserving the file. Never remove a failing proof to pass.

Prova temporária também pode validar valores novos em operação já coberta, sem
acréscimo permanente de integração/E2E. Registrar a cobertura operacional durável
reutilizada, o que ela não verifica individualmente e o risco residual aceito pelo
responsável. Não exigir substituto novo um-para-um quando a proteção composta já
sustenta a decisão; não confundir prova exaustiva da entrega com obrigação de
reter todas as combinações para sempre. As verificações de integridade e closure
abaixo permanecem obrigatórias.

Before creation, fix reason, oracle, owner, objective expiration, durable
replacement or absence of future risk, exact paths, native selection, and default
discovery exclusion. A file cannot mix durable and temporary tests. Prefer the
package workspace. If a runner requires its own test tree, use a dedicated
`validation-only/<execution-id>/` and a `validation-only.` filename prefix with
native extension. When a native name is mandatory, document that exception.
Names/tags aid discovery; they never establish ownership or deletion permission.

## Registry and contract

Choose a unique semantic feature plus UUID execution ID. Registry lives outside
the ephemeral package and memory at:
`.harness/workspace/test-lifecycle/<execution-id>/temporary-tests.json`.

Run `status --all` on planning/reconcile/close. Only this registry root is
searched; unrelated executions are reported, not cleaned. Keep operational
state out of MEMORY.md. A new session needs neither conversation nor package
to recover paths, owners, conditions, hashes, evidence, and pending removals.

The Node >=22 helper has JSON stdout, exit 0 for completion and exit 1 with
`blocked` for invalid state/preconditions. CLI paths are repository-relative;
run from the repository. No traversal, absolute paths, symlink file/ancestor/
registry, force option, globs, credential source files, or execution of JSON
commands is permitted. Entries and evidence use exact regular files.

Em linked worktree, executar a partir do worktree. Registro, lock e tudo sob
`.harness/audits/` resolvem na raiz do repositório principal: é onde o executor
os lê e onde sobrevivem à remoção do worktree. Planos, fontes, inputs e arquivos
temporários resolvem no worktree. O diretório de registros é compartilhado
entre worktrees: `status --all` lista só os registros do worktree atual, e usar
o registro de outro worktree bloqueia.

`begin` consumes a filled JSON contract via `--plan`. Its fields are:

- `authorized_scope`: exact future owned paths, never a directory wildcard;
- `strategy`: optional context reference, not required for later recovery;
- `entries`: one record per future file with `id`, `path`, `kind`
  (`test|helper|config`), `lifetime: validation-only`, `owner`, `reason`, `oracle`,
  `expiration`, `replacement` or `no_future_risk`, nonempty `required_inputs`,
  `selection`, and `default_exclusion`.

This contract is a JSON projection of the strategy's closed temporary lifecycle.
The helper does not choose the runner, decide expiration, or infer equivalence.

Registry schema 1 records root, execution/feature, scope, contract hash, entries,
absent baseline, created/validated hashes, input hashes and Git revision from
validation, timestamps, removal receipts, evidence, and closure archive.
Global states: active → validated → cleanup-pending → closed. Errors record
blocked with reason. Entries: creating → created → validated → removing → removed;
updating is a resumable intermediate state. Blocked is never automatic permission
to delete. Reconcile the cause and repeat the relevant explicit operation.

## Operations

Use concrete filled paths/IDs from the strategy; examples below show CLI syntax:

```sh
node .harness/skills/test-suite-guardian/scripts/temporary-tests.mjs begin --execution feature-UUID --feature feature --plan .harness/workspace/lifecycle-plan.json
node .harness/skills/test-suite-guardian/scripts/temporary-tests.mjs create --registry REGISTRY --path OWNED_PATH --from SOURCE_FILE --kind test
node .harness/skills/test-suite-guardian/scripts/temporary-tests.mjs update --registry REGISTRY --path OWNED_PATH --from SOURCE_FILE
node .harness/skills/test-suite-guardian/scripts/temporary-tests.mjs status --registry REGISTRY
node .harness/skills/test-suite-guardian/scripts/temporary-tests.mjs status --all
node .harness/skills/test-suite-guardian/scripts/temporary-tests.mjs record-validation --registry REGISTRY --evidence VALIDATION_JSON
node .harness/skills/test-suite-guardian/scripts/temporary-tests.mjs cleanup --registry REGISTRY
node .harness/skills/test-suite-guardian/scripts/temporary-tests.mjs record-closure --registry REGISTRY --evidence CLOSURE_JSON
```

`begin` is idempotent for same identity and plan hash. Never overwrite an
incompatible registry. `create` checks absent baseline, saves intent, then uses
exclusive creation. No retroactive registration of a preexisting file. `update`
requires owned/current matching content and invalidates previous validation.
Baseline checks also retain paths present or Git-tracked at begin, even if later
removed externally. Changed external content and hard links are blocked.
Updates write a registered exclusive staging path before atomic replacement,
preserving original bytes on interrupted writes. Resume with the same source;
partial/divergent staging blocks for reconciliation instead of overwriting it.
Every new validation attempt invalidates previous proof, including failed ones.
Atomic registry writes and a
process lock serialize mutation. A dead recorded lock owner can be recovered;
a live owner, unknown lock, or ambiguous state requires reconciliation.

`status` is read-only. It lists states, exact paths, and pending conditions.
No scheduler, background cleanup, hook, or global store is involved.

## Validation evidence

Run the strategy's real commands first. Normalize their observed results into
JSON with these fields; never manufacture passed results to satisfy the helper:

- `source_revision`: actual current Git HEAD;
- `inputs`: unique `{path, sha256}` records covering every entry's
  `required_inputs`, including relevant uncommitted implementation/config;
- `temporary` and `permanent`: `{result: passed, artifacts: [...]}`;
- each artifact: `{path, sha256, sanitized: true}` referencing an existing
  sanitized `.json`, `.md`, or `.txt` report from actual execution;
- `final_behavior_implemented`, `expiration_satisfied`, `future_risk_resolved`:
  true only when established;
- `decisions`: per entry `{id, result: passed, oracle, expiration, replacement}`
  or `no_future_risk`, matching the closed contract exactly.

`record-validation` verifies files, revision, inputs, artifacts, and decisions;
it records actual current hashes. All planned files must exist. Hashes and
self-declared passed fields establish integrity, not functional correctness.
The executor must retain the native runner result behind each normalized proof.

## Cleanup and closure

`cleanup` checks every path/condition before any deletion. Current temporary,
input, and evidence hashes must still match validated content and revision.
Only registered, absent-baseline, validated, unchanged files may be removed.
An externally missing file is blocked, not assumed deleted by this helper.
Removal intent/receipts allow partial deletion to resume; repeated cleanup does
not rerun tests or expand scope. Recreated files are preserved and blocked.
No permanent file, unregistered file, or another execution's file is eligible.

After eligible removal, execute the already selected native permanent discovery,
reference/import/config checks, and only validation affected by removal. Do not
run the entire suite twice as ritual. Normalize observed closure results:

- current `source_revision`;
- `default_discovery_excludes_temporaries: true`, `references_clear: true`;
- `discovery`, `references`, `affected`: each `{result: passed, artifacts: [...]}`
  with existing sanitized artifact paths/hashes as above.

`record-closure` verifies removed paths and current inputs, then copies normalized
validation/closure reports, all referenced sanitized artifacts, and the closed
registry into `.harness/audits/test-strategy/<feature>/<execution-id>/`. Archived
artifact references are relative and hash-verified. Existing different bytes
block without overwrite. Repetition verifies archive integrity, including copied
artifacts. Operational registry persists outside the package while needed; no required proof
depends on a deleted package/worktree. After verified delivery, executor may retire
its own closed operational registry under the
[operational retention protocol](../../awu-package-executor/references/operational-retention.md);
the integral archive and final execution record remain. Active/blocked registries
are preserved. A committed summary cannot contain its own
commit hash. Only `closed` means lifecycle complete.

At authorized package completion, execute cleanup and closure without another
approval for these eligible owned files. Preserve failures or changed content;
report blocked cause and reconcile. Do not remove package/worktree or deliver Git
while required lifecycle closure/evidence is incomplete.

## Verification

```sh
node --test .harness/skills/test-suite-guardian/scripts/temporary-tests.test.mjs
```

These permanent helper tests operate in isolated repositories and verify actual
filesystem/state behavior. They are separate from product regression discovery.

## Output and retention

All commands accept `--summary`; default detailed output remains unchanged.
`status --all --summary` lists every pending execution, IDs and blocked reasons,
aggregating closed executions by count. Omit flag to recover full record.
Projection does not alter exit codes or validation. Keep integral sanitized
archive locally with deliberate retention; versioned curated summary is navigation,
not replacement for hashes and evidence checked by helper.

O fechamento da guardiã remove testes/helpers/configs registrados; não elimina
runtime dos runners. Aplicar a
[política de retenção](../../codebase-cleanup/references/artifact-retention.md):
após verificar o arquivo canônico, entregar ao executor da tarefa os destinos
próprios de resultados/traces/diagnósticos, builds de probes e dependências
transitórias para descarte após último uso. Preservar registro e arquivo exigidos
pelo helper; não manter cópias descartáveis por confundi-las com prova canônica.
