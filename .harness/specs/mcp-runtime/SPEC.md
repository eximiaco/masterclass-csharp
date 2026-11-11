# SPEC — Runtime MCP local em containers (mcp-runtime)

Este documento é o contrato executável do runtime MCP local em containers. Ele consolida os compromissos normativos vigentes da [ADR-0001 — Runtime MCP local em containers](../../../docs/adrs/0001-runtime-mcp-local-em-containers.md), incluindo suas emendas, a [ADR-0008 — x-harness como terceiro serviço](../../../docs/adrs/0008-xharness-como-terceiro-servico-do-mcp-runtime.md) e a [ADR-0009 — wiring Cursor pelo mcp-runtime](../../../docs/adrs/0009-wiring-cursor-mcp-pelo-mcp-runtime.md), e é a fonte única a que skills, agents e demais artefatos se referem. A implementação vive no artefato `tools/mcp-runtime`, que depende desta spec.

As seções numeradas abaixo são normativas. Qualquer comportamento de implementação que contrarie uma seção é violação de contrato.

## 1. Papel do runtime

O `mcp-runtime` é orquestrador de ciclo de vida dos MCP servers: sobe, configura, expõe, atualiza e derruba os containers que executam os servers. Ele **não faz proxy das tools nem das chamadas** — não filtra catálogo, não agrega, não traduz, não intercepta conteúdo — e **nenhum processo do runtime fica entre consumidor e server**. Os artefatos consomem os MCP servers diretamente por dois modos de acesso:

- **stdio por conexão:** o consumidor executa o container por conexão (`nerdctl/docker run -i --rm`) falando stdio direto com o server;
- **HTTP persistente em loopback:** o transporte HTTP nativo do server, exposto em `127.0.0.1` pela stack persistente; para servers stdio-only, um adaptador pronto do ecossistema compõe a linha de comando do server dentro do container — nunca código do runtime no caminho. (ADR-0001 §1)

## 2. Provedores e fontes

Os MCP servers são executados pela stack do `mcp-runtime`, a partir de fontes pinadas, sem rebuild do código-fonte alheio quando a fonte for imagem ou pacote oficial:

- **GitHub MCP Server** (`github/github-mcp-server`): binário copiado da imagem oficial `ghcr.io/github/github-mcp-server`, pinada por digest em etapa de build da imagem do runtime.
- **Azure DevOps MCP** (`@azure-devops/mcp`): instalado do npm em versão exata — não existe imagem oficial; o pin é a versão npm exata.
- **x-harness** (MCP normativo Eximia): imagem própria publicada no GHCR (`ghcr.io/<owner>/x-harness-mcp`), pinada em `containers/pins.env` como `XHARNESS_MCP_IMAGE` (preferência por digest `@sha256:...`; tag de versão `v<VERSION>` admitida até o primeiro digest publicado — nunca `latest`). O **corpus normativo** não faz parte do pin: é entrada externa via bind-mount (`MCP_RUNTIME_ARCH_CORPUS` → `/app/repo:ro`). (ADR-0008)

A imagem do runtime (serviços `github` e `ado`) é publicada no GHCR pelo pipeline de release do repositório. O Azure MCP Server amplo (`Azure/azure-mcp`) está fora do escopo desta decisão. (ADR-0001 §2, §3; ADR-0008)

## 3. Contrato de consumo por skills

Skills referenciam ferramentas no formato `github.<tool>`, `ado.<tool>` e `arch.<tool>` — os nomes canônicos do contrato:

| Prefixo | Serviço | Exemplos |
|---------|---------|----------|
| `github.` | `github` | tools do GitHub MCP Server |
| `ado.` | `ado` | tools do Azure DevOps MCP |
| `arch.` | `xharness` | `arch.architecture_health`, `arch.find_playbooks`, `arch.get_playbook_context`, `arch.search_governance`, `arch.get_artifact` |

É proibido em skills: prefixos de harness (`mcp__...`), URLs, headers HTTP, comandos de autenticação, tokens e qualquer detalhe interno de server. Credenciais não existem em nenhum artefato, manifesto ou materialização. (ADR-0001 §3; ADR-0008)

## 4. Autenticação

