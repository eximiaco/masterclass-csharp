# Template de prompt — análise de falhas E2E (run-e2e)

Use este prompt **depois** que `run-e2e.mjs` terminou com `status: "failed"`. Ele
transforma as evidências já coletadas pelo script em uma classificação de causa
por falha. Preencha `{summary}` com o caminho do `summary.md` da execução e
`{report}` com o `report.json`. Não rode a suíte de novo antes da análise.

Escreva o prompt e exija a resposta na língua de documentação do projeto
(neste repo: pt-BR).

---

```
CONTEXTO
- Repo: <caminho absoluto> (FTC — testes E2E Playwright em containers, contexts/core/frontend/e2e)
- Execução analisada: {summary} (leia por completo) e {report} (campo `failures`)
- Leia também, OBRIGATORIAMENTE, antes de concluir qualquer coisa:
  1. o `error-context.md` de cada falha (snapshot da página no momento do erro);
  2. os arquivos de log listados em `logs` (shell-bff, core-api) — os
     highlights já descartam o ruído do healthcheck (`GET /auth/user 401`);
  3. o spec da falha (`file:line`) e os helpers que ele importa;
  4. o seed correspondente em `e2e/db/seed/`, quando a falha envolver dado;
  5. `.harness/memory/MEMORY.md`, seção "Testes E2E (Playwright) em containers".

SUA TAREFA (SOMENTE ANÁLISE — NÃO ALTERE spec, seed, .env nem código)
Para cada falha em `failures`, produza:

1. CLASSIFICAÇÃO (uma por falha), com a evidência que a sustenta (trecho do
   erro, linha do log com timestamp, trecho do error-context):
   - [A] spec/locator — o teste está errado ou frágil (seletor, espera,
     dependência de ordem, estado compartilhado entre workers);
   - [B] ambiente — stack, STG (Identity/Tenant/Collect via BFF), Keycloak,
     rede, memória do Docker, build de imagem;
   - [C] defeito de produto — o comportamento observado contraria a regra
     de negócio ou o contrato; cite a regra (PRD/US/ADR/MEMORY.md);
   - [D] dado/seed — o dataset de `e2e/db/seed/` não contém o que o cenário
     espera, ou foi alterado por outro teste.
   Quando a dica determinística do script (`hint.category`) divergir da sua
   classificação, diga por quê.

2. CAUSA RAIZ em 1–3 frases, apontando arquivo:linha de tudo o que citar.

3. PRÓXIMA AÇÃO MÍNIMA, por classe:
   - [A] a correção pontual no spec (sem reescrever o teste);
   - [B] o que verificar/repetir — falha transitória de STG permite UMA
     repetição, registrada no relatório; nunca mais de uma;
   - [C] abrir evidência de defeito (título, passos, esperado × obtido,
     caminhos de trace/error-context) — o seed NUNCA é alterado para
     mascarar;
   - [D] o ajuste de seed proposto (`0NN-*.sql` + limpeza em `000-reset.sql`
     + contagem em `e2e/db/_db.sh`), só se o dado for legitimamente parte do
     cenário.

4. RESUMO EXECUTIVO: tabela `falha | classe | causa | ação | confiança
   (alta/média/baixa)`, seguida de quais specs reexecutar
   (`node .harness/skills/run-e2e/scripts/run-e2e.mjs <spec> --no-stack --keep-stack`
   com a stack no ar) e de uma linha dizendo se a stack precisa ser
   recriada (`--skip-db`/`--reset-db`) para validar a correção.

REGRAS
- Nunca imprima valores de `e2e/docker/.env`, cookies, tokens ou senhas.
- Não proponha subir `workers` acima de 3.
- Não conclua "flaky" sem evidência: flaky sem causa é [B] a investigar.
- Se faltar evidência para decidir entre duas classes, diga qual arquivo ou
  comando resolveria a dúvida em vez de escolher.
```
