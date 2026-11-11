# Template de prompt — worker de revisão (codebase-cleanup)

Preencha `{output}` com o caminho do relatório do escopo e **acrescente ao final**
uma seção `ESCOPO:` listando os arquivos/pastas do worker e os focos específicos
suspeitos (arquivos grandes, divisões recentes, pares espelhados). Escreva o prompt
na língua de documentação do projeto (neste repo: pt-BR) e exija o relatório na
mesma língua.

Dispare um worker por escopo, em chamadas `rlm` separadas (paralelo), com
`name='review-<escopo>'`.

---

```
CONTEXTO DO PROJETO
- Repo: <caminho absoluto do repo> (<1 linha: stack e propósito>)
- Antes de analisar, leia OBRIGATORIAMENTE:
  1. AGENTS.md (raiz)
  2. .harness/guidelines/development-guideline.md (diretriz de código vigente)
  3. .harness/memory/MEMORY.md (decisões/fixações das specs — fonte de "o que é intencional")
  4. APPLICATION.md (contexto da aplicação), quando existir
- Commits sob revisão: <git log --since=... resumido — o que foi implementado e o que mudou de forma,
  ex.: "arquivos grandes foram divididos em partials/flows na última rodada">

SUA TAREFA (SOMENTE ANÁLISE — NÃO ALTERE NENHUM CÓDIGO)
Identificar oportunidades de SIMPLIFICAÇÃO no seu escopo:
  a) Duplicidade de código/lógica (candidatas a extração), incluindo padrões repetidos entre arquivos.
  b) Tratamento de erros: catch genérico, erro engolido, mensagens sem valor ofensor, exceção como
     fluxo de controle, caminhos de falha inconsistentes entre fluxos.
  c) Complexidade: funções > 20 linhas, arquivos > 500 linhas, aninhamento > 2 níveis, early returns ausentes.
  d) Código morto, comentários obsoletos, superfície pública maior que o necessário.
  e) Inconsistências internas (mesma coisa feita de 2 jeitos em lugares diferentes).
  f) Violações pontuais da diretriz de desenvolvimento (inclui comentários obsoletos/enganosos).

TAXONOMIA OBRIGATÓRIA (tipo + dispatch)
- Todo achado usa exatamente UM tipo canônico, que vira o título da seção de
  consolidação no sumário final (achados do mesmo tipo são fundidos entre
  relatórios para virar um único pacote de execução):
  - duplicacao — (a)
  - tratamento-de-erros — (b)
  - complexidade — (c)
  - codigo-morto — código sem nenhuma referência rastreável: sem uso estático,
    sem uso no fluxo, sem invoke via reflection/dispatch dinâmico. Verifique
    com grep no repo inteiro, incluindo strings, nomes de símbolos em
    configuração e serialização. Inclui comentários obsoletos que ancoram
    código morto.
  - superficie-publica — (d), metade de superfície: API pública maior que o
    necessário para os consumidores atuais
  - inconsistencia-interna — (e)
  - violacao-de-diretriz — (f)
- Todo achado recebe UMA classificação de dispatch:
  - mecanico — edição determinística, sem julgamento, evidência verificada;
    apto a lote de mesmo tipo;
  - mecanico-com-verificacao — edição mecânica travada numa verificação que
    você NOMEIA explicitamente (ex.: para codigo-morto, a verificação de
    ausência de referência dinâmica que você não conseguiu concluir sozinho);
  - precisa-decisao — julgamento do owner (contrato ambíguo, comportamento
    pinado por teste); NUNCA entra em lote.

FORMATO DE CADA ACHADO
### [<tipo>] <título curto>
- **Dispatch:** mecanico | mecanico-com-verificacao | precisa-decisao
- **Impacto/Esforço:** alto|médio|baixo / pequeno|médio|grande
- **Evidência:** arquivo:linha de TODAS as ocorrências + trecho/padrão concreto
- **Ação proposta:** <concreta>

REGRAS DA ANÁLISE
- NÃO marque como problema o que MEMORY.md registra como decisão fixada de spec
  (<liste aqui as fixações relevantes ao escopo, ex.: parser estrito, tabela fechada,
  grafos fechados, políticas de resposta, gaps já declarados candidatos a spec futura>).
- NÃO marque defeitos já documentados (<ex.: docs/defect-report-*.md, DEF-xxx>).
- Cada achado segue o FORMATO DE CADA ACHADO acima: tipo canônico, dispatch,
  evidência com arquivo:linha de todas as ocorrências, trecho/padrão concreto,
  ação proposta com estimativa de impacto e esforço.
- Separe achados de "quick wins" (mudança local, baixo risco) de mudanças estruturais.
- Verifique a duplicidade ANTES de reportar: cite todas as ocorrências com arquivo:linha (grep).
- Se algo parecer duplicado mas for exigência de spec, anote como "intencional — nao flag" e siga em frente.
- Escreva o relatório em pt-BR, formato markdown.

ENTREGA
1. Escreva o relatório completo no arquivo: {output}
2. O relatório termina com uma seção `## Índice por tipo`: para cada tipo
   canônico presente no relatório, uma linha `- <tipo> (<contagem>):` seguida
   de entradas de uma linha por achado (<título> — <arquivo:linha principal>
   — <dispatch>). É esse índice que o orquestrador usa para fundir os tipos
   entre todos os relatórios.
3. Ao terminar, responda ao pai com agent_message (receiver_role='parent') contendo:
   resumo executivo (top 5 achados por impacto), contagem por tipo, e o caminho do arquivo escrito.

ESCOPO: <pastas/arquivos exatos do worker + focos específicos, ex.: "X vs Y: duplicidade residual
após divisão recente; Z com NNN linhas, maior arquivo do projeto; helpers duplicados entre suítes">
```

## Notas de calibração (aprendidas na primeira execução)

- Incluir no `git log` resumido **o que mudou de forma** na rodada (splits, renomes) reduz
  achados falsos sobre "restos" — o worker os reconhece como resíduo de corte mecânico.
- Exigir no ESCOPO os pares conhecidos de espelhamento (ex.: dois fluxos simétricos, dois
  fakes paralelos) garante que o worker meça a duplicidade em vez de só mencioná-la.
- O baseline de saúde (build, testes herméticos, formatter, linter) é executado uma
  única vez pelo orquestrador na fase 0; não é responsabilidade do worker.
- Workers devem indicar quando um achado **precisa de decisão do responsável** (contrato
  ambíguo, comportamento pinado por teste) usando o dispatch `precisa-decisao`, em vez de
  propor mudança direta.
- O `## Índice por tipo` ao final do relatório é o contrato de consolidação: sem ele o
  orquestrador não consegue fundir o tipo entre relatórios para montar um pacote único
  (ex.: todos os achados `codigo-morto` de todos os escopos viram UMA Agent Work Unit
  compilada pelo awu-compiler).
