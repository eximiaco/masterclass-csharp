# 2026-11-11 — Execução AWU: gymerp-legacy para .NET 10

Pacote `atualizar-versoes-das-bibliotecas-nuget-do-projeto` (3 unidades: correção de
`PaymentServiceTests`, migração net9→net10 com pacotes de runtime, migração de testes para
xunit.v3 + MTP). Execução `0cd342258369abfb21d9`. O trabalho técnico foi concluído e
commitado (`38e7091`, `7f4ba1f`, `1cceeaa`). O executor ficou `blocked` por limitação
estrutural até a correção da skill (`6b9ff1f`), e depois fechou o pacote. Provas em
`.harness/audits/test-strategy/atualizar-versoes-das-bibliotecas-nuget-do-projeto/0cd342258369abfb21d9/`.

Registro feito a pedido do usuário para refinar as skills depois.

## Resolução aplicada nesta frente (`6b9ff1f`, cópia local das skills)

- **Problema 4:** o `reconcile` passou a conferir os inputs cobertos por checkpoint
  verificado da própria unidade contra o blob do commit, não contra o worktree
  (`awu-package-executor/scripts/lib/evidence.mjs`, `verifyUnitInputs`). O teste WV8 reproduz
  o bug: falha no código antigo com `Prova/input alterado: source.mjs`.
- **Problema 3:** novo comando `package-state.mjs refine --reason --authorization [--invalidate]`
  (`scripts/lib/refine.mjs`, testes WV9). Ele mantém unidades e checkpoints, recalcula
  hashes, invalida a unidade cuja spec mudou e registra `refinements[]`.
- **Problema 5:** schema do arquivo de checkpoints documentado em `execution-protocol.md` e
  `awu-compiler/references/commit-checkpoints.md`.
- **Recuperação desta execução:** as validações das unidades 1 e 2 já estavam apagadas
  pela invalidação indevida (ocorrida no `record` da parada do Verify). Foram
  reconstruídas a partir dos eventos originais (`reconstruct-validations.mjs`), com os
  checkpoints recalculados pela própria `checkpoint()` do helper. A unidade 3 foi
  revalidada no HEAD `6b9ff1f`. A autorização está em `authorization-refinements.md`.
- **Continuam abertos para o upstream (AI Playbook):** problemas 1, 2, 6, 7, 8, 8a e 8b,
  e a regra de topologia no compiler. A suíte do executor tem 2 falhas preexistentes
  alheias ao ajuste: WV6 depende do `.gitignore` do projeto, e o teste do `run-e2e` importa
  `contexts/core`, que não existe aqui.

## Problemas nas skills / harness

1. **`awu-workspace start` troca a branch da pasta principal.** O `start` levou a pasta
   principal de `chore/update-harness-skills` para `main` (`main_tree.action: updated`).
   As skills novas só existiam na branch antiga, então o Skill tool passou a carregar
   o `awu-compiler` antigo de `.claude/skills/`. O pacote saiu sem `test-strategy.yaml`,
   checkpoints e `package_inputs`, incompatível com o `awu-package-executor` novo.
   Também sumiram `workspace.mjs` e `package-state.mjs`. Causa: skills não mescladas na
   branch de desenvolvimento, com o `start` atualizando a pasta principal sem avisar.
2. **O isolamento de worktree do Claude Code conflita com o executor.** O `awu-workspace`
   manda usar `EnterWorktree`. Mas o executor grava estado, eventos e provas em
   `common_root` (`.harness/workspace/package-executions/`, `.harness/audits/`,
   `.harness/workspace/commit-checkpoints/`), e a sessão isolada recusa escrever fora do
   worktree. Foi preciso `ExitWorktree keep` e operar com `--repo`.
3. **Não há fluxo para refinar o pacote durante a execução.** Qualquer byte alterado no
   pacote (`request.md`, spec, manifesto) bloqueia `resume` com `Pacote alterado/recriado`.
   Decisões legítimas do usuário no meio da execução (DI da Api, remoção do Verify)
   exigiram duas reconciliações manuais dos hashes em `state.json`, autorizadas pelo
   usuário (`reconcile-package-refinement.mjs`, backups `state.json.bak-*`).
4. **O `reconcile` invalida unidades concluídas que compartilham arquivos.** A cada
   `resume` ou `close`, o helper confere os `validation.inputs` de unidades concluídas
   contra os bytes atuais do worktree e exige que batam com `input_hashes` do checkpoint.
   A unidade 3 editava, por desenho, `PaymentServiceTests.cs` e
   `Gymerp.IntegrationTests.csproj`, que eram inputs das unidades 1 e 2. Resultado: todas
   as unidades invalidadas e `close` impossível. O compiler permitiu essa topologia e até
   registrou o acoplamento em `diagnostics.couplings`, mas o executor não a suporta.
   Falta regra no compiler (proibir ou modelar) ou suporte no executor (validar inputs
   contra o blob do checkpoint, não contra o worktree, depois do commit).
5. **O schema do arquivo de checkpoints não está documentado.** `validation_refs` é uma
   lista de paths (strings) e `input_hashes` é um mapa `path → sha256`. Com `{path, sha256}`
   o erro foi `Checkpoint sem referência de validação correspondente: [object Object]`.
6. **`reason` obsoleta persiste.** Depois de um `record` com ENOENT, o `reason` antigo
   ficou no estado mesmo com eventos posteriores aceitos, até um `resume`.
7. **Registrar evento com estado `blocked` também bloqueia.** `unit-started` após `resume`
   retornou `Unidade inelegível` e gravou isso como novo bloqueio.
