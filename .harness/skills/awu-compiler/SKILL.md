---
name: awu-compiler
description: >
  Compile requirements, repository context, architecture, code, tests and relevant
  project memory into decision-complete Agent Work Unit packages. Use to create,
  refine, decompose or validate AWU specifications; execution belongs to executor.
---

# Compilador de Agent Work Units

Compilar a menor especificação que fecha as decisões necessárias. AWU descreve
trabalho e capacidades, sem identidade de agente/modelo/harness. Compilação não
executa implementação, testes, commits, publicação ou retirada do pacote.

AWU é delta temporário entre estado atual e desejado, não documentação permanente.
Código/testes/configuração/contratos/documentação atuais estabelecem fatos; AWUs
concluídas nunca estabelecem comportamento vigente. Contrato crítico precisa ser
explícito ou alcançável por referência autoritativa identificada. Decisão de
produto, arquitetura, teste ou dados ausente bloqueia prontidão, sem delegar inferência.

## Contexto e mapa de leitura

Carregar AGENTS, perfil válido, diretriz aplicável e MEMORY curta uma vez por
contexto atual. Schema/estrutura do perfil precisam ser suportados; campos
declarados são autoritativos somente em seu escopo. Requisito explícito, contrato
externo, configuração nativa e convenção obrigatória do framework prevalecem;
resolver conflito relevante antes de emitir. Perfil rege artefatos novos/modificados,
não renomeação, formatação ou migração de contrato público fora do escopo.

Não reler fonte atual já presente no contexto. Procedures/episodes e fontes de
domínio somente pelo escopo tocado. Conferir memória contra fonte superior;
memória/gap não sobrepõe código/teste/config/doc/norma. Não carregar memória
recursivamente nem inventário de relatórios históricos na partida.

| Recurso | Gatilho de leitura |
| --- | --- |
| [Resolução normativa](references/normative-resolution.md) | Decisão arquitetural/convenção; consulta Playbook-first, fallback ou conformity gap |
| [Fontes de dados](references/data-source-resolution.md) | Delta lê/escreve/filtra/agrega/migra dados persistidos |
| [Guardiã](../test-suite-guardian/SKILL.md) | Delta de comportamento/contrato/teste, refatoração de equivalência ou pedido de estratégia/manutenção |
| [Classificação de testes](../test-suite-guardian/references/classification.md) | Planejar durable/validation-only/none |
| [Operações de lifecycle](../test-suite-guardian/references/test-lifecycle.md) | Temporário planejado ou execução relevante pendente; não é carga universal |
| [Checkpoints](references/commit-checkpoints.md) | Planejar, validar ou retomar checkpoints locais |
| [Detalhes de compilação](references/compilation-details.md) | Detalhar work_type, diagnostics, rastreabilidade ou promoção de memória |
| [Template AWU](templates/agent-work-unit.md) | Emitir/refinar unidade; única estrutura canônica |
| [Template manifesto](templates/execution-manifest.yaml) | Emitir/refinar grafo/checkpoints; único formato canônico |
| [Template review](templates/review-manifest.md) | Derivar visão humana após emissão |
| [Executor](../awu-package-executor/SKILL.md) | Pedido de execução/retomada/status de pacote compilado; handoff após prontidão |
| [Workspace](../awu-workspace/SKILL.md) | Pasta do pacote contém `request.md`; consultar `status` para hash do pedido e próxima etapa |

Fontes declaradas de dados não são carregadas para edição só de prosa. Guardiã
recebe delta/contratos/fontes/action points normativos já resolvidos, sem cópia da
memória ou corpus. Não reabrir arquitetura resolvida nem escolher estratégia
paralela. Detalhe integral somente para decisão/bloqueio relevante. Relatórios de
conformity gap não entram no Collect padrão.

## Collect e Understand

Inspecionar somente requisitos, contratos, código/testes/config e trabalho ativo
afetados. Verificar comportamento existente; nome de arquivo ou AWU antiga não
são prova. Consultar unidade ativa somente para sobreposição/dependência real.
Identificar delta, estados atual/desejado, riscos, fronteiras e impacto em testes.
Comportamento já existente não gera unidade redundante; parcialmente existente
recebe só delta faltante. Separar fato, premissa e decisão pendente.

Pasta do pacote com `request.md` (frente do workspace): ele é o requisito de
origem. Pedido novo da conversa entra primeiro nesse arquivo; compilar de novo
refina o mesmo pacote, sem criar outro.

