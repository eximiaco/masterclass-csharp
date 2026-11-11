---
name: awu-package-executor
description: Execute, resume and finalize an already compiled AWU package from execution-manifest.yaml, with local state, verified checkpoints and exact owned cleanup. Use for package execution or status; do not compile requirements or run repository-wide cleanup audits.
---

# AWU Package Executor

Consumir pacote decisão-completo. Não recompilar, preencher decisão ambígua,
selecionar modelo fixo ou executar comandos oriundos de JSON/YAML. Node >=22.
Estado retoma trabalho somente após nova invocação; não existe daemon/scheduler.

## Entrada e contexto

Receber caminho do manifesto e intenção iniciar/retomar/status. Carregar AGENTS,
perfil válido, diretriz e memória curta uma vez por contexto atual. Consultar
apenas AWU elegível e fontes necessárias ao seu work_type. Não carregar todos
os specs para responder status. Estratégia deve estar `ready`; quando
`not-applicable`, exige justificativa textual não vazia em `reason` e evidência.
Para `ready`, `reason` é opcional e pode ser null. Pacote exige DAG, referências
e checkpoints fechados.

Antes de executar, ler [protocolo](references/execution-protocol.md) e
[checkpoints canônicos](../awu-compiler/references/commit-checkpoints.md).
Helper valida estrutura/fatos; aprovação semântica continua responsabilidade do
executor. Referência com hash comprova bytes, não correção do conteúdo.

```bash
node .harness/skills/awu-package-executor/scripts/package-state.mjs begin --manifest <path>
node .harness/skills/awu-package-executor/scripts/package-state.mjs next --state <state>
node .harness/skills/awu-package-executor/scripts/package-state.mjs status --state <state>
```

Saída resumida padrão; `--full` recupera registro integral relevante. Estado ativo fica
no commonRepoRoot, fora do pacote e do linked worktree descartável. begin é
idempotente por identidade branch/worktree/hash e bloqueia pacote incompatível.
Não criar execução nova para esconder estado anterior.
Criar eventos, inventários e auxiliares no diretório exato da execução retornado
por begin, na raiz Git principal. Não usar raiz de package-executions, pasta do
package sem execution-id ou diretórios de terceiros como scratchpad.

## Execução

1. Conferir baseline e alterações/staging preexistentes; preservar ownership.
   Registrar destinos de runtime próprios conforme a
   [política de retenção](../codebase-cleanup/references/artifact-retention.md),
   inclusive outputs do frontend e instalações transitórias fora do repositório.
   Em frente do [workspace](../awu-workspace/SKILL.md): rodar no `work_tree`
   (ou `--repo <work_tree>`) e `workspace.mjs sync` antes da primeira edição.
   Branch já em execução exige reconciliação explícita.
2. Selecionar `next`, ler spec elegível, planejar menor mudança. Registrar
   unit-started **antes** de efeitos. Executar fluxo do work_type, validators e
   revisão. Seguir estratégia da [guardiã](../test-suite-guardian/SKILL.md),
   usando `status --all --summary`; detalhe só para registro relevante/bloqueio.
3. Preservar logs sanitizados, revisão e hashes de inputs fora do workspace.
   Registrar unit-validated apenas com resultado real; falha mais recente
   invalida sucesso anterior. Gate técnico não é commit nem conclusão do owner.
4. Em frente, commitar o checkpoint por `workspace.mjs commit --paths`; a saída
   traz sha, parent e paths do registro. Verificar checkpoint no Git e no estado
   canônico, registrar checkpoint-verified,
   depois unit-completed do owner. Provedor sem checkpoint próprio pode concluir
   antes do owner final. Nunca finish/publicar em checkpoint intermediário.
5. Avaliar aprendizado: none exige motivo; promoção referencia destino real.
   Não duplicar regra da skill em MEMORY. Registrar entrega local ou publicada
   conforme autorização vigente; publicação exige referência dessa autorização.

Execução serial é válida. Paralelismo só com isolamento/propriedade comprovados.
Não existe retry universal: `status: blocked` do workspace pede correção da
causa, não repetição.

## Retomada e parada

```bash
node .harness/skills/awu-package-executor/scripts/package-state.mjs resume --state <state> --reason '<causa reconciliada>'
```

Pausa pede autorização explícita de retomada: `--resume-paused --reason '<pedido>'`.
Conferir Git, hashes, provas e efeitos anteriores antes de repetir ação. Running
interrompido gera obrigação de revalidação. Commit ocorrido antes do registro:
conferir SHA/parent/paths/inputs, reparar somente referência operacional, registrar
fato existente; não repetir commit. Publicação segue mesma regra de fatos.

