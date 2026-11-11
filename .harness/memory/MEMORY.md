# Memória do projeto

## Ambiente de desenvolvimento

- SDKs .NET da máquina: 8/9/10 em `/usr/local/share/dotnet` (arm64); `~/.dotnet` só tem 8/9.
  Desde 2026-11-11 o `~/.zshrc` aponta `DOTNET_ROOT`/PATH para `/usr/local/share/dotnet`; shells
  abertos antes disso ainda resolvem `~/.dotnet`. Checar `which dotnet` antes de concluir que um SDK falta.
- Hook `rtk` reescreve `grep`/`find`/`cat`; quando a saída parecer errada, repetir com `rtk proxy <cmd>`.

## gymerp-legacy

- Testes de integração sobem SQL Server via Testcontainers (exige Docker); produção usa PostgreSQL (Npgsql).
- `Gymerp.Worker` não registra `IPaymentGatewayService`/`AddHttpClient`, e o host falha na validação de DI
  em Development (a Api foi corrigida em 2026-11-11). `PaymentGatewayService` exige `PagarMe:ApiKey`/`ApiUrl`.
- Verify ≥ 33 trocou MIT por EULA com taxa (SponsorCheck `SC021` quebra o build); foi removido do projeto.
  Não reintroduzir sem decisão de licença do responsável.

## Harness / AWU

- Problemas de skills observados na primeira execução completa de pacote: ver
  [episódio 2026-11-11](episodes/2026-11-11-awu-gymerp-legacy-net10.md). O executor local recebeu
  `refine` e reconcile por blob de checkpoint (`6b9ff1f`), mas essa correção ainda não está no AI Playbook:
  uma atualização das skills pelo lock pode sobrescrevê-la. Demais itens seguem pendentes upstream.