Antes de inferir padrão arquitetural do código, consultar harness normativo:
`arch.architecture_health` → `arch.find_playbooks` com objetivo/project_context →
matched `arch.get_playbook_context`. Resultado ambiguous exige decisão humana.
Partial/not_covered usa somente fallback MCP explícito `arch.search_governance`,
depois ID conhecido via `arch.get_artifact`. Referência normativa detalha cascata/gaps.
Offline/degraded segue corpus acessível no disco pelas regras de busca do projeto,
depois padrões locais repetidos declarados como inferência. Decisão de produto ou
arquitetura ainda sem resolução é normative gap: perguntar, nunca inventar norma.

Norma ≠ código é conformity gap do compiler, não do executor. Alinhar trabalho
tocado à norma, manter legado alheio fora do escopo; refatoração ampla bloqueante
exige decisão humana. Só ADR com scope repository autoriza exceção intencional.
Persistir gap fora do pacote em reports/conformity-gaps; nunca baixar norma,
transformar relatório em norma informal ou copiar diagnóstico para unidade. No
máximo uma linha de Scope referencia gap que restringe trabalho.

Delta de persistência dispara cascata de data sources e consentimento/identidade/
capacidades/limites aplicáveis. Cada fato de schema/routine/SQL precisa ser verified
ou code-derived da schema_authority. Fonte indisponível: mostrar hint e aguardar
humano; se continuar indisponível, fallback code-derived identificado. Divergência
exige resolução humana; migrations/config prevalecem sobre banco vivo. Nunca emitir
valores de linhas, credenciais ou connection strings. Executor não depende do banco
para recuperar fatos fechados na compilação. Sem delta: not_used justificado.

## Resolve

Fechar decisões antes da decomposição. Para decisão normativa, registrar
comportamento fechado, ID/proveniência canônicos quando usados, ação concreta na
AWU e gap none/recorded/blocked. “Seguir guideline X” é insuficiente. Para dados,
registrar source id ou path schema_authority, status verified/code-derived e fato
concreto de schema/routine/SQL. Não entregar corpus normativo ao executor.

Triagem identifica delta; guardiã é dona da estratégia. Invocá-la para mudança de
comportamento/contrato/teste ou refatoração de equivalência, com requisitos,
escopo, critérios, perfil, normas resolvidas e fontes atuais de código/config/testes.
Receber test-strategy.yaml ready com owner/oracle/nível/retenção/comandos exatos.
Guardiã ausente ou decisão material pendente bloqueia prontidão. Reconsultar em
mudança material; compiler não escolhe cobertura/retenção alternativas. Sem efeito
comportamental/contratual/de teste: not-applicable com motivo/evidência e decisions
vazio; sem plano cerimonial ou execução de suíte durante compilação.

Entrada da guardiã usa `temporary-tests.mjs status --all --summary`; execução
relevante pendente dispara detalhe/manual. ready fecha decisões, não resultados.
Prova que expira em integração posterior tem closure owner explícito e gate final
pendente; A chega ao gate técnico/checkpoint antes de seu consumidor I.

## Decompose e dependências

Uma entrega coerente, independentemente útil/verificável, por unidade executável
numa execução de agente. Dividir por resultado/responsabilidade/perfil real, não
quantidade de arquivos, tamanho do documento, tempo ou passos de implementação.
Integration-testing é própria quando tem escopo independente; não apenas por ser
etapa automática de desenvolvimento. Review/PR/merge mecânicos não viram AWUs.

Usar work_type: development, integration-testing, code-review, troubleshooting,
documentation conforme trabalho. Sem campos agent/model/harness/executor concreto;
camada de execução mapeia capacidades. Não criar AWU só para planejar testes.

Aresta expressa comportamento/contrato/artefato compartilhado/pré-requisito real de
validação consumido. Rationale somente no manifesto, até 240 caracteres. Preferência
de ordem não é motivo. Preservar independência e derivar paralelismo do DAG;
execução ainda exige isolamento/ownership. Não criar dependência para serializar Git.

Planejar checkpoints proporcionais em resultados validados/fronteiras de integração.
Pacote pequeno pode ter um; sem AWU só de commit, WIP falho ou commit vazio de
baseline. after_units são gates técnicos de implementação/validação/revisão.
Somente owner_unit espera seu checkpoint para concluir. before_units contém
consumidores reais já transitivamente dependentes. Não criar ciclo entre conclusão
e checkpoint. Fechar escopo/exclusões/gates/mensagem conforme perfil/evidência pelo
protocolo canônico; sem SHAs previstos na compilação.

## Compile

Usar templates canônicos, sem exemplos copiados neste núcleo. IDs kebab-case
incluem feature/domínio: user-auth-core, nunca awu-1/task-1. Emitir só decisões
necessárias ao owner e referências para detalhe. Comportamento, erros, contrato
crítico, escopo, implementação concreta, critérios objetivos e comandos reais
precisam permitir execução independente. Não substituir implementação pedida por
placeholder, fake de produção, TODO, bypass ou sucesso hardcoded. Fakes de teste
somente onde permitidos pelas diretrizes.

