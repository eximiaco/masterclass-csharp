---
name: run-e2e
description: Executa os testes E2E do FTC (Playwright em containers) de forma determinística — suíte completa, um cenário ou um conjunto de cenários — subindo a stack, rodando os specs, coletando resultado e logs, derrubando a stack SEMPRE ao final e emitindo relatório padronizado (JSON + summary.md) com ponteiros de falha (spec:linha, error-context, trace, logs filtrados). Use SEMPRE que precisar rodar E2E — "roda os e2e", "roda o smoke", "executa o cenário X", "valida a AWU com E2E", "sobe a suíte de ponta a ponta" — mesmo que o usuário não cite a skill. Não use para testes unitários/integração .NET nem para subir os frontends em modo dev (→ dev-services / dev-frontends).
---

# Run E2E

Execute os testes E2E da suíte Playwright em containers
(`contexts/core/frontend/e2e`) por um único script determinístico em Node.js
(>= 22). O script é o ponto de entrada obrigatório para **qualquer** execução
de E2E por agentes: suíte completa, um spec, uma pasta de feature ou um filtro
por título. No modo padrão `stg`, encapsula os scripts do repositório (`e2e/stack/up.sh`,
`e2e/docker/run.sh`, `e2e/stack/down.sh`), que continuam sendo a fonte da
verdade sobre a topologia; a skill não duplica compose nem seed.

Garantias do script:

- a stack é derrubada ao final **sempre** (sucesso, falha de teste, erro de
  infra ou interrupção por SIGINT/SIGTERM), salvo `--keep-stack` explícito;
- uma execução por vez na máquina: a stack é única, então frentes em worktrees
  diferentes se excluem pelo lock `e2e-stack` na raiz comum. A segunda recebe
  erro `stack-lock` com o dono atual (`holder.owner`) e deve aguardar; o lock
  não cobre stack deixada no ar com `--keep-stack`;
- o resultado sai em formato fixo: JSON em stdout, `report.json` e
  `summary.md` no diretório de artefatos, com exit code que distingue suíte
  verde, testes falhos e erro de infra;
- em falha, cada teste traz `spec:linha`, mensagem do erro sem ANSI, local do
  erro, `error-context.md`, trace/screenshot e uma dica determinística por
  padrão de mensagem; os logs de `shell-bff` e `core-api` na janela da execução
  são salvos e filtrados (4xx/5xx, exceções, logout, `Tenant not found`), sem o
  ruído do healthcheck;
- o LLM só entra onde há julgamento: classificar a causa de uma falha
  (`templates/failure-analysis.md`) e redigir evidência
  (`templates/evidence-summary.md`).

## Pré-requisitos

- Docker Desktop no ar com memória suficiente (a stack usa cerca de 4 GB).
- Para `stg`: `contexts/core/frontend/e2e/docker/.env` preenchido pela responsável. O
  agente não lê nem imprime valores; os scripts do repo listam só as chaves
  vazias.
- Referência completa da topologia e troubleshooting: seção "🧪 Testes E2E
  (Playwright)" de `contexts/core/frontend/README.md`. Restrições conhecidas
  (workers, cookie de tenant, redirect do Keycloak):
  `.harness/memory/procedures/run-e2e-playwright.md`.

## Ambiente controlado de permissões

`FTC_E2E_ENVIRONMENT` aceita `stg` (padrão) ou `controlled`; valor inválido falha.
`controlled` usa `e2e/identity/compose.controlled.yml` e o controller próprio,
sem carregar `.env` STG nem recorrer a STG quando falha. Exige Node >=22,
SDK e runtime .NET 9 no `PATH` efetivo do Node, OpenSSL, Docker Compose e acesso
aos registries/feeds de dependências. A campanha exige também Python 3.
Aliases de `dotnet` no shell não se aplicam ao processo Node.

