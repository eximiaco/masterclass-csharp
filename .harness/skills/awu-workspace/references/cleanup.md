# Limpeza da frente

Ler ao receber pedido de limpeza depois do merge do PR.

`cleanup` remove o worktree e a branch local. É destrutivo: rodar só com pedido
explícito, a partir da pasta principal (Claude Code: `ExitWorktree` com `keep`
antes), e começar por `--dry-run` quando houver dúvida.

```bash
node .harness/skills/awu-workspace/scripts/workspace.mjs cleanup --workspace <id> [--dry-run]
```

## O que precisa valer

O script recusa com `cleanup-blocked` e lista `blockers`:

| `kind` | Causa | Ação |
| --- | --- | --- |
| `not-merged` | Conteúdo da branch não está em `origin/<dev>` | Aguardar o merge do PR; ver confirmação abaixo |
| `dirty-tree` | Arquivo alterado ou não rastreado no worktree | Commitar ou decidir com o usuário |
| `active-execution` | Estado do executor ainda presente para o worktree | Concluir ou fechar a execução no executor |
| `active-lifecycle` | Testes temporários da guardiã não fechados | Fechar o lifecycle na guardiã |
| `evidence-conflict` | Arquivo de evidência igual em nome e diferente em bytes na pasta principal | Decidir com o usuário qual manter |

`inside-worktree`: o comando foi chamado de dentro do worktree que seria removido.

## Prova de merge (`proof`)

- `content`: mesclar a branch em `origin/<dev>` não altera a árvore. Cobre
  squash merge e funciona sem credencial.
- `pull-request`: o provedor confirma PR concluído cujo último commit de origem
  é o tip da branch. Usado quando a base reescreveu depois as mesmas linhas.
- `confirmed`: `--confirm <tip>` com o sha exato devolvido em `confirm_with`.

`--confirm` descarta commits que não estão na base. Usar somente depois de
mostrar `unmerged_commits` ao usuário e receber a confirmação dele; nunca
preencher o sha por conta própria para destravar a limpeza.

## Efeitos

1. Move para a pasta principal as evidências locais do worktree
   (`.harness/audits/**` e `.harness/reports/**` não rastreados), sem sobrescrever.
2. Grava os fatos finais em `.harness/audits/workspaces/<id>-<tip>.json`.
3. `git worktree remove` sem `--force`, `git branch -D`, `git fetch --prune`.
4. Atualiza a pasta principal por fast-forward quando ela está limpa.

O restante do worktree que o git ignora (builds, dependências, workspace do
harness) é apagado junto. Estado e provas do executor e da guardiã já vivem na
raiz comum e não são afetados.
