---
name: generate-application-context
description: Cria ou atualiza, com base em evidências do repositório, o APPLICATION.md e o perfil leve de convenções .harness/project-profile.yaml. Use para documentar o contexto de uma aplicação e declarar seus padrões estáveis; não use como substituto de README operacional, ADR, especificação de protocolo, documentação de API ou guideline de desenvolvimento.
---

# Generate Application Context and Project Profile

Produza em conjunto:

- um `APPLICATION.md` confiável, útil para pessoas e agentes entenderem o que
  a aplicação é, o que faz e onde termina sua responsabilidade;
- um `.harness/project-profile.yaml` leve, com convenções estáveis e
  específicas do projeto sustentadas por evidências do repositório.

Os dois arquivos são autoritativos em dimensões diferentes. O `APPLICATION.md`
descreve a aplicação; o profile declara convenções. Não use um para duplicar o
conteúdo do outro.

## Descoberta

1. Leia primeiro as instruções do repositório, como `AGENTS.md`, e respeite a convenção local para documentação.
2. Localize o `APPLICATION.md` e o `.harness/project-profile.yaml` existentes. Ao atualizar, preserve conteúdo e convenções ainda corretos e confronte afirmações antigas com o estado atual.
3. Investigue somente o necessário para descrever a aplicação:
   - entrypoints, manifests, módulos e estrutura do código;
   - testes que demonstrem comportamento e contratos;
   - configuração e manifests de execução ou implantação;
   - rotas, handlers, consumidores, jobs e clientes externos;
   - modelos, schemas, ADRs, documentação de domínio e protocolos;
   - README e memória persistente do projeto, quando existirem.
4. Em monorepos, identifique os componentes implantáveis e deixe explícito se o documento descreve uma aplicação, um conjunto delas ou o sistema como um todo.

Para identificar convenções do profile, inspecione uma amostra representativa
de código de produção, testes e documentação, incluindo:

- nomes de diretórios, arquivos, tipos, funções, variáveis e constantes;
- comentários, docstrings, documentação pública e descrições de testes;
- configurações nativas como `.editorconfig`, formatters, linters e manifests
  da linguagem;
- mensagens recentes do histórico do Git, somente quando necessário para
  determinar o idioma de commits.

Não derive convenções de dependências, código gerado, conteúdo vendorizado ou
um único exemplo isolado. Configurações nativas e padrões consistentes em
múltiplos pontos são evidências mais fortes do que ocorrências ocasionais.

Prefira evidência executável e vigente — código, testes e configuração — para comportamento implementado. Use especificações autoritativas para semântica de negócio, protocolo e obrigações externas. Não invente a semântica de campos, mensagens ou integrações a partir de padrões genéricos.

Se fontes divergirem, descreva o comportamento confirmado no estado atual e registre a divergência apenas quando ela for importante para o entendimento. Não transforme hipótese em fato; omita detalhes incertos ou marque-os claramente como não confirmados.

Um profile existente representa uma decisão declarada. Não substitua seus
valores apenas porque parte do código diverge. Preserve-os e informe a
divergência, salvo quando o usuário solicitar a mudança ou outra fonte
autoritativa demonstrar que o profile está obsoleto.

## Redação

Use [assets/APPLICATION.template.md](assets/APPLICATION.template.md) como ponto de partida, adaptando ou removendo seções conforme o repositório. Não deixe comentários do template nem seções vazias no resultado.

Escreva no idioma predominante da documentação do projeto, salvo instrução contrária. Prefira linguagem direta, conceitos do domínio e nomes reais dos componentes. Dê detalhes de implementação apenas quando eles explicarem contratos, limites ou comportamento relevante.

O documento deve permitir responder, sem abrir o código:

- qual problema a aplicação resolve e para quem;
- a qual domínio pertence;
- quais responsabilidades assume e quais rejeita;
- quais fluxos principais executa;
- quais componentes e tecnologias moldam seu funcionamento;
- com quais sistemas externos troca dados e em qual direção;
- onde estão as fontes autoritativas para decisões detalhadas.

Inclua configuração por nomes de seções ou variáveis quando isso esclarecer o comportamento, mas nunca exponha segredos, tokens, dados pessoais, payloads sensíveis ou valores específicos de ambiente.

Evite duplicar instruções de instalação, build, testes e deploy já mantidas no `README.md`, salvo o mínimo necessário para explicar a natureza da aplicação. Não converta o documento em inventário de arquivos, documentação completa de API, ADR ou especificação de protocolo.

## Perfil do projeto

Use
[assets/project-profile.template.yaml](assets/project-profile.template.yaml)
como estrutura de referência. Remova placeholders, comentários, seções vazias
e campos sem evidência suficiente antes de emitir o arquivo em
`.harness/project-profile.yaml`.

O profile aceita somente estas chaves no primeiro nível:

- `schema_version`;
- `application`;
- `languages`;
- `naming`;
- `version_control`, opcional;
- `conventions`, opcional.

Regras:

- use `schema_version: 1`;
- mantenha `application.applies_to` com `new` e `modified`, salvo decisão
  explícita diferente do projeto;
- represente idiomas com tags BCP 47, como `en` e `pt-BR`;
- mantenha idioma e casing em campos separados;
- use em `naming` valores inequívocos, como `kebab-case`, `snake_case`,
  `camelCase`, `PascalCase` e `SCREAMING_SNAKE_CASE`;
- omita qualquer convenção que não possa ser estabelecida com confiança;
- utilize `conventions` apenas para padrões estáveis, recorrentes,
  específicos do projeto e expressáveis de forma estruturada e curta;
- não inclua requisitos de negócio, decisões arquiteturais extensas,
  procedimentos, explicações em prosa ou preferências genéricas;
- não replique listas de exclusão, ignores ou exceções mantidas por
  `.gitignore`, `.rgignore`, formatters, linters ou outras configurações
  nativas;
- não crie `exclude`, `overrides` nem chaves de primeiro nível adicionais.

A seção `version_control` declara regras de commit em
`version_control.commits` com os campos:

- `style`: estilo da mensagem de commit; `conventional` corresponde a
  Conventional Commits e `custom` indica estilo próprio do projeto;
- `language`: tag BCP 47 do idioma das mensagens de commit, como `pt-BR`;
- `header_max_length`: número inteiro positivo de caracteres máximo para a
  primeira linha do commit;
- `body_separator`: `blank-line` exige uma linha em branco entre a primeira
  linha e o corpo do commit; `none` indica que o projeto não impõe
  separador.

A mesma seção `version_control` declara a estratégia de branching em
`version_control.branching` com os campos:

- `strategy`: `trunk-based` (branch de desenvolvimento `main`) ou
  `git-flow` (branch de desenvolvimento `develop`);
- `development_branch`: nome da branch de desenvolvimento;
- `open_pr`: `true` entrega por pull request; `false` faz merge direto na
  branch de desenvolvimento;
- `work_branch_template`: padrão do nome da branch de trabalho, com os
  placeholders `{type}` e `{context}`, como `{type}({context})`;
- `pr_provider`: provedor que abre o pull request, `github` ou
  `azure-devops`; o valor precisa combinar com o formato do remote
  `origin`.

Quando o repositório não oferecer evidência da estratégia real, declare os
defaults (`trunk-based`, `development_branch` conforme a estratégia,
`open_pr: true`, `work_branch_template: "{type}({context})"`,
`pr_provider: "github"`) e confirme
com o usuário. Skills de execução, como `awu-dev-preflight`, consomem esta
seção e preenchem os defaults quando ela estiver incompleta.

Emita cada campo somente quando houver evidência suficiente; omita
individualmente os campos que não puderem ser declarados com confiança.

Uma seção `version_control` existente no profile é decisão declarada. Em
atualizações, preserve-a: não recalcule seus valores a partir de evidência de
código ou do histórico do Git; informe divergência quando o estado atual do
repositório os contradisser, salvo pedido explícito do usuário ou fonte
autoritativa que demonstre obsolescência. Campos ausentes dentro de
`version_control.commits` podem ser preenchidos por evidência, sem alterar
campos já declarados.

O objetivo não é inventariar todos os padrões observados. Inclua somente uma
convenção quando conhecê-la previamente reduzir de forma material a ambiguidade
de futuras implementações ou documentações.

Ao atualizar um profile existente:

- preserve decisões explícitas ainda válidas;
- preencha campos ausentes apenas quando houver evidência consistente;
- migre `languages.version_control.commits` para
  `version_control.commits.language` sem alterar o valor e remova a chave
  antiga;
- remova valores comprovadamente obsoletos;
- não faça uma migração do código apenas para adequá-lo ao profile;
- mantenha o menor YAML capaz de representar as decisões vigentes.

## Atualização e validação

Ao atualizar um documento existente:

- remova ou corrija afirmações obsoletas;
- preserve decisões e limites que continuem válidos;
- mantenha links e caminhos verificáveis;
- não apresente comportamento planejado como implementado.

Antes de concluir, confirme que:

- propósito, responsabilidades e limites não se contradizem;
- fluxos e integrações têm direção, gatilho e resultado compreensíveis;
- fatos concretos são rastreáveis a fontes do repositório;
- detalhes voláteis aparecem somente quando necessários e estão qualificados;
- referências autoritativas seguem a precedência definida pelo próprio projeto;
- o `APPLICATION.md` está na raiz do escopo documentado, salvo convenção ou pedido diferente;
- `.harness/project-profile.yaml` é YAML válido e utiliza `schema_version: 1`;
- o profile não contém chaves de primeiro nível desconhecidas, placeholders,
  campos vazios, `exclude` ou `overrides`;
- cada valor do profile é sustentado pelo arquivo anterior, por configuração
  autoritativa, por solicitação explícita ou por padrão consistente no
  repositório;
- o profile permanece leve e não duplica guideline, documentação, memória ou
  configuração nativa de ferramentas.
