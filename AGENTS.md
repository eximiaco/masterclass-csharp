# AGENTS.md

Este arquivo é a fonte única de instruções gerais para assistentes e agentes
de IA neste projeto. Configurações declarativas específicas do projeto são
mantidas no perfil referenciado por este documento.

As instruções aqui definidas são independentes do harness utilizado.
Arquivos específicos de ferramentas, quando necessários, devem apenas
apontar para este documento e não duplicar suas regras.

## Persistência de artefatos

A pasta [`.harness`](./.harness) é responsável por persistir artefatos
destinados a assistentes e agentes de IA, de forma independente do
harness utilizado.

Os artefatos podem incluir, entre outros:

-   PRDs e especificações;
-   planos de execução;
-   contextos, prompts e templates;
-   histórico de decisões relevantes;
-   memórias persistentes dos agentes;
-   procedimentos reutilizáveis;
-   lock de artefatos instalados a partir dos packages privados do GitHub Packages.

Sempre que precisar salvar ou recuperar informações de contexto para
agentes, utilize a pasta `.harness`.

Guidelines e skills instaladas pelo AI Playbook são distribuídas como packages
privados do GitHub Packages. Para atualizar esses artefatos, o usuário ou token
deve ter acesso ao repositório que publica os packages, e as versões resolvidas
devem ser registradas em `.harness/artifacts.lock.yaml` quando houver uso de
faixas abertas como `latest`.

## Perfil do projeto

O arquivo
[`.harness/project-profile.yaml`](./.harness/project-profile.yaml), quando
existir, contém convenções declarativas específicas deste projeto, como idioma
e nomenclatura dos artefatos.

O perfil deve ser consultado antes de:

-   criar, refinar ou validar Agent Work Units;
-   criar, modificar, refatorar ou revisar código;
-   criar ou atualizar documentação do projeto ou documentação em código.

O perfil é configuração autoritativa somente para os campos que declara. Para
campos omitidos, identifique primeiro as convenções vigentes no repositório e
use a diretriz genérica como fallback.

Requisitos explícitos da tarefa, contratos externos, configuração nativa das
ferramentas e convenções obrigatórias do framework prevalecem quando forem
incompatíveis com o perfil. Um conflito relevante deve ser identificado e
resolvido, nunca ignorado silenciosamente.

Por padrão, o perfil se aplica a artefatos novos e modificados. Sua presença
não autoriza renomeação, reformatação ou migração ampla de artefatos fora do
escopo da tarefa, nem alteração de contratos públicos apenas para adequação às
convenções declaradas.

Se o arquivo tiver versão de schema não suportada ou estrutura inválida, não
o ignore silenciosamente. Informe o problema antes de depender de suas
convenções.

## Diretriz de desenvolvimento

O arquivo
[`.harness/guidelines/development-guideline.md`](./.harness/guidelines/development-guideline.md)
contém a diretriz de desenvolvimento do projeto.

**Uso obrigatório:** todo assistente ou agente de IA com perfil de
desenvolvimento, ou seja, que escreve, refatora, revisa ou mantém
código, **deve SEMPRE** consultar e seguir a diretriz referenciada acima
antes de qualquer atividade de desenvolvimento.

As diretrizes ali descritas aplicam-se ao longo de toda a execução, não
apenas no início.

## Workflow de desenvolvimento

Toda atividade de desenvolvimento deve seguir o seguinte ciclo:

1.  **Carregar contexto**
    -   Ler este `AGENTS.md`.
    -   Ler `.harness/project-profile.yaml`, quando existir.
    -   Ler a diretriz de desenvolvimento.
    -   Consultar a memória semântica do projeto, quando existente.
    -   Consultar memórias episódicas ou procedimentos somente quando
        forem relevantes para a tarefa.
2.  **Entender**
    -   Compreender o objetivo e as restrições da tarefa.
    -   Inspecionar o código, testes, configuração e documentação
        relacionados.
    -   Identificar os padrões já utilizados pelo projeto antes de
        propor novos padrões.
3.  **Planejar**
    -   Definir a menor mudança capaz de atender ao objetivo.
    -   Identificar impactos, contratos e validações necessárias.
4.  **Implementar**
    -   Executar a mudança seguindo a diretriz de desenvolvimento e os
        padrões existentes no repositório.
5.  **Validar**
    -   Executar as validações aplicáveis, incluindo testes, formatter,
        linter e demais verificações previstas pela diretriz de
        desenvolvimento.
    -   Não considerar a implementação concluída enquanto houver falhas
        relevantes não compreendidas.
6.  **Corrigir**
    -   Quando houver erro, falha de teste, correção de usuário,
        reviewer, runtime, linter ou outro agente, compreender a causa
        antes de aplicar a correção.
    -   Tratar a correção como candidata a aprendizado, e não
        automaticamente como memória persistente.
7.  **Revisar**
    -   Revisar a própria alteração como um reviewer.
    -   Confirmar que a solução atende ao objetivo e não introduz
        mudanças não relacionadas.
