# Próximos passos assistidos — harness-repo-bootstrap

Este arquivo contém as instruções da etapa assistida por IA do bootstrap do AI Playbook. Execute-as em um harness com LLM, na ordem apresentada, e revise o diff gerado antes de commitar.

## Executar a skill generate-application-context

Carregue e execute a skill `generate-application-context` a partir de `.harness/skills/generate-application-context/SKILL.md`. A skill varre o repositório (linguagens, frameworks, runtimes, comandos e estrutura) e gera ou atualiza `APPLICATION.md` e `.harness/project-profile.yaml` com base em evidências.

Antes de executar, verifique se a skill está materializada no caminho indicado; se estiver ausente, instale o artefato `skills/generate-application-context` e só então prossiga.

## Passos pendentes

- [ ] Revise `README.md` e `CONTRIBUTING.md`, integrando conteúdo existente e preservando instruções locais válidas.
- [ ] Avalie hooks de Git e validações compatíveis com a stack real do projeto antes de instalar ou alterar automações.
- [ ] Execute as validações finais descritas em `.harness/tools/harness-repo-bootstrap/playbook.md` e revise o diff antes de commitar.
