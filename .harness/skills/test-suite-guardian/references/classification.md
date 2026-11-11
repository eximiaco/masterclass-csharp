# Test protection classification

Read during planning. Full operating protocol is needed only when a temporary
file is planned or relevant execution remains pending.

- durable: proteção recorrente com valor de detecção futuro, incluindo testes
  existentes reutilizados. Para acrescentar outra proteção, justificar lacuna,
  detecção incremental e custo de manutenção; recorrência do risco, sozinha,
  não exige duplicá-la em outro nível.
- validation-only: prova da entrega/transição com expiração objetiva e proteção
  durável identificada, inclusive composição de testes existentes, ou risco
  residual explicitamente aceito pelo responsável. Fechar paths, owners de criação
  e closure, inputs, exclusão nativa, oracle e evidência antes de criar. Um owner
  posterior real pode fechar A→I sem ciclo. Custo/tipo do teste não decide retenção.
- none: nenhum delta de teste; justificar reutilização de proteção existente ou
  not-applicable em prosa. Um critério pode ter evidência em cenário já existente.

Ampliação de valores por caminho já coberto é candidata a reutilização mais prova
temporária. Conferir branches por valor, schema, encoding, limites e consumidores
antes de aplicar essa classificação. Nova regra, fronteira descoberta ou defeito
recorrente sem proteção existente exige resolver sua cobertura futura.

A failing test, cost or case count never authorizes retirement. Uncertain future
risk blocks closure. Strategy ready closes decisions, not test results. Record
actual commands/config/selection, residual risk and source references in canonical
[template](../templates/test-strategy.yaml); do not copy matrices per caller.
