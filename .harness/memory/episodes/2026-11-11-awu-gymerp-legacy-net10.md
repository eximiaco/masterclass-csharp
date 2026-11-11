# 2026-11-11 — Execução AWU: gymerp-legacy para .NET 10

Pacote `atualizar-versoes-das-bibliotecas-nuget-do-projeto` (3 unidades: correção de
`PaymentServiceTests`, migração net9→net10 com pacotes de runtime, migração de testes para
xunit.v3 + MTP). Execução `0cd342258369abfb21d9`. O trabalho técnico foi concluído e
commitado (`38e7091`, `7f4ba1f`, `1cceeaa`), mas o executor ficou `blocked` por limitação
estrutural. Provas em `.harness/audits/test-strategy/atualizar-versoes-das-bibliotecas-nuget-do-projeto/0cd342258369abfb21d9/`.

Registro feito a pedido do usuário para refinar as skills depois.

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
