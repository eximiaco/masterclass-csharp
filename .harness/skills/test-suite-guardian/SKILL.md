---
name: test-suite-guardian
description: >
  Plan and maintain risk-based regression protection for a feature, when invoked
  by the AWU compiler or directly by a user. Reconcile coverage and close owned
  validation-only tests; do not run an indiscriminate repository-wide suite.
---

# Test Suite Guardian

## Purpose

Return a decision-complete test strategy for the authorized behavior delta.
Maintain durable regression protection and execute eligible temporary-test
cleanup at completion. Generated artifacts follow the consuming project profile;
these instructions are framework, language, and harness independent.

## Core principle

A retained test needs incremental detection value, not a place in a quota.
Compare contract, consequence, oracle, implementation, and consumer wiring.
Matching titles, HTTP statuses, screens, or similar code do not establish
redundancy. Independent implementations can need independent protection.

Prefer existing coverage and the least costly level that proves the risk:
pure invariants, integration persistence/protocol, controlled UI recovery and
interaction, and critical real boundaries through E2E. Mocks cannot prove real
claims, persistence, or integration. Zero additions is valid with evidence;
growth is valid for an uncovered risk. Do not impose a framework or case budget.

## Prova de entrega e retenção

Decidir separadamente **como comprovar a entrega atual** e **qual proteção precisa
continuar na suíte**. Um critério de aceite exige evidência, não necessariamente
um teste novo e permanente em cada nível. O fato de a prova ser executada por IA
não muda seu rigor nem determina sua permanência.

Antes de propor integração/E2E durável, classificar o delta: nova regra ou ramo,
mudança de schema/encoding/protocolo, correção de defeito, ou apenas ampliação de
valores/dados pelo mesmo caminho já coberto. Um novo valor pode ter tratamento
próprio, limite de armazenamento, consumidor estrito ou conversão diferente;
conferir esses pontos antes de concluir que a operação permanece equivalente.
Ampliação do vocabulário aceito pede comprovação da entrega; não a classificar
como `not-applicable` apenas porque o fluxo operacional permaneceu igual.

Para ampliação de opções, enums ou catálogos sem nova regra/caminho, preferir:

- reutilizar cenários operacionais existentes, inclusive sem alterar seus dados;
- manter matriz barata de valores/rótulos somente se detectar falha adicional;
- usar prova temporária pela fronteira real para conferir a entrega, quando a
  proteção operacional existente e o risco residual identificado sustentarem isso.

Não replicar todos os novos valores em criação, edição, revisão, consulta e cada
adapter por reflexo de rastreabilidade. Também não impor um número fixo de testes
ou dispensar prova de um novo caminho real. Comparar confiança adicional com
custo de execução, fixtures, autenticação, seletores, dados e diagnóstico. Separar
custo inicial da prova de custo recorrente de mantê-la; registrar medições como
desconhecidas quando não observadas.

Cada retenção nova registra risco futuro específico, proteção já existente,
detecção adicional, custo e motivo da permanência. Risco recorrente não obriga
reter **outra** prova do mesmo risco quando cobertura durável existente o protege.
Cobertura composta pode justificar expiração; declarar seus limites e qualquer
risco residual aceito pelo responsável, sem alegar equivalência não demonstrada.

Teste de entrega classificado como `validation-only` tem owner, paths exclusivos,
exclusão da discovery normal, condição objetiva de expiração e cobertura durável
identificada ou risco residual explicitamente aceito. Preservar evidência sanitizada
e executar cleanup/closure antes de concluir. Sucesso da entrega, custo ou autoria
por IA, isoladamente, não autorizam apagar regressão permanente ou teste falho.

## Lifecycle

Plan → implement → reconcile → validate → clean eligible temporaries → verify
remaining discovery and affected checks → archive evidence → close.

For planning classification, read [classification.md](references/classification.md).
At entry and after operations, run
`node .harness/skills/test-suite-guardian/scripts/temporary-tests.mjs status --all --summary`.
Summary preserves every active/blocked owner and reason. Request full detail only
for relevant execution or blocker, by omitting `--summary`. Do not load script
source as ordinary operating context.

