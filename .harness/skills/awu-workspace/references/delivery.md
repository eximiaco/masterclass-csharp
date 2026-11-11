# Sincronização e entrega

Ler ao executar `sync` ou `finish`, ao tratar conflito ou ao receber pedido de
push/PR.

## `sync`

Merge de `origin/<dev>` na branch da frente, sem stash nem rebase.

Quando rodar:

- antes da primeira edição de um pacote;
- depois do último commit de checkpoint, antes das conferências finais do
  executor (`affected`).

Resultado:

| Saída | Significado | Ação |
| --- | --- | --- |
| `changed: false` | A branch já contém `origin/<dev>` | Nada a revalidar |
| `changed: true`, `files` | Merge feito | Revalidar só o que o merge tocou; o executor invalida sozinho as unidades cujo input mudou |
| `blocked: dirty-tree` | Alteração rastreada sem commit | Commitar por `commit` e repetir |
| `blocked: sync-conflict`, `merge_open: false` | Conflito; merge abortado, árvore intacta | Parar e levar a decisão ao usuário |

Conflito só é resolvido com decisão do usuário (ele resolve ou autoriza):

1. `sync --keep-conflict` reabre o merge e lista os arquivos.
2. Resolver cada arquivo e `git add -- <arquivo>`.
3. `sync --conclude` confere que não restam conflitos nem marcadores e cria o
   commit de merge.
4. Revalidar tudo que os arquivos resolvidos afetam.

## `finish`

Publica a branch e garante o PR. Não commita e não remove o worktree.

Pré-condições, todas verificadas pelo script:

| `step` do bloqueio | Causa | Ação |
| --- | --- | --- |
| `dirty-tree` | Arquivo alterado ou não rastreado | Commitar ou remover; nunca descartar por conta própria |
| `merge-open` | Merge em andamento | `sync --conclude` |
| `package-pending` | Pacote em execução com gates pendentes | Concluir no executor |
| `nothing-to-deliver` | Sem commits além de `origin/<dev>` | Nada a publicar |
| `base-moved` | `origin/<dev>` mudou arquivos que a branch também mudou depois da última sincronização | `sync`, revalidar, repetir |
| `push` | Push recusado | Ler a mensagem; nunca forçar |

`base-moved` só olha sobreposição de arquivos. Mudanças em arquivos disjuntos
seguem e ficam a cargo do build de validação do PR.

Pull request (`pull_request.mode`):

- `created` ou `existing`: PR aberto pelo provedor do profile; `url` no retorno.
- `manual`: sem credencial ou remote não reconhecido. O push já aconteceu;
  entregar `create_url` ao usuário. Azure DevOps usa `AZURE_DEVOPS_PAT`; GitHub
  usa `gh` autenticado.

Opções: `--pr-title`, `--pr-body-file <arquivo>`, `--pr-footer "<linha>"`. O
corpo padrão lista a origem e os commits da branch.

Ajustes de review: commitar na mesma frente e repetir `finish`; o push atualiza
o mesmo PR. `status` mostra `unpublished` enquanto houver commit não publicado.

## Ordem com o executor

Depende de `commit_policy.required_delivery` do manifesto:

- **published**: unidades concluídas → `sync` → `finish` → registrar
  `delivery-recorded` no executor com a prova da publicação → `close`.
- **local** (padrão): unidades concluídas → `sync` → `close` → `finish` quando
  o usuário pedir.

`status` mostra `awaiting-delivery` quando só falta a entrega publicada.