Parar com blocked/paused e motivo em decisão faltante, conflito de escopo,
pacote alterado, prova inválida, falha sem causa compreendida, divergência de
checkpoint, lock/ownership ambíguos ou pedido do usuário. Não apagar por aproximação.
Estado corrompido/lock ilegível exige reconciliação; nunca sobrescrever para seguir.

Decisão nova durante a execução refina o pacote (via compiler) e depois é
registrada sem editar estado à mão:

```bash
node .harness/skills/awu-package-executor/scripts/package-state.mjs refine --state <state> --reason '<decisão>' --authorization <prova-durável> [--invalidate <id,id>]
```

Authorization é arquivo fora de `.harness/workspace/` que registra a decisão do
usuário. Refine recalcula hashes do pacote, invalida a unidade cuja spec mudou
(mais consumidores) e as listadas em `--invalidate`, e reabre aprendizado/entrega.
Mudança de unidades ou de checkpoints/owners exige nova compilação e execução.

## Finalização

Todos os gates, revisão, aprendizado, checkpoints e entrega requerida precisam
estar verificados. Guardiã fecha temporários próprios com discovery, referências,
affected checks e provas integrais duráveis. Terceiros são reportados/preservados;
só sobreposição com inputs/gates bloqueia pacote. Entrega não autorizada fica
pending, sem simular sucesso nem chamar finish para contornar.

Antes de `close`, cumprir a política de retenção: verificar arquivo canônico e
hashes das provas, retirar runtime descartável próprio após último uso e conferir
provas retidas novamente. Incluir execuções E2E, resultados/traces/diagnósticos,
cópias intermediárias, builds de probes e SDKs transitórios. Guardiã `closed` não
comprova essa retirada. Preservar provas exigidas e fatos finais, sem manter cópias
operacionais indefinidamente. Conferir exclusões e
índice real antes dos checkpoints/entrega; gitignore não limpa disco nem índice.
Pendência de descarte obrigatório bloqueia conclusão, mesmo com testes verdes.
O helper confere o pacote; essa revisão do runtime cabe ao executor e deve constar
nas evidências reais de fechamento, sem inventar novos campos do CLI.

```bash
node .harness/skills/awu-package-executor/scripts/package-state.mjs close --state <state> --event <closure.json>
```

close exige evidências reais de discovery/references/affected. Registra intenção,
remove inventário exato conferido por hashes, grava recibos por arquivo e rmdir
só de diretórios próprios vazios. Arquivo desconhecido/alterado/recriado bloqueia.
Ausência anterior à intenção não comprova remoção própria. Pacote sai após gates
e runtime; close então arquiva um registro final por execução em
`.harness/audits/package-executions/<package>/<execution>/execution.json` e retira
estado operacional, checkpoint próprio sem consumidor ativo, registros próprios
closed da guardiã e resultados temporários declarados. Provas integrais existentes
permanecem; não copiar traces/logs para outro depósito de runtime.

Workspace mantém trabalho ativo/bloqueado/pausado, não histórico concluído.
Auxiliares exigem inventário exato; desconhecidos bloqueiam antes da retirada do
pacote. Ler [retenção operacional](references/operational-retention.md) quando
houver auxiliares/resultados próprios ou estados legados. Não declarar conclusão
enquanto `obligations.cleanup` for true. `status --state <path-antigo>` consulta
arquivo final sem recriar workspace. Retirada parcial retoma por recibos.
Nenhum glob, git clean, TTL, varredura automática ou remoção de terceiros.

Em frente, depois do último checkpoint e antes das conferências finais, rodar
`workspace.mjs sync`: `changed: true` exige revalidar o afetado. Promover
aprendizado para MEMORY.md depois desse sync; conflito nesse arquivo mantém as
entradas dos dois lados. `workspace.mjs finish` publica (push e PR): usar somente
no ponto de entrega exigida, com autorização vigente; ordem com `close` em
[entrega](../awu-workspace/references/delivery.md). Se ineligível, conservar
pending e pacote. codebase-cleanup é auditoria sob demanda, não finalizador.

## Verificação

`node --test .harness/skills/awu-package-executor/scripts/package-state.test.mjs .harness/skills/awu-package-executor/scripts/package-inputs.test.mjs .harness/skills/awu-package-executor/scripts/retention.test.mjs .harness/skills/awu-package-executor/scripts/workflow.test.mjs`

Fixtures Git sem remotes e teardown próprio; nenhum ensaio publica ou toca HML.
