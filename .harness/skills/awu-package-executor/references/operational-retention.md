# Retenção operacional no fechamento

Executar após gates, entrega, aprendizado, arquivo de provas e closure da guardiã.
`close` faz retirada operacional automaticamente; `retire` retoma retirada
interrompida ou trata execução legada já concluída.

## Arquivo final

Um `execution.json` por execução em
`.harness/audits/package-executions/<package-id>/<execution-id>/` guarda estado
final, checkpoints próprios, snapshots de lifecycles, referências das provas e
recibos. Não duplica arquivos de prova. É histórico local, ignorado pelo Git,
sem promessa de backup remoto.

Estado/checkpoint/lifecycle ficam no workspace enquanto necessários a trabalho
ativo, bloqueado, pausado ou dependente. Só completed pode retirar estado; só
closed pode retirar registro da guardiã. Não transformar bloqueio em conclusão
para limpar pasta. Registros de outros owners permanecem.

## Auxiliares e resultados

Eventos, planos da guardiã e auxiliares do executor ficam no diretório exato
retornado por begin, na raiz principal. Não espalhar arquivos na raiz do package
ou nas quatro pastas globais; esses arquivos não ganham ownership por proximidade.

Preferir resultados temporários em
`.harness/workspace/test-results/<package-id>/<execution-id>/`. Antes do último
uso, preservar provas necessárias fora do workspace; não mover todo runtime para
audits como substituto do descarte.

O evento de close pode declarar grupo `retirement` com este formato:

```json
{
  "schema_version": 1,
  "package_id": "sample",
  "execution_id": "id-real-retornado-por-begin",
  "files": [{"path": ".harness/workspace/test-results/sample/id-real-retornado-por-begin/result.json", "sha256": "hash-real-dos-bytes"}]
}
```

Usar IDs/hashes reais. Files enumera somente auxiliares próprios do diretório da
execução, diretórios próprios de registros closed e resultados no prefixo acima.
Estado, checkpoint elegível e registro closed entram automaticamente; não
repeti-los. Evento no diretório próprio tem hash incluído automaticamente, sem
autorreferência. Desconhecidos, arquivos rastreados/sensíveis, links, divergências
e locks bloqueiam; diretório inteiro ou glob não é autorização.

## Retomada e legado

```bash
node .harness/skills/awu-package-executor/scripts/package-state.mjs retire --state <state.json> --event <inventario.json>
```

No comando retire, evento contém diretamente objeto acima. Omitir quando não
houver auxiliares. Plano persistido é autoridade na retomada; não substituir
inventário para contornar divergência. Conferir ownership do legado, uma execução
por chamada; não expurgar as quatro pastas em lote.

Helper verifica provas e grava intenção antes de unlink. Checkpoint consumido por
outra execução ativa fica preservado. Ausência sem intenção, conteúdo alterado ou
recriado bloqueia sem apagar bytes. Só diretórios próprios vazios são retirados.
Completed bruto com retirada pendente é exibido como finalizing; conclusão exige
recibo retired. Não reportar falha de limpeza como conclusão.

Consulta pelo antigo --state lê arquivo final e verifica provas/recibos. Escrita
em execução arquivada é recusada; nova implementação exige identidade própria.
Status --all da guardiã enumera registros operacionais restantes; closed retirado
fica no arquivo da entrega, sem reabrir lifecycle já encerrado.
