# Review Manifest — {{title}}

> Visão consolidada para revisão humana, derivada dos Agent Work Units e do
> `execution-manifest.yaml`. Este documento não substitui nem altera as
> especificações que o originaram.

## Metadata

- **Package ID:** {{package_id}}
- **Execution manifest:** {{execution_manifest_path}}
- **Agent Work Units:** {{agent_work_unit_paths}}

## Executive summary

{{executive_summary}}

Resuma o objetivo e o resultado esperado exclusivamente a partir dos Agent Work Units. Referencie as especificações que sustentam o resumo.

## Proposed changes

{{proposed_changes}}

Consolide as alterações por comportamento ou resultado. Para cada alteração,
identifique os Agent Work Units correspondentes.

## Scope

### In scope

{{in_scope}}

### Out of scope

{{out_of_scope}}

Consolide somente os limites explicitamente registrados nos Agent Work Units.

## Agent Work Unit overview

| Agent Work Unit | Objective | Work type | Depends on |
| --- | --- | --- | --- |
| {{agent_work_unit_id}} | {{objective}} | {{work_type}} | {{dependencies}} |

## Dependencies and parallelism

{{dependencies_and_parallelism}}

Descreva somente a ordem e o paralelismo diretamente determinados pelo grafo
do `execution-manifest.yaml`, consolidando cada dependência com o rationale
registrado no manifesto. Não crie dependências, racionais ou estratégias
adicionais.

## Relevant contracts and decisions

{{contracts_and_decisions}}

Consolide contratos e decisões explícitos nos Agent Work Units. Para cada item,
indique sua fonte.

## Risks

{{risks}}

Inclua somente riscos explicitamente registrados nos Agent Work Units ou diretamente
evidenciados pelo código atual. Identifique a fonte de cada risco. Não especule
sobre riscos potenciais sem evidência.

## Human review attention points

{{attention_points}}

Destaque inconsistências, lacunas ou pontos de atenção somente quando forem
diretamente demonstráveis pelos Agent Work Units ou pelo código atual. Não infira
requisitos nem proponha decisões para completar informações ausentes.

Quando uma informação relevante não estiver especificada, registre
explicitamente `Não especificado nos Agent Work Units`.

## Consolidated acceptance criteria

{{acceptance_criteria}}

Consolide os critérios de aceite sem reinterpretá-los ou criar novos
critérios. Preserve a referência ao Agent Work Unit de origem.

## Consolidated validation

{{validation}}

Consolide somente as validações definidas nos Agent Work Units.

## Sources

{{sources}}

Liste todos os Agent Work Units utilizados e qualquer arquivo ou símbolo de código
consultado como complemento diretamente verificável. Não utilize versões
anteriores do `review-manifest.md` como fonte.