A autenticação dos serviços consumidos acontece dentro dos containers, com a identidade do próprio usuário:

- **Azure (Azure DevOps MCP):** Entra interativo via sessão do Azure CLI dentro do container (`az login --use-device-code --allow-no-subscriptions`), retransmitida ao terminal do host; tokens e estado de sessão permanecem no container, em volume dedicado. O login é orquestrado pelo próprio `up` — nenhum comando novo (§8): depois do start, o `up` checa a sessão **dentro do container** com `az account get-access-token --resource https://app.vssps.visualstudio.com -o none`; sem sessão válida, executa o login com `exec` no container em execução e retransmite stdout e stderr do `az` linha a linha ao terminal do host, com o prefixo `[az] ` (o código de device code é lido do stderr do `az`), sob timeout próprio de 600 s; ao final repete a checagem e só considera a stack pronta se ela passar. Sem TTY no host, a CLI **não** interage: imprime o comando manual (`<runtime> exec -i mcp-<contexto>-ado-1 az login --use-device-code --allow-no-subscriptions`) e falha. O `doctor` reporta o modo de autenticação e o estado da sessão, sem efeito colateral.
- **GitHub (GitHub MCP Server):** o server local autentica via PAT; o PAT cifrado com SOPS+age é o mecanismo concreto enquanto o server local não oferecer fluxo OAuth.
- **x-harness:** sem credencial — o serviço não lê o contexto SOPS nem exige variáveis de segredo. (ADR-0008)
- **Canal de distribuição:** o `gh auth` do host pertence exclusivamente ao canal de distribuição (baixar pacotes e releases) e jamais é lido, recebido ou conhecido pelo runtime.

Contextos de credencial são intransponíveis. (ADR-0001 §4)

## 5. Segredos at-rest

Segredos são armazenados cifrados com **SOPS (backend age)**, nunca em plaintext:

- um `secrets.sops.env` (formato ENV do SOPS) por contexto de cliente;
- uma chave age por contexto de cliente, com isolamento criptográfico entre contextos;
- múltiplos recipients por arquivo, permitindo rotação de recipients sem rotação de valores;
- layout por contexto em `~/.config/ai-playbook/mcp-runtime/` — caminho unificado em todas as plataformas, com `keys/` (identidades por contexto) e `contexts/<contexto>/` (arquivo cifrado, recipients e configuração do SOPS);
- arquivos de segredo e chaves privadas não são versionados neste repositório.

**Variáveis obrigatórias por serviço.** O `up` valida o conteúdo do contexto decriptado **antes de qualquer start** e falha sem criar container (exit 1) quando falta variável obrigatória, nomeando a variável e o serviço e apontando o fix (`secrets edit --context <nome>`):

- `ADO_ORG` (serviço `ado`) — o server Azure DevOps não inicia sem a organização;
- `GITHUB_PERSONAL_ACCESS_TOKEN` (serviço `github`) — sem o PAT, o server GitHub responde 401 em toda tool call.

`AZURE_DEVOPS_PAT` é opcional e funciona como **seletor de modo**: presente ⇒ modo `pat`; ausente ou vazia ⇒ modo `azcli` (§4). A validação nunca imprime valores de segredo (§12).

**Configuração não secreta do serviço `xharness` (opcional).** O `up` resolve a variável de ambiente do host `MCP_RUNTIME_ARCH_CORPUS`: deve ser um diretório existente que contenha `arch-graph/graph-doc`. Quando **válida**, o serviço `xharness` entra no `compose up` e no handshake, com bind-mount no env-file gerado pela CLI. Quando **ausente ou inválida**, o `up` emite **aviso** (variável, serviço `xharness`, fix via `export MCP_RUNTIME_ARCH_CORPUS=...`), **omite** o serviço `xharness` e sobe `github`/`ado` normalmente — não é `exit 1` por causa do corpus. Essa variável **não** entra no SOPS. (ADR-0008)

A CLI oferece atalhos (`secrets`, `keys`) que **compõem os binários nativos** de SOPS e age — `age-keygen`, `sops edit` com a `SOPS_AGE_KEY_FILE` do contexto resolvida, `sops updatekeys` com a confirmação alimentada no stdin — com o layout e o ambiente do contexto: delegação sem reimplementação; a criptografia permanece 100% em SOPS/age. (ADR-0001 §5, §6)