8.  **Extrair aprendizado**
    -   Avaliar erros, correções, descobertas e decisões ocorridas
        durante a execução.
    -   Identificar somente aprendizados que possam reduzir incerteza,
        evitar erros recorrentes ou melhorar execuções futuras.
9.  **Persistir**
    -   Classificar os aprendizados relevantes conforme as regras de
        memória deste documento.
    -   Atualizar o artefato persistente adequado.
    -   Não persistir informação sem valor esperado para execuções
        futuras.
10. **Encerrar**
    -   Uma atividade de desenvolvimento somente pode ser considerada
        concluída após a etapa de aprendizado ter sido explicitamente
        avaliada.
    -   A ausência de aprendizado persistente é válida quando nenhuma
        informação relevante foi identificada.

O ciclo esperado é:

`execução → erro/correção → extração do aprendizado → artefato persistente → próxima execução`

## Memória dos agentes

A memória persistente dos agentes deve ser armazenada em
`.harness/memory`.

Memória existe para melhorar execuções futuras. Ela não deve funcionar
como transcrição de sessões, log de execução ou armazenamento
indiscriminado de contexto.

A estrutura permitida é:

``` text
.harness/
├── guidelines/
│   └── development-guideline.md
└── memory/
    ├── MEMORY.md
    ├── episodes/
    └── procedures/
```

Essa estrutura é fechada: `MEMORY.md` é o único arquivo de memória permitido
diretamente em `.harness/memory`. Conhecimento semântico deve atualizar esse
arquivo; memórias episódicas devem ser criadas somente em `episodes/` e
referenciadas em `MEMORY.md`; memórias procedurais devem ser criadas somente em
`procedures/`. Não crie arquivos temáticos ao lado de `MEMORY.md`.

### Memória de trabalho

A memória de trabalho corresponde ao contexto da execução atual.

Ela pode incluir:

-   tarefa atual;
-   plano;
-   arquivos analisados;
-   hipóteses temporárias;
-   resultados intermediários;
-   erros ainda não compreendidos.

Memória de trabalho **não deve ser persistida automaticamente**.

Ao final da execução, somente aprendizados reutilizáveis devem ser
promovidos para memória persistente.

### Memória semântica

Arquivo:

`.harness/memory/MEMORY.md`

Contém conhecimento estável do projeto útil em diferentes atividades de
desenvolvimento.

Exemplos:

-   restrições arquiteturais;
-   convenções específicas do projeto que não são evidentes no código;
-   características relevantes do ambiente de desenvolvimento;
-   restrições recorrentes de integração;
-   fatos importantes sobre o funcionamento do repositório.

Agentes de desenvolvimento devem consultar `MEMORY.md` antes da
implementação, quando o arquivo existir.

A memória semântica deve ser curta, curada e orientada a conhecimento
reutilizável.

### Memória episódica

Diretório:

`.harness/memory/episodes/`

Contém aprendizados relevantes associados a implementações ou
acontecimentos específicos.

Um episódio pode registrar:

-   contexto relevante;
-   problema encontrado;
-   causa identificada;
-   resolução aplicada;
-   aprendizado reutilizável.

Memórias episódicas são histórico consultável e **não devem ser
carregadas automaticamente em toda execução**.

Consulte episódios somente quando houver relação com a tarefa atual.

### Memória procedural

Diretório:

`.harness/memory/procedures/`

Contém procedimentos reutilizáveis específicos deste projeto.

Exemplos:

-   criação de migrations;
-   execução de testes de integração;
-   processo de release;
-   atualização de dependências;
-   procedimentos de deploy;
-   rotinas específicas de manutenção.

Procedimentos devem ser carregados somente quando forem relevantes para
a tarefa atual.

Quando um procedimento já estiver definido em documentação autoritativa
do projeto, prefira referenciar essa documentação em vez de duplicá-la
na memória.

## Extração e classificação de aprendizado

Falhas e correções ocorridas durante uma implementação pertencem
inicialmente ao contexto de trabalho.

Um erro **não deve gerar memória automaticamente**.

Após a validação, o agente deve avaliar se algo aprendido durante a
execução possui valor para atividades futuras.

Para cada aprendizado candidato, classifique:

-   conhecimento específico da execução e relevante como histórico →
    **memória episódica**;
-   conhecimento estável e reutilizável sobre o projeto → **memória
    semântica**;
-   forma reutilizável de executar uma atividade → **memória
    procedural**;
-   informação temporária, óbvia, duplicada ou sem valor futuro →
    **descartar**.

O fluxo de promoção é:

``` text
working memory
      │
      ▼
learning candidate
      │
      ├── histórico específico ───────► episodes/
      ├── conhecimento do projeto ────► MEMORY.md
      ├── procedimento reutilizável ──► procedures/
      └── sem valor futuro ───────────► discard
```

## Aprendizado a partir de correções

Quando o usuário, reviewer, testes, linter, runtime ou outro agente
corrigir uma premissa adotada durante o desenvolvimento, a correção deve
ser avaliada como candidata a memória.

