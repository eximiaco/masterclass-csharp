# Template de prompt — worker de higienização do harness (codebase-cleanup)

Preencha `{output}` com o caminho do relatório do escopo (`review-harness.md`)
e **acrescente ao final** uma seção `ESCOPO:` listando as pastas sob auditoria e
os focos específicos. Escreva o prompt na língua de documentação do projeto
(neste repo: pt-BR) e exija o relatório na mesma língua.

Dispare **um** worker de harness por passada, em chamada `rlm` separada dos
workers de código (paralelo), com `name='review-harness'`.

---

```
CONTEXTO DO PROJETO
- Repo: <caminho absoluto do repo> (<1 linha: stack e propósito>)
- Antes de analisar, leia OBRIGATORIAMENTE:
  1. AGENTS.md (raiz) — regras de memória e ordem de autoridades
  2. .harness/skills/awu-compiler/SKILL.md — Agent Work Unit lifecycle e traceability (as invariantes que você audita)
  3. .harness/guidelines/development-guideline.md — regras de comentários e de validação
  4. .harness/memory/MEMORY.md, .harness/memory/procedures/ e .harness/memory/episodes/
- Commits sob revisão: <git log --since=... resumido — o que foi implementado e o que mudou de forma>

SUA TAREFA (SOMENTE ANÁLISE — NÃO ALTERE NENHUM ARQUIVO)
Auditar as invariantes do harness e reportar achados de higienização:

1. CONFIGURAÇÃO DE IGNORE/TRACKING
   - Verifique que .harness NÃO está em .rgignore nem em .gitignore e que está
     trackeado no git (git ls-files .harness).
   - Se estiver ignorado, reporte como achado mecânico e NÃO deixe a auditoria
     cega: pesquise .harness com caminhos explícitos ou --no-ignore.

2. REFS A AGENT WORK UNITS NO CÓDIGO
   - Busque IDs de Agent Work Units (spec-NNN, feature-NN) em src/ e tests/: comentários,
     nomes, mensagens.
   - Cross-execute com as Agent Work Units ativas em .harness/workspace/awu-packages/.
   - NÃO marque o que é legítimo:
     - DEF-xxx e IDs de issue externos (proveniência de bug — a diretriz os encoraja);
     - refs a Agent Work Units ATIVAS (execução em andamento);
     - memórias episódicas que citam Agent Work Units já removidas (histórico legítimo).
   - Classifique cada ocorrência:
     a) resíduo puro → remover (dispatch mecanico);
     b) portador de constraint → o comentário carrega o porquê de uma restrição
        não-óbvia; recomende promover a constraint para MEMORY.md/documentação
        autoritativa ANTES de remover (dispatch precisa-decisao);
     c) ref a Agent Work Unit ativa → não marque.
   - Cite arquivo:linha de TODAS as ocorrências (grep verificado).

3. HIGIENIZAÇÃO DE MEMÓRIA
   - Audite MEMORY.md por completo; priorize procedures/ e episodes/ pelas áreas
     tocadas na janela de commits; registre o que ficou fora para a próxima passada.
   - Para cada entrada, verifique contra o estado atual do projeto
     (autoridade: código > testes > configuração > documentação > memória):
     - obsoleta — contradita pelo código/testes (cite a evidência);
     - incorporada — agora óbvia no código ou já em documentação autoritativa;
     - desatualizada — parcialmente errada (proponha a correção específica);
     - redundante — duplicada em outra memória;
     - distorção de fluxo / sobreposição de processo — instruções ou registros
       que alteram o comportamento padrão do agente ou o fluxo de
       desenvolvimento/validação (ex.: instruções para rodar testes e2e/unitários
       duas vezes por causa de flakiness efêmero, pular etapas de lint, adicionar
       sleeps arbitrários). Essas entradas são desvios indevidos de processo
       que desaceleram a execução e mascaram problemas reais; devem ser reportadas
       para remoção/revogação;
     - válida — sem ação.
   - Toda proposta cita evidência; nada é aplicado por você.
   - Não proponha remover episódio apenas porque cita Agent Work Unit removida; julgue o
     valor autônomo do aprendizado.
   - Promote-then-delete: se a entrada é a única âncora de uma constraint
     não-óbvia, recomende promovê-la antes de removê-la.

4. INVENTÁRIO DO WORKSPACE (.harness/workspace/awu-packages/)
   - Para cada Agent Work Unit no workspace, classifique:
     - concluída — critérios de aceite verificáveis no código/testes (cite a evidência);
     - abandonada/superada — evidência de substituição ou inatividade;
     - ativa/executando — NÃO TOCAR; fora de escopo.
   - Verifique integridade do grafo: manifests órfãos, Agent Work Units ativas com depends_on
     apontando para Agent Work Units removidas, conhecimento da Agent Work Unit ainda não promovido
     após implementação.
   - Registre a CAUSA provável do vazamento quando identificável (executor pulou
     o passo de remoção do lifecycle?) — alimenta melhoria do processo.

5. RETENÇÃO DE .harness/plans/
   - Liste relatórios antigos (ex.: cleanup-<data>/ anteriores) e proponha
     política de retenção (ex.: manter as N mais recentes ou remover após o
     dispatch da execução).

REGRAS
- SOMENTE LEITURA: não altere código, testes, memória, workspace, plans ou configuração.
- NÃO marque defeitos já documentados (docs/defect-report-*.md, DEF-xxx).
- NÃO marque decisões fixadas em MEMORY.md como problema.
- TAXONOMIA OBRIGATÓRIA: cada achado usa exatamente UM tipo canônico, que vira
  o título da seção de consolidação no sumário final:
  - config-ignore — checagem 1 (configuração de ignore/tracking);
  - residuo-awu — checagem 2 (refs a Agent Work Units no código);
  - higiene-memoria — checagem 3;
  - inventario-workspace — checagem 4;
  - retencao-plans — checagem 5.
- FORMATO DE CADA ACHADO:
  ### [<tipo>] <título curto>
  - **Dispatch:** mecanico | mecanico-com-verificacao | precisa-decisao
  - **Evidência:** arquivo:linha ou saída de comando
  - **Ação proposta:** <concreta>
- O baseline de saúde (build, testes herméticos, formatter, linter) é do
  orquestrador; não o repita.
- Escreva o relatório em pt-BR, formato markdown.

ENTREGA
1. Escreva o relatório completo no arquivo: {output}
2. O relatório termina com uma seção `## Índice por tipo`: para cada tipo
   canônico presente no relatório, uma linha `- <tipo> (<contagem>):` seguida
   de entradas de uma linha por achado (<título> — <evidência principal> —
   <dispatch>). É esse índice que o orquestrador usa para fundir os tipos
   entre todos os relatórios.