## 6. Gestão de segredos por composição dos binários nativos

Toda a criptografia permanece nos **binários nativos de SOPS e age** — nunca reimplementada em código próprio. A CLI expõe atalhos que compõem cada operação nativa com o layout e o ambiente do contexto:

- `secrets init` — cria o contexto compondo `age-keygen` (identidade do contexto) e `sops --encrypt --age` (primeiro arquivo cifrado);
- `secrets edit` — `sops edit` do arquivo do contexto, com a `SOPS_AGE_KEY_FILE` resolvida no ambiente do processo (nunca em argumento);
- `keys add` / `keys remove` — atualização de `recipients.txt` e da configuração do SOPS com reencapsulação via `sops updatekeys`, com a confirmação interativa alimentada no stdin. (ADR-0001 §5, §6)

## 7. Pré-requisitos do host

O pré-requisito obrigatório do host é um runtime de container (nerdctl ou docker), instalado por máquina e por usuário. `age`, `age-keygen` e `sops` são verificados pelo `doctor` e, quando ausentes, auto-instaláveis via `tools install`: versões pinadas com sha256 por plataforma, baixadas dos releases oficiais para `~/.config/ai-playbook/bin/`. A CLI resolve essas ferramentas primeiro no bin-dir próprio e depois no PATH, sem mutar o PATH do usuário. Node.js não é pré-requisito do host: a CLI é um binário Rust auto-contido. O runtime não embute nem substitui SOPS e age — delega a eles a criptografia. (ADR-0001 §6)

## 8. CLI de ciclo de vida — conjunto fechado

A CLI do host — binário Rust estático por plataforma, sem dependência de Node.js no host — expõe exatamente `up`, `down`, `status`, `doctor`, `tools install`, `secrets init`, `secrets edit`, `keys add` e `keys remove`, sempre com o seletor `--context <nome>` — conjunto fechado. Comando fora desse conjunto é violação de contrato. (ADR-0001 §3, §6)

## 9. Injeção efêmera

No **modo HTTP persistente**, o plaintext existe apenas por uma janela curta, controlada pelo `up`:

1. `up` valida as variáveis obrigatórias do contexto (§5), resolve `MCP_RUNTIME_ARCH_CORPUS` (§5; opcional — se inválida, omite `xharness` com aviso) e decripta `secrets.sops.env` para arquivo com permissão `0600` em diretório temporário privado do usuário;
2. o `compose.yaml` entrega o arquivo via `secrets:` file-based aos serviços que o exigem (`github`, `ado`), montado em `/run/secrets` dentro do container; o serviço `xharness` **não** monta esse segredo;
3. `up` sobe a stack e **remove o arquivo decriptado logo após o start**, fechando a janela de plaintext;
4. `up` comprova a prontidão por handshake MCP `initialize` em cada serviço **iniciado** — resposta HTTP crua não é prova de prontidão. Os serviços efetivamente sobidos (`github`, `ado` e, se o corpus for válido, `xharness`) **precisam responder ao `initialize` com `serverInfo`**: credencial recusada (401/403) ou resposta sem `serverInfo` reprova o `up` (exit 1), com a causa classificada, o estado do container e os logs dos containers (§12); em falha, o `up` não declara a stack pronta. Para `xharness`, o endpoint é `http://127.0.0.1:8379/mcp`. Estado QMD `degraded` (fallback léxico) **não** reprova o handshake se `serverInfo` estiver presente. No modo `azcli`, checa a sessão Azure dentro do container, iniciando o login quando ela faltar (§4);
5. a remoção do item 3 não é refeita: o `exec` da checagem/login roda no container já em execução e não re-interpola o `compose.yaml` nem cria cópia nova do plaintext, então a janela de plaintext termina antes do restante da passada. `up` é idempotente e recria o arquivo a qualquer start subsequente; `down` limpa tudo.

Todo start passa pelo `up`: um restart espontâneo de container sem essa passada falha por ausência do arquivo — garantia aceita contra plaintext persistente (serviços com secrets). No **modo stdio por conexão** não há arquivo em disco: `sops exec-env` alimenta o ambiente do run pontual diretamente. (ADR-0001 §7; ADR-0008)