Keycloak 26.8.2 usa imagem fixa
`quay.io/keycloak/keycloak@sha256:3879c623248408de29a5303178b5816c77e8dfef3890c361f8c0bbeaa979ba3b`.
Realm, contas default/architect/no-access por worker, organizações, segredos e
CA são gerados por execução. TLS e validações JWT continuam ativos. Identity,
Tenant, Core API/MCP e BFF são reais; banco tmpfs, netns, auth e outputs são
próprios, sem porta host ou volume persistente de teste. Quatro frontends usam
bundle em modo development e preview, preservando React/StrictMode. Nova fonte
exige nova execução/build; não há HMR nessa topologia. Collect backend não integra
este recorte.

Na raiz do repositório:

```bash
FTC_E2E_ENVIRONMENT=controlled node .harness/skills/run-e2e/scripts/run-e2e.mjs e2e/features/smoke/shell-core-smoke.spec.ts e2e/features/architecture/decision-authoring.spec.ts --workers 1 --retries 0 --logs always
FTC_E2E_ENVIRONMENT=controlled node .harness/skills/run-e2e/scripts/run-permission-stability-campaign.mjs --dry-run
FTC_E2E_ENVIRONMENT=controlled node .harness/skills/run-e2e/scripts/run-permission-stability-campaign.mjs
```

Campanha executa primeiro dois jobs simultâneos isolados, depois vinte ambientes
novos alternando 1/3 workers (dez por condição). Grupos são medidos separadamente;
retries zero, trace on e oracles/timeouts fixos. Falha invalida campanha, sem
`repeat-each` como substituto. Helper exige destinos novos para `--out`/`--evidence`,
arquiva provas sanitizadas antes de avançar e retira somente tags próprias por
label/hash após último uso, sem force/prune ou remoção de recursos alheios.

NuGet local é preparado por `contexts/shared/backend/scripts/prepare-local-package.mjs`:
versão por hash, feed/cache exclusivos e override `FtcSharedPackageVersion` somente
na execução. `runtime/versions.json` e readiness comprovam versão/hash do assembly
nos cinco serviços .NET. Credenciais/CA/storageState são privados e descartáveis;
não imprimir seus arquivos. A política de retenção continua obrigatória.

Para validar upgrade de pacote já publicado, definir
`FTC_E2E_SHARED_PACKAGE_MANIFEST=<JSON regular dentro da raiz>`. O JSON exige
`schema_version: 1`, `origin: "published"`, `version` estável explícita,
`package.path` relativo para `ftc.shared.<version>.nupkg`, `package.sha256` e
`assembly.sha256`. Obter artefato por restore autenticado do feed e conferir
identidade/hashes; não repackar fonte para provar esse release. O controller
confere arquivo regular, raiz, hash e cache imutável, recusa divergência sem
fallback e registra origin published em versions. `--no-stack` exige mesmo
artefato do runtime existente. Default sem essa env continua local-source.
Prova de pins exige restore/build sem override de `FtcSharedPackageVersion`;
amostra E2E exige hash publicado nos runtimes, não só número no csproj.

Sem `--retries`, controlled usa zero. `--no-stack` exige
`FTC_E2E_CONTROLLED_RUN` apontando ao runtime próprio verificado; `--skip-db` só
nesse reuso. Nova execução sempre cria banco/seed próprios. Tabelas de opções e
fluxo de stack abaixo descrevem STG quando citam scripts/volumes daquele modo.

Prova de 06/11/2026: 20+2 ambientes aprovados em VM Docker de 11 CPUs/11,67 GiB;
picos amostrados por ambiente de até 3,356 GiB na comparação. Isso não define
hardware mínimo nem garante ausência absoluta de flakiness. Reservar espaço para
imagens/cache: disco cheio pode aparecer como falha de build/apt. Não executar
limpeza global como correção automática. Resultados e handoff em
[entrega de permissões](../../audits/summaries/e2e-permission-stability-delivery.md).
Publicar NuGet, atualizar pins de produção e implantar Identity/Shell exigem
release autorizado separado; prova local não declara STG corrigido.

## Uso

Sempre a partir da raiz do repositório:

```bash
node .harness/skills/run-e2e/scripts/run-e2e.mjs [alvos...] [opções] [-- <args do playwright test>]
```