Usar só normas aplicáveis, em geral playbook selecionado e regras vinculadas.
Evidence cita IDs/proveniência, sem corpus. Transportar restrições não óbvias do
perfil; não copiar perfil/memória/estratégia inteira/manual para cada unidade.
Decisões de teste pertencem ao owner, sem matriz duplicada por caller. Plano de
execução é local ao agente, não outra especificação.

YAML deve caber em parseSimpleYaml de awu-workspace/scripts/lib/profile.mjs:
mapeamentos, sequências, listas inline e escalares de uma linha entre aspas.
Sem anchors/aliases/tags ou continuação multilinha de escalar. Validar round-trip
pelo parser real; parser YAML completo sozinho não basta. Escalar de sequência
com dois-pontos e espaço vira mapeamento mesmo entre aspas: usar — em diagnostics
e comparar tipos/valores lidos com dados pretendidos, não só sucesso de parse.
Não normalizar YAML não suportado silenciosamente em nome do executor.

## Validate

Revisão de completude antes de prontidão:

1. Objetivo, comportamento atual/esperado, erros, critérios e escopo explícitos.
2. Componentes/contratos/fontes autoritativas identificáveis e disponíveis.
3. Nenhuma decisão de negócio/arquitetura/teste depende de conversa ou premissa
   não documentada; executores competentes não escolhem comportamentos materiais
   diferentes por ambiguidade. Conhecimento necessário explícito ou alcançável.
4. work_type correto, IDs semânticos, dependências reais acíclicas; rationale
   limitado e só no manifesto. Convenções do perfil alcançáveis.
5. Cada fato de schema/routine/SQL verified ou code-derived com evidência.
6. Estratégia da guardiã ready ou not-applicable justificado; owner/oracle/nível/
   retenção/runner/config/seleção/risco residual fechados. Resultado atual só após execução.
7. IDs/referências/owners/consumidores/gates/paths/mensagens de checkpoints coerentes
   com DAG; espera do owner não bloqueia provedor técnico nem cria ciclo.
8. Gate final exige validação/revisão, guardiã closed ou ausência verificada, prova
   durável, aprendizado avaliado, entrega exigida e retirada do pacote por último.
   Checkpoint intermediário é local: nunca finish do workspace, push ou PR.
9. Formatos/links/paths/comandos existem; YAML passa round-trip real. Sem credenciais,
   linhas brutas ou corpus anexado. Sem expansão de escopo escondida em cleanup.

Item ausente bloqueia emissão como ready. Falha exige causa e correção, nunca
oracle reduzido, sleeps arbitrários ou repetir até ficar verde. Memória não
introduz bypass procedural. Registrar bloqueio concreto não resolvido.

## Emit e handoff

Emitir execution-manifest.yaml, specs e test-strategy.yaml em
`.harness/workspace/awu-packages/<package>/`, inclusive unidade única. Diagnostics
é metadado limitado de compilação: decomposition, couplings, rejected_alternatives,
execution_risks, data_sources; entradas até 240 caracteres. Sem arquivos separados
de raciocínio exploratório. Diagnostics não vira requisito nem histórico permanente.

Com `request.md` na pasta: emitir nela, `id` do manifesto igual ao nome da pasta
e `request.md` declarado em `package_inputs` com o `request_sha256` de
`workspace.mjs status`. Sem isso o executor recusa o pacote.

Após emitir, regerar review-manifest.md integralmente a partir das unidades/
manifesto atuais e código atual diretamente verificado. Review é projeção, nunca
segunda fonte de decisões. Dependências/rationales/checkpoints reproduzem manifesto;
detalhe ausente não é inventado. Usar template review, sem alterar AWUs ao derivá-lo.

Informar prontidão/bloqueios e entrada para execução explícita via awu-package-executor.
Não iniciar executor só porque pacote foi compilado. Executor planeja, implementa,
valida, revisa, verifica checkpoint, avalia aprendizado, fecha lifecycle e retira
inventário exato após gates finais. Git start/finish preservam interfaces e limites
de autorização existentes; compiler nunca publica.

AWUs não persistem como documentação atual. Promover aprendizado útil para
código/testes/docs autoritativas ou memória permitida; executor remove pacote por
último. Não conservar AWU concluída como histórico nem reconstruí-la como norma.
codebase-cleanup não é rito final: audita escopo solicitado; executor/guardiã fazem
limpeza operacional própria.