O agente deve responder internamente às seguintes perguntas:

1.  Qual premissa estava errada?
2.  Qual evidência estabeleceu o comportamento correto?
3.  A correção é específica desta tarefa ou reutilizável?
4.  Saber disso antes da execução teria evitado o erro?
5.  Onde esse conhecimento deveria existir?

Quando saber a informação previamente teria evitado um erro relevante,
deve haver forte preferência por persistir o aprendizado, desde que ele
não esteja documentado em outro local autoritativo.

## Critérios para persistência

Antes de persistir um aprendizado:

1.  verificar se a informação já está documentada;
2.  verificar se a informação continua válida no estado atual do
    projeto;
3.  preferir atualizar memória existente em vez de criar conteúdo
    duplicado;
4.  registrar a causa, regra ou restrição aprendida, e não apenas o
    sintoma observado;
5.  manter a menor forma útil do aprendizado;
6.  persistir no tipo de memória mais específico e adequado.

Persistir somente informações que tenham expectativa razoável de:

-   evitar a repetição de um erro;
-   reduzir incerteza em uma tarefa futura;
-   preservar uma restrição não evidente;
-   melhorar uma decisão futura;
-   documentar um procedimento recorrente;
-   preservar contexto histórico realmente relevante.

## O que não persistir

Não persistir como memória:

-   histórico de conversa;
-   raciocínio intermediário do agente;
-   logs brutos;
-   resultados temporários;
-   erros transitórios;
-   tentativas que falharam sem produzir aprendizado reutilizável;
-   informações óbvias diretamente observáveis no código;
-   informações já documentadas em fonte autoritativa;
-   hipóteses ainda não verificadas;
-   detalhes específicos da execução sem valor futuro;
-   conteúdo gerado apenas para justificar decisões tomadas pelo agente.

Memória deve representar conhecimento destilado, não histórico
exaustivo.

## Autoridade da memória

Memória é contexto auxiliar e **não é fonte primária de verdade**.

Quando houver conflito, a seguinte ordem de autoridade deve ser
considerada:

1.  estado atual do código-fonte;
2.  testes que representam contratos vigentes;
3.  configuração atual do projeto;
4.  documentação autoritativa do projeto;
5.  memória persistente dos agentes.

O agente deve verificar o estado atual do projeto antes de confiar em
uma memória que possa estar desatualizada.

Quando uma memória entrar em conflito com uma fonte de maior autoridade:

1.  seguir a fonte de maior autoridade;
2.  verificar se a memória está obsoleta;
3.  atualizar ou remover a memória obsoleta.

Nunca alterar código correto apenas para fazê-lo corresponder a uma
memória antiga.

## Manutenção da memória

Memória persistente deve permanecer curada.

Ao trabalhar com uma área do projeto, o agente deve atualizar ou remover
memórias relacionadas quando identificar que elas se tornaram:

-   obsoletas;
-   incorretas;
-   redundantes;
-   incorporadas diretamente ao código;
-   incorporadas à documentação autoritativa;
-   desnecessárias devido à evolução do projeto.

Além da manutenção oportunista, a higienização periódica executada pela
skill `codebase-cleanup` audita a memória contra o estado atual do projeto
e **propõe** atualizações e remoções em um relatório.

A skill não aplica alterações: o responsável lê o relatório, julga as
propostas e faz o dispatch da execução.

Prefira uma pequena quantidade de memória de alto valor a um histórico
extenso de atividades.

A persistência deve otimizar a utilidade para a próxima execução, e não
a quantidade de informação armazenada.

## Princípio de melhoria contínua

Cada execução deve ter a oportunidade de melhorar o ambiente para a
próxima execução.

O objetivo do mecanismo de memória é permitir o ciclo:

``` text
executar
   ↓
observar
   ↓
corrigir
   ↓
aprender
   ↓
destilar
   ↓
persistir
   ↓
reutilizar
```

O agente não deve buscar produzir memória em toda tarefa. Deve buscar
deixar o projeto com **mais conhecimento útil e menos incerteza
acumulada**.

## Compatibilidade com diferentes harnesses

Este `AGENTS.md` é a fonte única das instruções para agentes.

Ferramentas que suportam `AGENTS.md` nativamente devem utilizá-lo
diretamente.

Ferramentas que não tratam `AGENTS.md` nativamente, como o Claude, devem
consultá-lo por meio do ponteiro em [`CLAUDE.md`](./CLAUDE.md).

Arquivos específicos de harness não devem duplicar as regras deste
documento.

## Agent Work Unit

Toda criação ou refinamento de Agent Work Units deve utilizar a skill:

`.harness/skills/awu-compiler/SKILL.md`

A skill é responsável por transformar requisitos, contexto do repositório e
memória em Agent Work Units executáveis por agentes. A compilação também é
responsável por trazer a norma de arquitetura aplicável para dentro de cada
unidade (via MCP normativo); este `AGENTS.md` não consulta o MCP diretamente.