| Objetivo | Comando |
| --- | --- |
| Suíte completa | `node .harness/skills/run-e2e/scripts/run-e2e.mjs` |
| Uma pasta de feature (ex.: smoke) | `... run-e2e.mjs e2e/features/smoke` (aceita `features/smoke` ou `smoke`) |
| Um spec | `... run-e2e.mjs e2e/features/architecture/decisions.spec.ts` |
| Vários alvos | `... run-e2e.mjs smoke architecture` |
| Um cenário pelo título | `... run-e2e.mjs smoke --grep "abre o Core"` |
| Listar os testes (estático, sem Docker) | `... run-e2e.mjs [alvos] --list` |
| Ver o plano sem executar | `... run-e2e.mjs [alvos] --dry-run` |
| Iterar com a stack já no ar | `... run-e2e.mjs <spec> --no-stack --keep-stack` |
| Após alterar .NET (Core API/BFF) | `... run-e2e.mjs [alvos] --skip-db` (reconstrói imagens, preserva banco) |
| Recriar o banco e o seed | `... run-e2e.mjs [alvos] --reset-db` |

Opções:

| Opção | Efeito | Default |
| --- | --- | --- |
| `--grep`, `--grep-invert` | filtro por título, repassado ao Playwright | — |
| `--workers <1..3>` | workers do Playwright; acima de 3 o script recusa (Chromium cai no Docker Desktop de 8 GB; Keycloak HML recusa logins simultâneos) | 3 (do `playwright.config.ts`) |
| `--retries`, `--repeat-each`, `--timeout` | repassados ao Playwright | — |
| `--no-stack` | não sobe a stack; exige `shell-bff`, `shell-frontend` e `core-frontend` rodando | sobe |
| `--keep-stack` | não derruba ao final (uso: iteração local; derrubar depois com `npm run e2e:stack:down`) | derruba |
| `--reset-db` / `--skip-db` | repassados a `stack/up.sh` | banco sobe e reseed |
| `--teardown-reset` | `down --reset` (remove volumes: banco e `node_modules`) — só com pedido explícito do usuário | não |
| `--logs on-failure\|always\|never` | quando coletar logs da stack | `on-failure` |
| `--logs-services a,b` | serviços cujos logs são coletados | `shell-bff,core-api` |
| `--out <dir>` | diretório de artefatos | `.harness/workspace/e2e-runs/<run_id>` |
| `--keep-runs <n>` | retenção de execuções antigas em `e2e-runs/` | 5 |
| `-- <args>` | passthrough literal para `playwright test` | — |

## O que o script faz

1. **preflight**: valida argumentos; resolve cada alvo para um caminho sob
   `contexts/core/frontend/e2e` (pasta ou `*.spec.ts` em `e2e/features/`),
   falhando com a lista de pastas disponíveis quando não encontra; confere
   `docker compose` e a presença do `.env` (sem ler valores).
2. **stack-up** (salvo `--no-stack`): limpa `playwright/.auth/` (sessões de um
   BFF anterior) e roda `e2e/stack/up.sh`. Se a stack não sobe, salva
   `compose ps --all` e as últimas 200 linhas de cada serviço em `logs/`,
   derruba a stack e encerra com erro de infra.
3. **run**: remove o `e2e-results.json` anterior (evita ler resultado velho) e
   roda `e2e/docker/run.sh <args>`. A saída do runner é ecoada em stderr; o
   stdout do script é só o JSON final.
4. **collect**: normaliza `test-results/e2e-results.json` (reporter json do
   Playwright): stats, lista de testes por status e, para cada `unexpected` ou
   `flaky`, o bloco de falha descrito abaixo. Caminhos do container
   (`/e2e-runner/...`) são traduzidos para o host.
5. **logs** (conforme `--logs`): `docker compose logs --since/--until` na
   janela `start_time − 10 s` → `start_time + duração + 10 s` de cada serviço,
   salvos em `logs/<serviço>.log`, com até 60 linhas relevantes no relatório.
6. **teardown** (sempre, salvo `--keep-stack`): `e2e/stack/down.sh`
   (`--reset` só com `--teardown-reset`). Falha no teardown é reportada em
   `teardown.status` sem mascarar o resultado dos testes.
