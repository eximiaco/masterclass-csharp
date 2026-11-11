---
name: awu-dev-preflight
description: Prepara a execução de um manifesto de Agent Work Units (fase start) e entrega o resultado no fim da execução (fase finish) respeitando a estratégia de branching declarada no .harness/project-profile.yaml. Cria work branch com nome convencional, atualiza a branch de desenvolvimento e entrega por pull request ou merge. Com worktree habilitado no profile, executa cada work unit em um git worktree isolado, sem tocar a árvore principal. Não descarta alterações, não força push e não exclui branches.
---

# AWU Dev Preflight

Prepare e finalize a execução de um manifesto de Agent Work Units (AWU).
Esta skill executa duas fases, sempre via scripts determinísticos em
Node.js (>= 22):

- **start**: no início da execução do manifest — analisa o profile do
  projeto, posiciona o repositório na branch de trabalho correta e, no modo
  worktree, cria um worktree isolado para a work unit;
- **finish**: no fim da execução do manifest — commita o entregável,
  publica a work branch, entrega por PR ou merge conforme o profile e, no
  modo worktree, remove o worktree da work unit quando está limpo.

Não execute esta skill fora do fluxo de execução de um manifest. Se um
manifest não estiver em execução, pergunte ao usuário antes de invocá-la.

## Configuração

A skill lê `.harness/project-profile.yaml`, seção `version_control.branching`:

| chave | valores | default |
| --- | --- | --- |
| `strategy` | `trunk-based` ou `git-flow` | `trunk-based` |
| `development_branch` | nome da branch de desenvolvimento | `main` (trunk-based), `develop` (git-flow) |
| `open_pr` | `true` abre PR; `false` faz merge direto | `true` |
| `work_branch_template` | com `{type}` e `{context}` | `{type}({context})` |
| `pr_provider` | `github` ou `azure-devops` | `github` |

`{type}` é o tipo Conventional Commit da work unit (`feat`, `fix`, `perf`,
`refactor`, `docs`, `test`, `build`, `ci`, `chore`, `revert`); `{context}` é
o nome da work unit em kebab-case. Exemplo: `feat(user-authentication)`.

Se o profile não existir ou a seção `branching` estiver incompleta, a fase
`start` cria o arquivo mínimo ou preenche só as chaves ausentes com os
defaults da tabela. Essa escrita acontece depois do checkout da work branch
e vira parte da entrega. A skill `generate-application-context` emite a
seção completa ao gerar o profile.

### Worktree (execução paralela)

Seção opcional `version_control.worktree` do profile:

| chave | valores | default |
| --- | --- | --- |
| `enabled` | `true` executa cada work unit em um git worktree próprio | `false` |
| `path` | diretório base dos worktrees, relativo à raiz do repo, sem `..` | `.harness/worktrees` |

No modo worktree:

- a fase `start` não exige a árvore principal limpa e não troca de branch
  nela; cria `git worktree add <path>/<type>__<context>` na work branch
  calculada a partir do tip do development branch;
- work units distintas podem executar em paralelo: cada uma tem work branch
  e worktree próprios (`feat__login`, `fix__header`);
- `<path>/` é registrado em `.git/info/exclude` (configuração local,
  idempotente) e não aparece no `git status` da árvore principal;
- a árvore principal permanece no development branch; se ela estiver na
  work branch da work unit, o `start` falha em `worktree-main-conflict`
  (o git não permite a mesma branch em duas árvores de trabalho);
- o estado por work unit fica em
  `.harness/workspace/preflight-states/<type>__<context>.json`; execuções
  legacy continuam usando `.harness/workspace/preflight-state.json`. Invocar
  uma fase legacy (worktree desabilitado) de dentro de um linked worktree
  falha em `worktree-invocation`.

## Fase start

Ao iniciar a execução do manifest, rode:

```bash
node <harness/skills>/awu-dev-preflight/scripts/preflight.mjs start --type <tipo> --context <contexto>
```

O script faz, em ordem:

1. valida o profile e a seção `branching` (aplica defaults se necessário);
2. valida o `--type` contra os tipos Conventional Commits e o `--context`
   em kebab-case;
