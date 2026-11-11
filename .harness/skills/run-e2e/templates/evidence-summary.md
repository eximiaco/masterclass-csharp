# Template de prompt — evidência de execução E2E (run-e2e)

Use quando precisar anexar o resultado de uma execução E2E a uma Agent Work
Unit, PR ou relatório. O script já produziu `summary.md` e `report.json`; este
prompt só condensa, não reinterpreta. Preencha `{report}` com o caminho do
`report.json`.

---

```
CONTEXTO
- Execução E2E: {report} (campos `run_id`, `git`, `targets`, `playwright_args`,
  `stats`, `failures`, `teardown`, `artifacts`).

SUA TAREFA
Escreva, em pt-BR, um bloco de evidência com no máximo 15 linhas, nesta ordem:

1. `Execução E2E <run_id> — <branch>@<head> — <PASSOU|FALHOU|ERRO DE INFRA>`
2. Escopo: alvos executados (ou "suíte completa") e argumentos do Playwright.
3. Stats em uma linha: `expected=N unexpected=N flaky=N skipped=N duração=Ns workers=N`.
4. Se houve falhas: uma linha por falha com `spec:linha`, classe (se já
   analisada com templates/failure-analysis.md) e caminho do error-context.
5. Stack: modo (`up`/`no-stack`), tempo de subida e status do teardown
   (a evidência é inválida se a stack ficou no ar sem `--keep-stack`
   justificado).
6. Caminhos: `summary.md`, `report.json` e `playwright-report/index.html`.

REGRAS
- Copie números do `report.json`; não arredonde nem estime.
- Não inclua valores de segredos, cookies ou tokens.
- Não acrescente interpretação além do que o `report.json` sustenta.
```