7. **report**: grava `report.json`, `summary.md` e cópia do
   `e2e-results.json` no diretório de artefatos, mantém as últimas
   `--keep-runs` execuções e emite o JSON em stdout.

`.harness/workspace/e2e-runs/` é efêmero: o script cria um `.gitignore` local
(`*` + `!.gitignore`) para impedir inclusão acidental pelo staging normal.

## Retenção após consumo

Ao invocar, registrar run IDs e destinos próprios, inclusive `--out`, outputs do
frontend e diagnósticos. O runner preserva resultado para análise; teardown e
`--keep-runs` não encerram sua retenção. Seguir a
[política de retenção](../codebase-cleanup/references/artifact-retention.md).
Após último consumidor e arquivo sanitizado verificado, executor da tarefa remove
execuções próprias e resultados/traces/relatórios/diagnósticos descartáveis;
inclui probes compilados e dependências transitórias criadas na investigação.
Preservar prova canônica exigida, arquivos em uso e outputs de outras execuções.
Conferir Git ignore, arquivos rastreados e staging; nenhum trace bruto ou runtime
deve acompanhar o commit. O script não realiza essa limpeza final pelo consumidor.

## Saída padronizada

Exit code: `0` suíte verde; `1` testes falharam (ou zero testes executados);
`2` erro de infra ou de uso.

JSON em stdout (campos principais; `tests` completo fica só no `report.json`):

```json
{
  "status": "ok | failed | error",
  "run_id": "20261012-191248",
  "verdict": "passed | failed | infra-error",
  "git": { "branch": "feature/us-4928", "head": "c44b7d4" },
  "targets": [{ "input": "smoke", "path": "e2e/features/smoke", "kind": "dir" }],
  "playwright_args": ["e2e/features/smoke"],
  "stack": { "mode": "up | no-stack", "db_mode": "up | reset | skip", "up_seconds": 95 },
  "stats": { "expected": 3, "unexpected": 0, "flaky": 0, "skipped": 0, "duration_ms": 23384, "start_time": "...", "workers": 3, "playwright_version": "1.60.0" },
  "failures": [
    {
      "title": "Decisões arquiteturais (ADR) › cria uma ADR em rascunho",
      "file": "/abs/contexts/core/frontend/e2e/features/architecture/decisions.spec.ts",
      "line": 60,
      "status": "unexpected | flaky",
      "attempts": 1,
      "error": { "message": "Error: Timeout 30000ms exceeded...", "location": "/abs/.../decisions.spec.ts:72:5", "snippet": null },
      "hint": { "category": "ui-wait | auth-env | runner-resources | stack-network | data | unclassified", "action": "..." },
      "attachments": { "error_context": "/abs/.../test-results/<teste>/error-context.md", "trace": "...", "screenshot": "..." },
      "stdout_tail": [], "stderr_tail": []
    }
  ],
  "run_errors": [],
  "logs": { "shell-bff": { "file": "/abs/.../logs/shell-bff.log", "window": { "since": "...", "until": "..." }, "highlights": { "total_matches": 4, "lines": ["..."] } } },
  "teardown": { "performed": true, "status": "ok | error | skipped", "reason": "--keep-stack" },
  "infra_error": null,
  "artifacts": { "dir": "...", "report_json": "...", "summary_md": "...", "results_json": "...", "html_report": "...", "test_results_dir": "..." },
  "next_steps": ["..."],
  "tests_total": 3,
  "forbidden_actions": ["..."]
}
```

`summary.md` (pt-BR) tem sempre as mesmas seções: veredito e contexto
(branch, alvos, argumentos, stack, teardown), tabela de estatísticas, erros do
runner, uma subseção por falha (spec:linha, local do erro, dica, evidências,
comando para reproduzir, mensagem, stderr), erro de infra, logs da stack,
artefatos e próximos passos. É esse arquivo que o agente lê primeiro; o
`report.json` serve para consumo programático e para os templates.

A `hint` é heurística por padrão de mensagem (determinística, sem LLM). Serve
para orientar a primeira leitura, não para concluir a causa.

## Tratamento de falhas

Com `status: "failed"`:

