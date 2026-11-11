---
name: awu-workspace
description: Abre, consulta, sincroniza, entrega e remove frentes de trabalho paralelas (um git worktree + branch + PR por US ou alteração) e roteia cada pacote AWU para a skill da próxima etapa pelo estado derivado. Use para começar uma US ou alteração, saber em que ponto está uma frente ou pacote, commitar dentro de um worktree, sincronizar com a branch de desenvolvimento, publicar (push e PR) e limpar após o merge. Não compila nem executa pacotes.
---

# AWU Workspace

**Frente** = worktree + branch + PR, fora da pasta principal. **Pacote** = pasta
em `.harness/workspace/awu-packages/<id>/` do worktree. Node >= 22.

```bash
node .harness/skills/awu-workspace/scripts/workspace.mjs <comando>
```

Saída: uma linha JSON. `status: blocked` traz `step` e os fatos para decidir;
não repetir a chamada sem mudar a causa.

## Regras

- Fase vem sempre de `status`, nunca da conversa. Seguir `next.skill`;
  `explicit_request: true` exige pedido do usuário antes de agir.
- Trabalhar só dentro de `work_tree`: ler, buscar e editar por caminhos a partir
  dele. Claude Code: `EnterWorktree` com `path: <work_tree>`. Outros harnesses:
  `cd <work_tree> && …` ou `--repo <work_tree>`. Busca em índice de documentos
  reflete a pasta principal: o conteúdo vem do arquivo no worktree.
- Commit só por `commit`; sincronização só por `sync`. Nunca `git stash`,
  checkout de outra branch, push forçado ou `reset --hard`.
- Provas (`.harness/audits/`) e estado do executor ficam em `common_root`.
- `finish` e `cleanup` só com pedido explícito do usuário.
- `main_tree` na saída do `status` indica edição ou commit fora do worktree:
  parar e avisar o usuário.

## Começar

1. Com work item: ler tipo e título no ALM, campos mínimos. Sem work item: usar
   a descrição do pedido.
2. `start --work-item <n> --work-item-type "<tipo>" --title "<título>"` ou
   `start --description "<texto>"`; `--no-package` para trabalho manual.
3. Entrar no `work_tree`. Faltando detalhe do pedido, perguntar tudo em um único
   lote e gravar em `request.md` do pacote.
4. Seguir `next`: `awu-from-user-story` (work item) ou `awu-compiler`. Depois de
   compilar, sugerir sessão nova no worktree para executar.

## Comandos

| Comando | Uso |
| --- | --- |
| `status [--workspace <id>] [--all]` | Frente atual; fora de uma frente lista todas |
| `start …` | Worktree de `origin/<dev>`, branch e primeiro pacote; idempotente |
| `package new --id <frente>-<sufixo>` | Pacote adicional, só a pedido |
| `commit --message "<msg>" --paths <p…>` | Commit local de paths exatos; devolve sha, parent e paths |
| `sync [--keep-conflict\|--conclude]` | Merge de `origin/<dev>`; `changed: false` dispensa revalidação |
| `finish` | Push e PR |
| `cleanup --workspace <id>` | Remove frente já mesclada |
| `lock acquire\|release\|status <recurso> --pid <n>` | Recurso único da máquina |

Recompilar refina o mesmo pacote; id de pacote nunca é reutilizado.

Ler só quando o gatilho ocorrer: [entrega](references/delivery.md) em `sync`,
`finish` ou conflito; [limpeza](references/cleanup.md) em `cleanup`.

## Verificação

```bash
node --test .harness/skills/awu-workspace/scripts/*.test.mjs
```