3. confere que a árvore de trabalho está limpa, exceto arquivos em
   `.harness/workspace/` e o próprio `project-profile.yaml`;
4. `git fetch` + `git checkout <development_branch>` + `git pull --ff-only`;
5. cria a work branch a partir do tip da branch de desenvolvimento; se a
   work branch já existir sem commits, reaproveita-a;
6. grava o estado da execução em `.harness/workspace/preflight-state.json`.

`--dry-run` imprime o plano sem alterar o repositório.

No modo worktree, o script não faz checkout na árvore principal: faz
`git fetch origin`, sincroniza o development branch por fast-forward do ref
(`git fetch origin <dev>:<dev>`, sem checkout; se a branch estiver checked
out em outra árvore, o sync é skipado com nota e o `finish` reconcilia),
cria o worktree da work unit a partir do tip do development branch e
registra o estado. Reexecutar o `start` é idempotente (`already_started:
true` com o mesmo `work_tree`); uma execução interrompida é retomada pelo
próprio `start`, que recria o worktree preservando os commits da work unit
(`work_branch_action: "restored"`). A saída informa `work_tree`, caminho
onde os passos seguintes do manifest devem executar.

Se o início já ocorreu na work branch correta (modo legacy), o script
reaproveita o estado e não exige árvore limpa (arquivos do workspace
continuam ignorados).

## Fase finish

Ao terminar a execução do manifest (com entregável pronto), rode:

```bash
node <harness/skills>/awu-dev-preflight/scripts/preflight.mjs finish --type <tipo> --context <contexto> --message "<tipo>(<contexto>): <descricao>"
```

O script faz, em ordem:

1. valida a mensagem de commit quando `version_control.commits.style` for
   `conventional`, antes de qualquer staging;
2. adiciona explicitamente os arquivos alterados (com `git add -- <paths>`);
   arquivos em `.harness/workspace/` ficam fora do commit, salvo
   `--include-workspace`;
3. commita na work branch e publica com `git push -u origin <work_branch>`
   (nunca force);
4. entrega conforme `open_pr`:
   - `true`: abre PR no provedor declarado em `pr_provider` —
     `github` usa `gh pr create --base <development_branch>`; `azure-devops`
     usa a API REST do Azure DevOps (`api-version=7.1`) com a PAT em
     `AZURE_DEVOPS_PAT`; em ambos, se um PR aberto da mesma head já existir,
     reutiliza-o e reporta `created: false`;
   - `false`: faz checkout da branch de desenvolvimento, `git pull
     --ff-only`, `git merge --no-ff <work_branch>` e push; em conflito,
     aborta o merge, restaura o estado e reporta os arquivos em conflito.

A branch de trabalho nunca é excluída. `--pr-title` e `--pr-body`
sobrescrevem título e corpo do PR gerados por padrão. `--dry-run` lista o
plano sem alterar o repositório.

No modo legacy (worktree desabilitado), sem `--type`/`--context` a fase
`finish` usa a work branch gravada pela fase `start`. No modo worktree,
`--type` e `--context` são obrigatórios e identificam o estado e o worktree
da work unit.

No modo worktree, o merge direto (`open_pr: false`) roda em um worktree
temporário do development branch, criado e removido pelo próprio script, sem
tocar a árvore principal; se o development branch já estiver checked out na
árvore principal, ela precisa estar limpa (caso contrário, falha em
`merge-main-dirty`; se estiver checked out em um worktree de terceiro,
falha em `merge-dev-worktree`). Após a entrega, o script remove o worktree
da work unit quando está limpo:

- alterações não confirmadas fora de `.harness/workspace/`: o worktree é
  preservado (`worktree_keep_reason`); remover o conteúdo é decisão do usuário;
- workspace efêmero não entregue: o worktree é preservado; use
  `--include-workspace` (entrega o workspace no commit) ou
  `--remove-worktree` (descarta o workspace efêmero) na reexecução;
- `--keep-worktree` preserva o worktree explicitamente; os dois flags são
  excludentes.

A saída informa `work_tree`, `worktree_removed` e `worktree_keep_reason`.
Reexecutar o `finish` após a entrega é idempotente (`already_delivered:
true`), inclusive com o worktree preservado.