Read [test-lifecycle.md](references/test-lifecycle.md) when temporary files are
planned or a relevant pending execution requires creation, recovery or cleanup.
Report unrelated executions and preserve their files. Corruption blocks cleanup.
All mutations also accept `--summary`; projection never changes internal checks,
exit codes, ownership, evidence, or closure requirements. Detailed sanitized
proof may remain local under deliberate retention; shared summary never replaces
the integral evidence required by the helper.

Guardiã `closed` não significa runtime limpo. Informar ao executor os outputs
descartáveis após arquivamento e os arquivos canônicos a preservar, conforme a
[política de retenção](../codebase-cleanup/references/artifact-retention.md).

## Relationship with project instructions

Load applicable AGENTS, profile, development guideline, and relevant memory.
Follow document search rules and existing runners. Current code, tests, config,
and authoritative documentation outrank historical reports and completed AWUs.
Consume normative decisions already resolved by the compiler; do not invent or
reopen architecture. Do not restore old execution agents, hooks, or schedulers.

## Workflow

1. Bound inventory to changed contracts, affected shared implementations, and
   their adapters. Record current code/config references and revision/hashes.
2. Establish risks, failure consequences, observable oracles, and current cases.
   Distinguish initial load from cached refetch; root from revision tokens;
   keep/drop modal behavior; identity, rights, and tenant effects.
3. Compare overlap against implementation and wiring. Prefer a shared-engine
   matrix plus meaningful adapter sentinels over a copied matrix per caller.
   Sampling must name lost protection and accepted residual risk; never describe
   sampling as demonstrated equivalence. Flakiness, age, or mocking alone does
   not justify retiring a test.
4. Choose reuse, extend, add, consolidate, retire, or omit for each contract.
   Join checkpoints only within one coherent entity/context/behavior. Do not
   hide former complete tests in a loop, create order dependence, or move all UI
   checks into E2E merely to lower counts. Record expanded cases; separate
   measured cost from estimates and `unknown`. Invent no coverage percentages.
5. Classify each protection as durable, validation-only, or none. A business bug
   that remains possible after delivery needs durable protection. A transition
   proof can expire only when its risk ceases or identified permanent coverage
   replaces it. Resolve uncertainty before closure; preserve disputed files.
6. Emit a filled strategy using
   [test-strategy.yaml](templates/test-strategy.yaml). Close exact destinations,
   oracles, runner/config/selection, ownership, expiration, evidence, and native
   discovery exclusions before creating temporary files. No unresolved material
   decision goes to the executor.
7. Reconcile implementation, expanded discovery, and diff against strategy.
   Material risk/boundary/retention changes require a revised strategy. Cost or
   a failing run does not authorize weakening an oracle.
8. Execute eligible cleanup using the lifecycle helper, run the agreed native
   post-cleanup discovery/import checks and affected validation, then record
   closure. Do this before Git delivery, knowledge promotion, package deletion,
   or worktree removal. Existing task authorization covers eligible owned files;
   do not stop at suggesting cleanup. Preserve blocked files and explain cause.

## Output contract

Compiler invocation receives requirements, scope, business criteria, profile,
resolved normative decisions, and current code/config/test references. Return
`.harness/workspace/awu-packages/<package>/test-strategy.yaml`. The compiler
embeds closed decisions in the responsible units; it does not select a second
strategy or require suite execution during compilation.

Direct feature maintenance without an active package writes analysis under
`.harness/audits/test-strategy/<feature>/<run-key>/`. Change tests only within
current authorization; do not turn a feature request into a repository audit.

`ready` means decisions complete, not tests passed. `needs-resolution` blocks
test readiness. `not-applicable` needs reason/evidence and empty decisions for
prose or changes with no behavior/contract/test effect. Each decision states
exact source/destination, lifetime, incremental value, oracle, proven boundary,
residual risk, and existing execution command. Temporary ownership, input hashes,
and actual validation results remain pending until observed; never fabricate
passed evidence. This package's bootstrap contract is already resolved: do not
retroactively reopen its suite selection.

## Validation and completion

Verify references and concrete strategies, then validate actual behavior using
existing runners. Preserve durable regressions; do not delete failures to pass.
Temporary completion requires successful current-input validation, exact owned
cleanup, permanent discovery free of temporaries, no dangling imports/config,
affected checks passing, and verified durable evidence with a `closed` registry.
Evaluate learning under AGENTS; reusable policy lives here, not copied into memory.
A compiler cannot silently substitute its own strategy if this skill is missing.
