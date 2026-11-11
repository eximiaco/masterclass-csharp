# Protocolo do helper de execução — schema 1

Node >=22, ESM, sem dependências adicionais. Git read-only reutilizado de
awu-workspace; YAML pelo parseSimpleYaml existente. Recursos YAML não
suportados (anchors, aliases, tags, escalares multilinha) devem falhar, não ser
convertidos silenciosamente. Compiler valida round-trip no parser real.

## Estado e identidade

`begin --manifest <path>` captura branch/worktree/commonRepoRoot, HEAD/status
incluindo staging anterior, hashes de manifesto/specs/estratégia/review e inventário.
Destino local fixo: `.harness/workspace/package-executions/<package-id>/<execution-id>/state.json`
na raiz principal comum. ID deriva de branch/worktree; hash divergente bloqueia,
não cria execução paralela. `status|next|resume|close --state <path>` e
`record --state <path> --event <json>`; `--full` retorna detalhe. `--repo <worktree>`
aponta a frente quando o processo roda em outro diretório.
Após fechamento, mesmo path lógico consulta arquivo final em audits. `retire`
trata execução concluída legada ou retoma retirada operacional interrompida.

Inputs adicionais do pacote, como fixtures fechadas, devem ser declarados em
`package_inputs` no manifesto: lista opcional de `{path, sha256}`, com path
relativo à pasta do pacote (prefixo `./` opcional) e SHA-256 dos bytes atuais.
Não aceita glob, traversal, links, credenciais, hashes divergentes nem arquivos
não declarados. Inputs entram no inventário exato, na reconciliação e nos recibos
de retirada junto às specs; não são comandos nem autorização de execução.

Estados do pacote: planned/running/blocked/paused/finalizing/completed.
Unidade: pending/running/technical-complete/completed/blocked. Intenção de
unit-started precede efeitos; resultado observado é registrado depois. Resume
marca tentativa running sem confirmação como interrupted; conferir efeitos
antes de nova tentativa. Unidade técnica pode prover dependências antes do
commit final do owner, sem ciclo A→I. before_units exige checkpoint consumido.

Estado usa escrita atômica e lock exclusivo. PID morto verificável permite
recuperar lock; PID ativo, EPERM, conteúdo ilegível ou links bloqueiam. Symlinks,
hard links e traversal são recusados em inputs/estado/evidência/pacote. Não se
assume que JSON sozinho comprova revisão semântica ou autorização de publicação.

## Eventos

Todos têm `schema_version: 1` e `type`. Campos adicionais não são comandos.
`unit_id` ou `checkpoint_id` precisam existir no manifesto.

| type | Campos materiais |
| --- | --- |
| unit-started | unit_id; registrar antes de efeitos |
| unit-validated | unit_id, result passed/failed, source_revision, inputs, evidence, review; lifecycles opcional com IDs reais |
| unit-completed | unit_id; gate técnico e checkpoint próprio verificados |
| checkpoint-verified | checkpoint_id, checkpoint_state igual a commit_policy.execution_state |
| learning-evaluated | classification none/semantic/episodic/procedural, reason; destination obrigatório salvo none |
| delivery-recorded | mode local/published, evidence; authorization obrigatória para published |
| stop | status blocked/paused, reason |

`inputs`, `evidence` e `authorization` são referências `{path, sha256}`; review e
destination são uma referência, listas não vazias nas provas. Inputs são
relativos ao worktree; provas à raiz comum, sanitizadas e fora do workspace.
Hashes são SHA-256. Revisão de validação deve ser HEAD observado. Inputs/provas
alterados invalidam unidade/consumidores e suas obrigações. Corrigir causa e
revalidar somente afetados; código não escolhe estratégia nem reduz oracle.

Checkpoint externo schema 1 contém package_id e checkpoints indexados por ID.
Registro exige status committed/reused, commit_sha, parent_sha, branch, worktree,
changed_paths exatos, validation_refs e input_hashes de fontes UTF-8 do commit.
Conferir conteúdo/ancestralidade; exclusões e staging seguem
[protocolo canônico](../../awu-compiler/references/commit-checkpoints.md).
Hashes continuam cobrindo os bytes validados no worktree. Quando Git transforma
esses bytes ao gravar o blob (por exemplo, CRLF para LF), o executor exige hash
atual idêntico ao validado e compara o blob obtido por `git hash-object --path`
com o blob do commit. Não normaliza hashes nem aceita conteúdo divergente.
Sem mudança: status no-change exige no_change_reason, source_revision ancestral,
branch/worktree, validation_refs, input_hashes de fontes rastreadas inalteradas e
evidence com hashes reais. Conferir conteúdo no commit, inputs e validação da
unidade; HEAD sozinho não é prova. Não fabricar commit vazio. Política opcional
required_delivery: published bloqueia close enquanto entrega publicada não foi
registrada com autorização/prova; omitida, entrega local é suficiente.

## Fechamento e recuperação

`close --event <json>` recebe schema_version 1 e grupos discovery/references/affected,
cada um com result passed, exit_code 0, command real e artifacts [{path,sha256}].
Conferir prova integral; booleano não substitui log/revisão. Sem aprendizado,
lifecycle closed/none verificado, checks, checkpoints e entrega requerida, não
há remoção. Local é entrega válida quando autorização/manifesto pedem só checkpoints
locais. Published não é realizado pelo helper; fluxo existente produz prova.

Registros de guardiã próprios são identificados por feature do pacote e IDs
registrados nas validações. Registros fechados precisam de arquivos arquivados
íntegros. Terceiros pendentes ficam preservados; sobreposição de paths bloqueia.
No linked worktree, executar lifecycle no worktree que o criou. A guardiã grava
registro e provas (`.harness/audits/`) na raiz comum; nada durável fica no worktree.

Retirada: persistir cleanup_intent + inventário; cada arquivo recebe removing
antes de unlink e removed depois. Resume aceita ausência apenas com esse recibo.
Arquivos novos/divergentes preservados; rmdir só diretórios vazios conhecidos.
Fechamento repetido revalida evidências/recibos e bloqueia recriação divergente.
close arquiva fatos finais e retira estado/checkpoints/registros closed/resultados
próprios conforme [retenção operacional](operational-retention.md). Consulta e
idempotência usam arquivo final; workspace não guarda cópia histórica. Arquivamento
pendente é exibido como finalizing, com cleanup pendente. Arquivo corrompido ou
conteúdo divergente bloqueia, sem sobrescrever para seguir.
Não há retomada automática após término do processo; nova invocação é necessária.