## Contrato de erro

Em qualquer falha o script imprime JSON estruturado em stdout e encerra com
exit 1. Exemplo:

```json
{
  "status": "error",
  "phase": "start",
  "step": "pull",
  "message": "git pull --ff-only origin main falhou",
  "command": "git pull --ff-only origin main",
  "exit_code": 128,
  "stdout": "",
  "stderr": "fatal: ...",
  "repo_state": { "branch": "main", "head": "..." },
  "suggestions": ["..."],
  "forbidden_actions": ["..."]
}
```

Saída de sucesso (`status: "ok"`) traz `phase`, `work_branch`,
`development_branch`, `open_pr`, `pr_provider`, passos executados e
próximos passos; no modo worktree, traz também `work_tree`,
`work_branch_action` (`created`, `reused` ou `restored`),
`worktree_removed` e `worktree_keep_reason`.

Ao tratar um erro em um harness com LLM:

1. leia `command`, `stdout` e `stderr` e investigue a causa raiz;
2. faça no máximo 2 correções seguras e reexecute a fase;
3. se o erro persistir ou a correção exigir qualquer ação listada em
   `forbidden_actions`, interrompa e apresente as opções ao usuário.

Ações proibidas para a skill e para qualquer tentativa de correção:

- descartar alterações locais (`git checkout/restore -- <path>`,
  `git reset --hard`);
- remover arquivos não rastreados (`git clean`);
- excluir branches, local ou remoto;
- forçar push ou reescrever histórico;
- apagar ou sobrescrever `.harness/project-profile.yaml` e artefatos do
  workspace do usuário.

Decisões que caem nessas ações pertencem ao usuário.

## Limitações

- No modo legacy, uma execução de manifesto por working tree; a fase
  `start` falha se a work branch calculada já existir com commits de outra
  execução. No modo worktree, cada work unit tem work branch e worktree
  próprios e unidades distintas podem executar em paralelo na mesma árvore
  principal.
- O merge direto no modo worktree exige uma árvore de trabalho livre para o
  development branch: o script usa um worktree temporário criado por ele
  mesmo (e o remove ao final) ou, quando o development branch já está
  checked out na árvore principal, exige a árvore limpa. Se o development
  branch estiver checked out em um worktree de terceiro, a fase `finish`
  falha em `merge-dev-worktree`.
- Os worktrees do modo worktree são configuração local do repositório
  (`git worktree` + `.git/info/exclude`); clonar o repo em outra máquina
  não os traz, e cada clone mantém seu próprio conjunto.
- A fase `finish` com `open_pr: true` exige credenciais do provedor:
  `github` precisa do GitHub CLI (`gh`) autenticado; sem `gh`, o script
  reporta `compare_url` para abrir o PR manualmente. `azure-devops`
  precisa da PAT em `AZURE_DEVOPS_PAT` com permissão de criar pull
  requests; sem PAT, o script reporta `pull_request_create_url` para
  abrir o PR manualmente.
- `git pull` e `git merge` rodam sempre com `--ff-only`/`--no-ff`; branches
  divergentes exigem decisão humana.
- O parser de YAML do profile é intencionalmente simplificado (mapeamentos,
  sequências, listas inline, aspas e comentários); documentos com âncoras,
  tags ou multi-line strings não são suportados e geram erro explícito.
- `pr_provider` e o formato do remote `origin` precisam combinar: remote
  GitHub exige `github`; remote Azure DevOps exige `azure-devops`. Quando
  divergem, a fase `finish` falha em `pr-remote-provider`; troque
  `pr_provider` ou `open_pr` com decisão do usuário.

## Consumo programático

O contrato de entrada e saída deste CLI é o documentado aqui e deve
permanecer estável entre versões patch. A disciplina de invocação por agentes
e skills (quando rodar cada fase, checklist pré-execução, tratamento de erros
e escalonamento ao usuário) é responsabilidade do harness consumidor.

## Verificação

Na raiz da skill, rode os testes de integração (não dependem de rede nem do
`gh` real):

```bash
node scripts/selftest.mjs
```
