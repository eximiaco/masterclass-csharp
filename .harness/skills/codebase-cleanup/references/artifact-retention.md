# Retenção de artefatos do harness

Fontes compartilhadas: AGENTS, perfil, guidelines, skills/scripts/templates e
memória curada. Devem permanecer rastreadas e pesquisáveis. Exclusão global
em gitignore/rgignore que esconda essas fontes é achado config-ignore.

Runtime local: `.harness/workspace/` (exceto awu-packages/.gitkeep), estados de
execução/checkpoints/lifecycles, pacotes ativos, provas detalhadas de audits,
reports e relatórios plans/cleanup-*. Exclusão deliberada não é achado.
Ler diretório ignorado só quando escopo explícito pede detalhe relevante.

Compartilhar `.harness/audits/README.md` e `summaries/`: resumo curado contém
resultado, limites e fontes atuais; não cópia integral de registro/prova. Prova
integral exigida por helper permanece íntegra localmente com retenção deliberada.
Local não significa backup compartilhado. Informação necessária à equipe pede
resumo ou pendência rastreada; regra atual não depende só de JSON ignorado.

## Encerramento de runtime próprio

Ignorado pelo Git não significa que deva permanecer em disco. Ao criar runtime,
o executor registra owner e destinos exatos, inclusive fora de `.harness` ou em
`/tmp`. No encerramento autorizado, distingue:

- **Retido:** estado/checkpoints/lifecycle necessários a trabalho ativo e provas
  sanitizadas integrais referenciadas. Após entrega verificada, executor consolida
  fatos terminais em arquivo final e retira cópias operacionais próprias conforme
  [retenção operacional](../../awu-package-executor/references/operational-retention.md).
  Verificar arquivos e hashes antes e depois da retirada de runtime.
- **Descartável após uso:** diretórios das execuções E2E próprias, resultados e
  traces brutos, relatórios HTML/blob, diagnósticos, cópias intermediárias,
  `bin/obj` de probes e dependências/SDKs instalados exclusivamente para a tarefa.
  Arquivar primeiro fontes necessárias à reprodução e provas exigidas; conferir
  que referências necessárias apontam ao arquivo canônico, não à cópia descartada.

Limpeza pertence ao executor da tarefa; a guardiã continua dona dos testes
temporários registrados. Encerrar testes ou derrubar containers não remove esses
outros artefatos. Limite de execuções antigas do runner também não substitui
limpeza final. Não duplicar arquivos só para conservar todas as tentativas.

Após último consumidor, verificar ausência de uso ativo e inventariar paths,
tipos, tamanhos e hashes atuais. Remover apenas itens próprios conferidos,
sem seguir symlinks para destinos externos; remover diretórios próprios só vazios.
Ownership ambíguo, conteúdo alterado ou prova ainda dependente exige reconciliação,
preservando bytes. Não concluir pacote com descarte próprio obrigatório pendente.
Pacote é retirado após gates/runtime; cópias operacionais só saem após arquivo
final verificado pelo executor. Autorização para finalizar
inclui esse descarte elegível; não exige auditoria global nem nova confirmação.

Registrar resultado em recibo compacto junto ao estado existente: destinos,
contagens/bytes removidos, integridade das provas retidas e pendências concretas.
Não gerar novos planos, relatórios extensos ou memória para narrar a limpeza.

## Barreira de Git

Antes de cada checkpoint/entrega, conferir `git check-ignore -v` para os destinos
de runtime e inspecionar paths e conteúdo do staging (`git diff --cached`).
Corrigir exclusão ausente no escopo responsável; não ignorar `.harness` inteira.
Ignorar não protege arquivos já rastreados nem impede `git add -f`: conferir
também `git ls-files` e o índice real. Runtime, binários gerados, traces brutos e
credenciais não podem integrar o commit. Provas sanitizadas ficam locais conforme
esta política; compartilhar somente fontes e resumos curados pertinentes.
Usar seleção exata de paths e preservar staging alheio. Se runtime já estiver
rastreado ou staged, reconciliar sua retirada do índice sem apagar trabalho
alheio; não reescrever histórico nem presumir que adicionar gitignore resolveu.

Não existe TTL, daemon ou autorização implícita de expurgo. Arquivo ativo não
é lixo por idade. Retirada do índice preserva bytes locais e não apaga blobs
em commits anteriores; reescrever histórico exige tarefa/autorização separada.

codebase-cleanup é auditoria read-only, escreve só relatórios e propõe dispatch.
Não remove achados nem é etapa ritual de todo pacote. Executor finaliza somente
inventário próprio por hashes/recibos; guardiã controla temporários registrados.
Memória é auxiliar e não pode esconder achado contrário a fonte superior.