1. Ler `summary.md`. Para cada falha, abrir o `error-context.md` (snapshot da
   página) **antes** de tocar no spec.
2. Aplicar `templates/failure-analysis.md` com `summary.md` e `report.json`
   para classificar cada falha em [A] spec/locator, [B] ambiente, [C] defeito
   de produto ou [D] dado/seed, com evidência.
3. Falha transitória de STG (login do Keycloak, 401/400 de `/api/identity`,
   Tenant API) admite **uma** repetição, registrada; nunca mais de uma. Teste
   que caiu na tela de login tem a causa nos highlights de `shell-bff` e
   `core-api`.
4. Divergência de dado que indique defeito de produto é reportada como
   evidência de defeito; o seed nunca é alterado para mascarar.
5. Reexecutar só os specs afetados com `--no-stack --keep-stack` enquanto
   investiga e derrubar a stack ao final (`npm run e2e:stack:down` em
   `contexts/core/frontend`).

Com `status: "error"` (infra): ler `step`, `command`, `stderr_tail` e
`suggestions`; corrigir a causa e reexecutar. Não alterar spec, seed ou
credenciais por erro de infra.

## Contrato de erro

Em erro de infra ou de uso o script imprime JSON em stdout e encerra com
exit 2. Exemplo:

```json
{
  "status": "error",
  "phase": "preflight",
  "step": "targets",
  "message": "alvo nao encontrado sob contexts/core/frontend/e2e: \"metrics\"",
  "errors": [{ "input": "metrics", "message": "...", "suggestions": ["Pastas disponiveis: e2e/features/architecture, e2e/features/auth, e2e/features/smoke"] }],
  "forbidden_actions": ["..."]
}
```

Quando a falha ocorre depois do preflight (stack ou runner), o JSON segue o
formato do relatório com `verdict: "infra-error"` e `infra_error: { step,
message, command, exit_code, stdout_tail, stderr_tail, suggestions }`; o
teardown já foi executado e consta em `teardown`.

Ações proibidas para a skill e para qualquer tentativa de correção:

- imprimir, copiar ou registrar valores de `e2e/docker/.env`; só nomes de
  chaves;
- editar `.env`, `.env.playwright` ou credenciais para fazer um teste passar;
- alterar seed ou spec para mascarar divergência que indique defeito de
  produto;
- subir `workers` acima de 3;
- remover volumes (`--teardown-reset`) sem pedido explícito do usuário;
- repetir a suíte mais de uma vez por falha transitória de STG sem registrar.

## Evidência

Para anexar o resultado a uma Agent Work Unit, PR ou relatório, use
`templates/evidence-summary.md` com o `report.json`. O mínimo exigido em AWU de
frontend continua sendo o smoke (`e2e/features/smoke`) verde com teardown
`ok`.

## Limitações

- Cobre a suíte de `contexts/core/frontend/e2e` (Shell, Core, Identity,
  Collect e BFF em containers). Não executa testes .NET nem o Playwright
  local (`npm run test:e2e` contra o dev do host).
- `--list` é estático (regex sobre `test(`/`test.describe(`): não resolve
  `test.each`, títulos dinâmicos nem filtros `--grep`; para a contagem exata
  use `-- --list` com a stack no ar.
- No modo padrão `stg`, Identity, Tenant e Collect são os de STG via BFF: indisponibilidade desses
  serviços aparece como falha [B] e não é corrigível no repo.
- Em STG, a primeira subida dos frontends roda `npm ci` dentro dos containers e leva
  minutos (`--wait-timeout 900` em `up.sh`); as seguintes reaproveitam volumes.
- Os logs são coletados antes do teardown; com `--logs never` não há como
  recuperá-los depois que a stack cai.

## Consumo programático

O contrato de entrada (argumentos) e de saída (JSON, `report.json`,
`summary.md`, exit codes) é o documentado aqui e deve permanecer estável entre
versões patch. A disciplina de invocação (quando rodar, quantas repetições,
quando escalar ao usuário) é responsabilidade do harness consumidor.

## Verificação

Na raiz da skill, sem Docker:

```bash
node scripts/selftest.mjs
```
