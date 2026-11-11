# {{id}} — {{title}}

## Metadata

- **ID:** {{id}}
- **Work type:** {{work_type}}
- **Depends on:** {{dependencies}}

## Objective

{{objective}}

Descreva o resultado concreto que este Agent Work Unit deve produzir.

O objetivo deve representar uma única mudança coerente e ser suficientemente
específico para permitir determinar objetivamente quando o trabalho está
concluído.

## Context

{{context}}

Forneça somente o contexto necessário para compreender a mudança.

Inclua informações de negócio, arquitetura ou implementação quando forem
necessárias para evitar inferências durante a execução.

Não reproduza documentação que possa ser referenciada diretamente.

Não anexe playbooks, guidelines, ADRs ou relatórios de conformity gap. A norma
é input da compilação: esta unidade carrega só decisões fechadas. Gaps, se
houver, o compiler registra em
`.harness/reports/conformity-gaps/<YYYY-MM-DD>-<NN>/gap.md` — não nesta AWU.

## Current behavior

{{current_behavior}}

Descreva o comportamento atual relevante para esta mudança.

Sempre que possível, identifique evidências concretas no repositório:

- arquivos;
- módulos;
- classes;
- funções;
- interfaces;
- endpoints;
- schemas;
- testes;
- configurações.

Esta seção pode ser omitida quando o Agent Work Unit introduzir comportamento
inteiramente novo e não existir estado atual relevante.

## Expected behavior

{{expected_behavior}}

Defina explicitamente o comportamento esperado após a implementação.

O agente executor não deve precisar decidir o comportamento desejado.

Evite expressões ambíguas como:

- "adequadamente";
- "quando necessário";
- "conforme apropriado";
- "seguir boas práticas";
- "tratar corretamente".

Quando utilizadas, o significado concreto deve estar definido nesta
especificação ou em uma referência autoritativa explícita.

## Scope

### In scope

{{in_scope}}

Liste as responsabilidades deste Agent Work Unit.

### Out of scope

{{out_of_scope}}

Liste mudanças próximas ao problema que deliberadamente não pertencem a este Agent Work Unit.

Use esta seção principalmente quando existir risco razoável de expansão ou
interpretação incorreta do escopo.

Se um conformity gap restringir o trabalho, registre aqui no máximo uma linha de
restrição ou out-of-scope com o path do relatório — sem reproduzir o diagnóstico.

## Implementation contract

{{implementation_contract}}

Defina decisões e restrições que devem ser preservadas durante a implementação.

Inclua somente quando aplicável:

- contratos e interfaces;
- regras de domínio;
- componentes que devem ser utilizados;
- componentes que devem ser alterados;
- estruturas de dados;
- integrações;
- persistência;
- eventos;
- APIs;
- requisitos de compatibilidade;
- restrições arquiteturais;
- requisitos de segurança;
- tratamento de erros;
- observabilidade.

Especifique **o contrato da implementação**, não uma sequência arbitrária de
edições no código.

O agente executor continua responsável por produzir o próprio plano técnico,
desde que respeite integralmente este contrato.

## Concrete implementation

A solução deve implementar comportamento real e executável no ambiente do
projeto.

Não utilizar como substituto da implementação requerida:

- placeholders;
- TODOs;
- stubs de produção;
- fake implementations em produção;
- respostas hardcoded;
- bypasses temporários;
- integrações simuladas;
- caminhos incompletos mantidos apenas para satisfazer testes.

Mocks, spies e fakes de teste somente podem ser utilizados quando permitidos
pelas guidelines do projeto e não podem substituir o comportamento concreto
exigido para produção.

## Acceptance criteria

{{acceptance_criteria}}

Defina critérios observáveis com resultado objetivo de aprovação ou falha.

Preferencialmente utilize o formato:

- [ ] {{criterion_1}}
- [ ] {{criterion_2}}
- [ ] {{criterion_3}}

Cada critério deve validar comportamento ou resultado, e não apenas atividade.

Prefira:

> Quando uma autorização inexistente for consultada, a API retorna HTTP 404
> com o error code `AUTHORIZATION_NOT_FOUND`.

em vez de:

> Implementar tratamento de autorização inexistente.

## Validation

{{validation}}

Defina as evidências necessárias para demonstrar que a implementação está
correta.

Inclua somente validações aplicáveis ao Agent Work Unit:

### Automated

- {{automated_validation}}

### Integration

- {{integration_validation}}

### Manual

- {{manual_validation}}

Quando comandos forem conhecidos e estáveis, informe-os explicitamente.

Não invente comandos que não tenham sido verificados no repositório.

## Evidence

{{evidence}}

Registre as fontes que sustentam decisões não óbvias desta especificação.

Exemplos:

- `src/...`;
- `tests/...`;
- ADRs;
- schemas;
- contratos;
- requisitos de negócio;
- configuração;
- `MEMORY.md`;
- procedures;
- ids canônicos do harness normativo (`PB-0001`, `GL-0001`, `GR-0001`, …)
  obtidos via `arch.*` para esta unidade — cite id e proveniência, sem colar o
  corpus (rastreabilidade da compilação; o executor não reabre arquitetura).

Não use relatórios em `.harness/reports/conformity-gaps/` como evidência
autoritativa de comportamento atual nem para baixar a norma.

Para cada evidência relevante, prefira registrar também o que ela estabelece.

Exemplo:

- `src/payments/domain/Payment.ts` — contrato atual do agregado `Payment`.
- `tests/integration/payment.test.ts` — comportamento esperado da integração.
- `ADR-014` — determina que publicação de eventos ocorre via outbox.
- `PB-0001` / `GL-0001` — playbook e guideline aplicáveis a esta unidade.
Não utilize memória como autoridade superior ao estado atual do projeto.

## Execution instructions

Este Agent Work Unit representa uma única unidade de execução classificada pelo
`work_type` definido nos metadados.

A seleção do agente, harness, modelo e demais detalhes de execução é
responsabilidade da camada de orquestração.

Antes de modificar o projeto, o agente executor deve criar um plano de
execução.

O plano deve:

1. identificar as alterações necessárias;
2. identificar os componentes afetados;
3. definir a ordem de implementação;
4. incluir as validações necessárias;
5. respeitar as dependências deste Agent Work Unit;
6. respeitar integralmente seu escopo e contratos.

O plano pertence à memória de trabalho da execução.

O agente não deve utilizar o planejamento para reinterpretar requisitos,
introduzir decisões não especificadas ou expandir o escopo.

Se durante o planejamento ou implementação surgir uma decisão necessária que
não possa ser determinada pelo Agent Work Unit ou por uma fonte autoritativa
explicitamente disponível, a decisão não deve ser inventada.

## Completion

Este Agent Work Unit somente pode ser considerado concluído quando:

- [ ] o comportamento esperado estiver implementado;
- [ ] todos os critérios de aceite forem atendidos;
- [ ] todas as validações obrigatórias aplicáveis forem executadas com sucesso;
- [ ] não existirem placeholders ou implementações temporárias substituindo o comportamento requerido;
- [ ] o agente tiver revisado suas próprias alterações;
- [ ] nenhuma decisão relevante permanecer implícita ou pendente;
- [ ] o workflow de aprendizado e memória definido em `AGENTS.md` tiver sido avaliado.

A avaliação de aprendizado pode concluir que nenhuma nova memória precisa ser
persistida.