8. **O helper aceitou evento malformado.** Um `unit-validated` com `inputs` vazio, gerado
   por falha minha de word-splitting no zsh (`$PATHS` sem `${=PATHS}`), virou bloqueio em
   vez de ser recusado antes de alterar o estado.

8a. **`workspace.mjs commit` só aceita `--message` de uma linha.** Não há como incluir
    corpo nem trailers (ex.: `Co-Authored-By` exigido pelo harness). Os 4 commits da frente
    saíram sem trailer de atribuição, e não reescrevi histórico para corrigir.
8b. **Diretório da execução cheio de auxiliares fora do inventário.** Ficaram em
    `.harness/workspace/package-executions/.../0cd342258369abfb21d9/` scripts ad hoc
    (`swagger-smoke.sh`, `hash-refs.mjs`, `record-checkpoint.mjs`,
    `reconcile-package-refinement.mjs`), logs e JSON de Swagger em `runtime/`, arquivos de
    evento e backups de `state.json`. O `close`/`retire` trata esses arquivos como
    inventário desconhecido. Falta na skill um lugar/protocolo para auxiliares do executor.
8c. **Obrigações não registradas.** `learning-evaluated` e `delivery-recorded` nunca foram
    registrados, porque o estado ficou `blocked`. O pacote segue em
    `.harness/workspace/awu-packages/`, sem `close`.

## Problemas na compilação do pacote (spec)

9. **Pré-requisito de SDK checado no PATH errado.** `dotnet --list-sdks` usava `~/.dotnet`
   (só 8/9), mas o SDK 10 já existia em `/usr/local/share/dotnet`. Gerou bloqueio falso.
   Checar também `/usr/local/share/dotnet/dotnet --list-sdks` e `DOTNET_ROOT`.
10. **Baseline vermelho.** 2–3 dos 9 testes falhavam em net9 (FK no arrange; `Random` em
    `PaymentService.ProcessAsync`). Rodar o baseline antes de compilar evitou um gate
    inválido: manter essa prática.
11. **Defeito de runtime preexistente só apareceu no smoke.** `Gymerp.Api` não subia em
    Development (`IPaymentGatewayService` sem registro, `ValidateOnBuild`). A compilação
    assumiu que a Api iniciava: subir o app no baseline antes de compilar critérios de runtime.
12. **Troca de licença numa major não foi verificada.** O Verify 33.x trocou MIT por EULA
    OSMF com SponsorCheck (`error SC021` quebra o build). A checagem de nuspec olhou TFMs e
    dependências, não licença. Em bumps de major, comparar `<license>` entre versões.
13. **Path de cobertura errado no critério.** Com `dotnet test --solution`, o MTP grava o
    `*.cobertura.xml` em `<solution>/TestResults/`, não em `<projeto>/bin/**/TestResults/`.
14. **Conflito transitivo previsto e resolvido na compilação.** Swashbuckle 11 exige
    `Microsoft.OpenApi` 3.x e `Microsoft.AspNetCore.OpenApi` 10 exige 2.x. Checar faixas
    de dependência entre pacotes que compartilham transitivos funcionou e deve continuar.

## Ambiente

15. **O hook `rtk` altera comandos.** Ele reescreve `grep`/`find`/`cat`: `grep -c` com
    parênteses dava "0 matches", `find` voltava vazio e `cat -A` não existe. Usar
    `rtk proxy <cmd>` quando o resultado for ambíguo.
16. **Em scripts zsh de uma linha, lista de paths em variável precisa de `${=VAR}`** para
    word-splitting.

## Decisões do usuário durante a execução

- Registrar `AddHttpClient("PagarMe")` + `IPaymentGatewayService` no DI da Api, sem
  configuração `PagarMe:*`. O Worker ficou com o mesmo defeito, fora de escopo.
- Remover Verify, `FullEnrollmentServiceVerifyTests.cs` e `Services/Snapshots/`.
- Ajustar `~/.zshrc` para `DOTNET_ROOT`/PATH em `/usr/local/share/dotnet` (backup
  `~/.zshrc.bak-dotnet-20261111`).

## Encerramento da frente

- O PR foi aprovado e mergeado na `main` (`ef5d0e8`). O `workspace.mjs cleanup` (prova
  `content`, sem bloqueios) removeu o worktree e a branch local e levou a pasta principal
  para a `main` por fast-forward.
- O push foi feito com `git push -u` e não pelo `workspace.mjs finish`, porque o usuário pediu
  só o push. Por isso o `status` da frente continuou `pushed_sha: null` / `pull_request: null`
  até o cleanup.

## Questão em aberto para o refino das skills (levantada pelo usuário)

- **A limpeza do ambiente deveria acontecer logo após o push?** As alterações já estão na
  `origin` nesse momento, e hoje o `cleanup` só roda depois do merge (`not-merged` bloqueia)
  e com pedido explícito. Pontos a avaliar, sem decisão tomada:
  - **A favor:** libera disco e worktree cedo, e a branch remota guarda todo o conteúdo
    commitado.
  - **Contra:**
    - ajustes de review hoje são commitados na mesma frente com novo `finish`
      (`references/delivery.md`), e seria preciso recriar o worktree a partir da branch remota;
    - provas locais não rastreadas (`.harness/audits/**`) já ficam na raiz comum, mas outros
      ignorados do worktree (builds, `.harness/workspace/`) seriam perdidos;
    - o PR pode ser rejeitado ou exigir rebase.
  - **Possível desenho:** uma limpeza "leve" após `finish` (remover builds e outputs) e a
    remoção do worktree e da branch só após o merge; ou um `cleanup --after-push` que exija
    a branch remota igual ao tip local e permita recriar o worktree por `start` na mesma branch.
