# Template — brief de requisitos da User Story (awu-from-user-story)

Formato fixo do brief que a skill entrega à `awu-compiler`. O brief fica na
conversa e não é gravado em arquivo. Preencha com o conteúdo normalizado do
DevOps (passo 4 do fluxo). Mantenha todas as seções. Quando uma seção não
tiver conteúdo, escreva `nenhum` ou `indisponível` e o motivo.

---

```markdown
# Brief — US <N>: <System.Title>

## Origem

- US: <N> — <título> — tipo `<System.WorkItemType>` — estado `<System.State>` — tags: <System.Tags | nenhuma>
- Feature: <id> — <título> | indisponível (<motivo>)
- Epic: <id> — <título> | indisponível (<motivo>)
- Projeto Azure DevOps: <projeto>
- Coletado em: <AAAA-MM-DD>
- Comentários lidos: <quantidade lidos>/<System.CommentCount>

## História

<Custom.Intro, ou o trecho "Como … quero … para …" da descrição>

## Descrição

<System.Description normalizada, sem os critérios de aceite duplicados e sem
as seções movidas para Pendências, Recomendações ou Referências>

## Critérios de aceite

<Microsoft.VSTS.Common.AcceptanceCriteria normalizado, um critério por item,
com o rótulo original preservado (Principal, Alternativa, Erro…)>

## Regras de negócio

<Regras com id estável (RN-…) e regras sem id declaradas na US, cada uma com
a fonte: US | Feature <id> | Epic <id>>

## Contexto da Feature e do Epic

<Só o que a US referencia ou de que depende: objetivo, limites de escopo,
decisões (D-…) e glossário. Cite a fonte de cada item.>

## Dependências declaradas

<Outras USs, Features ou sistemas dos quais a US declara depender, com o texto
de origem | nenhuma>

## Comentários relevantes

<Por comentário que trata de requisito: data — autor — resumo fiel | nenhum>

## Conflitos

<Para cada conflito: fontes em choque (descrição × critérios, comentário ×
descrição, tipo inesperado na hierarquia), o texto de cada lado e o status:
`decidido pelo usuário em <data>: <decisão>` | `aberto` | nenhum>

## Pendências

<Itens que o DevOps marca como pendentes, abertos ou propostos e que impactam a
US (P…, "a definir", "proposta"), com o texto de origem. Não resolva aqui:
a resolução cabe à awu-compiler ou ao humano. | nenhuma>

## Recomendações técnicas do autor

<Sugestões técnicas presentes no DevOps. Não são decisões e não prevalecem
sobre normas arch.*, ADRs ou o código atual. | nenhuma>

## Referências externas

<Protótipos, documentos e anexos citados: título — URL ou id do anexo —
aberto: sim | não | nenhuma>

## Plano de testes

Requisito obrigatório da compilação. Cada critério de aceite e cada regra
geram ao menos uma linha.

| # | Origem | Comportamento a provar | Cenário | Nível | Ação | Status |
| --- | --- | --- | --- | --- | --- | --- |
| T1 | <CA Principal \| RN-… \| derivado de RN-…> | <resultado observável, com dado e resposta esperados> | <principal \| alternativo \| erro \| borda \| regressão> | <unidade \| integração \| E2E> | <criar \| alterar> | <pronto \| bloqueado por P…> |

Níveis não aplicáveis:

- <unidade \| integração \| E2E>: <motivo> | nenhum

Testes existentes a alterar:

- <comportamento antigo que muda e o critério que o substitui> | nenhum

## Lacunas da coleta

<Níveis indisponíveis, comentários não lidos, anexos não abertos, conversões
com perda | nenhuma>
```

## Regras de preenchimento

- Use o texto do DevOps; resumir é permitido, acrescentar regra, critério ou
  decisão não é.
- Cada item de Regras, Contexto, Conflitos e Pendências indica a fonte.
- Preserve identificadores locais do backlog (`US-004`, `RN-004-1`, `P02`,
  `D-001`) exatamente como aparecem.
- No Plano de testes, descreva o comportamento pelo resultado observável
  (status HTTP, estado persistido, texto na tela), nunca pela implementação
  ("chamar o método X"). Local, fixture e comando ficam para a awu-compiler.
- Não inclua identidades completas, e-mails ou URLs de avatar devolvidos pelo
  MCP. Para comentários, basta o nome de exibição do autor.