## 10. Transporte e compatibilidade

Portas publicadas somente em `127.0.0.1`, em todas as plataformas:

| Serviço | Porta host |
|---------|------------|
| `github` | 8377 |
| `ado` | 8378 |
| `xharness` | 8379 |

A solução funciona de forma idêntica com nerdctl (Rancher Desktop/containerd) e docker, em Linux, macOS e Windows:

- o `compose.yaml` é escrito ao denominador comum dos dois runtimes: sem `uid`/`gid`/`mode` em `secrets` e sem `secrets.<segredo>.external`;
- a CLI do host é binário Rust estático, sem scripts de shell, para portabilidade Windows. (ADR-0001 §6, §8)
- a CLI fixa o próprio diretório de trabalho e a variável `PWD` ao invocar o runtime de containers: o ciclo de vida funciona de qualquer diretório do host e não depende de o diretório do usuário existir no guest (ressalva de Rancher Desktop/macOS registrada no `TOOL.md`).

## 11. Hardening mínimo

Os containers do runtime executam com: usuário não-root; filesystem somente leitura (com tmpfs para escrita volátil); `cap_drop` completo; `no-new-privileges`; limites de recursos (CPU, memória, processos); `working_dir` explícito (diretório de execução determinístico do server, sem depender do cliente do runtime); nenhuma montagem do socket do daemon de containers. O serviço `xharness` usa volume nomeado para o cache QMD (`/data`); o corpus montado é read-only. (ADR-0001 §9; ADR-0008)

## 12. Regra de logs

Nenhum valor de segredo aparece em nenhuma saída — stdout, stderr ou logs, no host e nos containers. A regra vale também para o dump de logs dos containers que o `up` imprime quando a prontidão falha (§9): essa saída carrega apenas mensagens classificadas e nomes de variáveis, nunca valores. A verificação é automatizada no smoke test da implementação. (ADR-0001, compromisso registrado em Consequências)

## 13. Sem camada de políticas

O runtime não terá allowlists de ferramentas, organizações, projetos ou repositórios, nem perfis de acesso. Os atributos "seguro, centralizado e facilitado" vêm de isolamento por container, autenticação individual interna, segredos confinados e cifrados at-rest, ferramentas semânticas dos servers e pinning das fontes. A segurança não depende de uma camada de autorização intermediária. (ADR-0001 §9)

## 14. Wiring do cliente Cursor no host

Após o `up` concluir o handshake MCP (e o login `azcli`, quando aplicável), a CLI **sincroniza** a configuração do Cursor no host com os endpoints canônicos em loopback (§10):

- destino obrigatório: `~/.cursor/mcp.json` (Windows: `%USERPROFILE%\.cursor\mcp.json`);
- destino adicional quando `MCP_RUNTIME_CLIENT_ROOT` aponta para a raiz de um repositório consumidor: `<MCP_RUNTIME_CLIENT_ROOT>/.cursor/mcp.json`;
- merge (não replace) da entrada gerenciada `awu` → `http://127.0.0.1:8379/mcp` quando o serviço `xharness` estiver ativo; remove chaves legadas do wiring anterior (`x-harness`, `ai-playbook-github`, `ai-playbook-ado`); demais servers do arquivo permanecem intactos;
- **proibido** gravar PAT, Bearer ou qualquer segredo no `mcp.json`;
- opt-out: `MCP_RUNTIME_SKIP_CLIENT_CONFIG` com valor truthy (`1` / `true` / `yes` / `on`);
- falha de escrita no host **não** invalida a stack já pronta — o `up` emite aviso e exit 0 quando os handshakes passaram;
- o `down` **não** remove nem reverte o `mcp.json`.

O corpus normativo, quando resolvido com sucesso no `up`, é persistido em `~/.config/ai-playbook/mcp-runtime/contexts/<contexto>/arch-corpus.path`. Resoluções subsequentes (`status`, `up`, `doctor` com contexto) usam, nesta ordem: env `MCP_RUNTIME_ARCH_CORPUS`, depois o arquivo do contexto. (ADR-0009)