3. Ao terminar, responda ao pai com agent_message (receiver_role='parent') contendo:
   resumo executivo (top achados), contagem por tipo (config-ignore / residuo-awu /
   higiene-memoria / inventario-workspace / retencao-plans) e o caminho do arquivo escrito.

ESCOPO: <pastas exatas sob auditoria: .harness/memory, .harness/workspace/awu-packages,
.harness/plans, src/, tests/ + focos específicos, ex.: "feature-27 concluída na
rodada passada; episódios citando parser">
```

## Notas de calibração

- O worker de harness é disjunto dos workers de código: ele audita artefatos do
  `.harness` e a presença de IDs de Agent Work Unit em `src/`/`tests/`; não reporta
  duplicação, complexidade ou outros achados de simplificação.
- A varredura de refs a Agent Work Units é determinística (grep), mas a classificação
  (resíduo puro vs. portador de constraint) exige julgamento — exija a
  classificação explícita em cada ocorrência.
- O inventário do workspace verifica antes de propor remoção: deletar é o passo
  fácil, verificar conclusão (critérios de aceite no código/testes) é o
  trabalho real. Sem evidência de conclusão, a Agent Work Unit não é "concluída"
  e o achado fica `mecanico-com-verificacao` com a verificação nomeada.
- O `## Índice por tipo` ao final do relatório é o contrato de consolidação: é
  o que permite ao orquestrador fundir, por exemplo, todos os achados
  `inventario-workspace` e `residuo-awu` em pacotes únicos de dispatch.
- Episódios priorizados pela janela de commits evitam re-ler toda a memória a
  cada passada; o que fica fora deve ser registrado no relatório para a próxima.
