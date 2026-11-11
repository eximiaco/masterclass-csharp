# TOOL — mcp-runtime: runtime MCP local em containers

Orquestrador de ciclo de vida dos MCP servers em containers: sobe, expõe em loopback e derruba. Sem proxy — o consumidor fala direto com o server, por stdio (por conexão) ou pelo transporte HTTP nativo do server (SPEC §1).

- Serviços: `github` (GitHub MCP Server, binário da imagem oficial pinada), `ado` (Azure DevOps MCP via npm em versão exata, envolto pelo adaptador stdio→HTTP `supergateway`) e `xharness` (MCP normativo Eximia / x-harness — imagem pinada em `XHARNESS_MCP_IMAGE`, corpus por bind-mount).
- Segredos: cifrados com SOPS (backend age), um contexto por cliente; variáveis obrigatórias por serviço são validadas antes do start; plaintext existe apenas numa janela curta controlada pelo `up` (SPEC §5, §9). O serviço `xharness` não usa SOPS.
- Ports publicados somente em `127.0.0.1`: github `8377`, ado `8378`, xharness `8379` (SPEC §10). Um contexto por vez por máquina.
- Corpus normativo: variável de host opcional `MCP_RUNTIME_ARCH_CORPUS` (caminho absoluto do clone com `arch-graph/graph-doc`). Se válida, o `up` sobe o serviço `xharness`, monta o corpus em `/app/repo:ro` e persiste o path em `~/.config/ai-playbook/mcp-runtime/contexts/<contexto>/arch-corpus.path` (fallback nas próximas resoluções). Se ausente/inválida, o `up` **avisa** e sobe só `github`/`ado` (ADR-0008).
- Client Cursor (ADR-0009 / SPEC §14): após o handshake do `up`, merge em `~/.cursor/mcp.json` (e em `$MCP_RUNTIME_CLIENT_ROOT/.cursor/mcp.json` se definido) da entrada `awu` → `http://127.0.0.1:8379/mcp` quando o xharness estiver ativo — **sem PAT**. Opt-out: `MCP_RUNTIME_SKIP_CLIENT_CONFIG=1`.
- CLI: binário Rust (`mcp-runtime`), invocado pelo caminho da instalação (`.harness/tools/mcp-runtime/mcp-runtime`) — ele **não** entra no PATH do host, veja Instalação — distribuído por GitHub Release (tag `artifact/tools/mcp-runtime/v<versão>+<sha>`, assets `mcp-runtime-<os>-<arch>` — `darwin-arm64`, `darwin-x64`, `linux-arm64` (musl estático), `linux-x64` (glibc ≤ 2.31) e `win32-x64.exe`, com backend TLS nativo no Windows — e o bundle de conteúdo `mcp-runtime-artifact.tar.gz`) ou compilado localmente com `cargo build` no diretório do artefato (SPEC §8). A instalação recomendada é `ai-installer install tools/mcp-runtime` (abaixo). O caminho Node 0.1.x (`scripts/mcp-runtime.mjs`) foi removido na revisão 0.2.3.

## Pré-requisitos do host (SPEC §7)

- `age`, `age-keygen` e `sops` — auto-instaláveis pelo próprio artefato (abaixo)
- runtime de container: nerdctl (Rancher Desktop) ou docker (Docker Desktop)

Verifique com:

```bash
.harness/tools/mcp-runtime/mcp-runtime doctor --context <contexto>
```

### Instalação do artefato e do binário

Caminho recomendado — o `ai-installer` materializa o artefato completo no diretório de trabalho (`<target>/.harness/tools/mcp-runtime/`):

```bash
ai-installer self-update                  # o ai-installer anterior recusa artefato distribuído por release
ai-installer install tools/mcp-runtime    # acrescente --target <dir> para instalar em outro diretório
```

A release `artifact/tools/mcp-runtime/v<versão>+<sha>` publica os binários por plataforma
(`mcp-runtime-<os>-<arch>`) **e** o bundle de conteúdo `mcp-runtime-artifact.tar.gz`, com o
diretório do artefato na raiz do tar (`./artifact.yaml`, `./TOOL.md`, `./containers/...`).
O `ai-installer` baixa o binário da plataforma e o bundle, confere os dois sha256 contra o
`SHA256SUMS` da release e grava ambos em `.harness/tools/mcp-runtime/`: o executável
`mcp-runtime` (modo `0755`) ao lado de `containers/`. Com o binário **dentro** do diretório do
artefato, o runtime localiza `containers/compose.yaml` subindo a partir do próprio executável —
`MCP_RUNTIME_ARTIFACT_DIR` é dispensável nesse arranjo.

**O binário NÃO vai para o PATH do host.** O caminho real é
`.harness/tools/mcp-runtime/mcp-runtime` (relativo à raiz do alvo da instalação) — é esse o
caminho usado nos exemplos deste documento, e é o que os passos assistidos do `artifact.yaml`
já usam. Nenhum fluxo do canal cria link, wrapper ou export, e a CLI não muta o PATH do usuário
(SPEC §7). Para chamar pelo nome numa sessão, exporte o diretório
(`export PATH="$PWD/.harness/tools/mcp-runtime:$PATH"`); em uso por agente/CI, use o caminho
completo. O `doctor` reporta de onde o executável foi resolvido e a CLI imprime o próprio caminho
nas mensagens de orientação.

Alternativas (binário fora do diretório do artefato):

```bash
cargo build --release --bin mcp-runtime          # no diretório do artefato: target/release/mcp-runtime
gh release download artifact/tools/mcp-runtime/v<versão>+<sha> --pattern 'mcp-runtime-*'
```

No download manual do asset, exporte `MCP_RUNTIME_ARTIFACT_DIR=/caminho/de/artifacts/tools/mcp-runtime`
para apontar a raiz do artefato (o `cargo build` executado dentro do diretório do artefato resolve
sozinho).

### Instalação de sops/age (`tools install`, SPEC §7)

```bash
.harness/tools/mcp-runtime/mcp-runtime tools install [--force]
```

Baixa `sops` e `age`/`age-keygen` nas **versões pinadas** de `containers/pins.env`
direto dos releases oficiais (GitHub de getsops/sops e FiloSottile/age), verifica o
sha256 por plataforma antes de gravar, e instala em `~/.config/ai-playbook/bin/`
com modo `0755` (unix). Idempotente: já instalado é preservado; `--force` reinstala.

Resolução das ferramentas por toda a CLI: `~/.config/ai-playbook/bin/` primeiro,
PATH como fallback — determinismo da versão pinada; o PATH do usuário não é mutado
(exporte esse bin-dir manualmente se quiser chamar `sops`/`age` fora da CLI; o binário do
`mcp-runtime` não fica lá — ele vive no diretório do artefato, veja Instalação). Instalação manual por
gerenciador de pacotes (`brew install age sops`) ou pelos releases oficiais
(https://github.com/FiloSottile/age/releases, https://github.com/getsops/sops/releases)
continua válida como mecanismo alternativo — o doctor orienta `tools install` e reporta de onde o executável foi resolvido. 

## Layout por contexto (SPEC §5)

Caminho unificado em todas as plataformas (sobrescrevível apenas para testes via `MCP_RUNTIME_CONFIG_DIR`):

```text
~/.config/ai-playbook/mcp-runtime/
├── keys/<contexto>.agekey                  # identidade age privada do contexto
└── contexts/<contexto>/
    ├── recipients.txt                      # public keys (uma por linha)
    ├── secrets.sops.env                    # segredos cifrados (formato ENV do SOPS)
    └── .sops.yaml                          # creation_rules do SOPS
```

`<contexto>` é kebab-case minúsculo (`[a-z0-9][a-z0-9-]*`); contextos de credencial são intransponíveis (SPEC §4).

## Atalhos de segredos (SPEC §6, §8)

Os wrappers compostam os binários nativos `sops`/`age` (resolvidos do bin-dir
próprio → PATH, SPEC §7) — a criptografia continua 100% em sops/age e o runtime
nunca lê ou loga valores de segredo.

### Criar contexto

```bash
.harness/tools/mcp-runtime/mcp-runtime secrets init --context <contexto>
```

Cria `keys/<contexto>.agekey` (0600), `contexts/<contexto>/recipients.txt`,
`.sops.yaml` (creation rule com a public key) e `secrets.sops.env` template já
cifrado para o primeiro recipient. Imprime a public key (`age1...`) e o próximo
passo (`secrets edit` e depois `up`): o template nasce com as obrigatórias vazias
e o `up` recusa iniciar enquanto faltar alguma (SPEC §5).

### Editar segredos

```bash
.harness/tools/mcp-runtime/mcp-runtime secrets edit --context <contexto>
```

Abre o `sops edit` com `SOPS_AGE_KEY_FILE` da identidade do contexto; o código
de saída do sops é repassado. Depois da edição o wrapper **valida o resultado** (SPEC §5):
imprime o modo de autenticação resultante (`pat`/`azcli`) e, se alguma obrigatória
continuar vazia, nomeia a variável e o serviço e sai 1 — o `up` recusaria o start do mesmo jeito.

### Adicionar ou remover recipient (rotação sem rotação de valores, SPEC §5)

```bash
.harness/tools/mcp-runtime/mcp-runtime keys add --context <contexto> --recipient <age1...>
.harness/tools/mcp-runtime/mcp-runtime keys remove --context <contexto> --recipient <age1...>
```

Reescrevem `recipients.txt` e `.sops.yaml` (recipients separados por vírgula
na mesma creation rule) e reencapsulam o `secrets.sops.env` via
`sops updatekeys` (confirmação `y` no stdin, identidade do contexto).
`keys remove` se recusa a remover o último recipient.

### Mecanismo nativo (equivalente, para auditoria)

```bash
ROOT=~/.config/ai-playbook/mcp-runtime   # MCP_RUNTIME_CONFIG_DIR sobrepõe
KEY=$ROOT/keys/<contexto>.agekey
CTX=$ROOT/contexts/<contexto>
age-keygen -o "$KEY"                     # imprime "Public key: age1..."
printf '%s\n' "$PUB" > "$CTX/recipients.txt"
printf 'creation_rules:\n  - age: "%s"\n' "$PUB" > "$CTX/.sops.yaml"
sops --encrypt --age "$PUB" --in-place --input-type env --output-type env "$CTX/secrets.sops.env"
SOPS_AGE_KEY_FILE="$KEY" sops edit "$CTX/secrets.sops.env"
SOPS_AGE_KEY_FILE="$KEY" sh -c 'echo y | sops updatekeys "$CTX/secrets.sops.env"'
```

O `sops updatekeys` é interativo: lista as mudanças no grupo e pede confirmação
no stdin (`Is this okay? (y/n)`); em scripts, alimente o stdin com `y`
(a CLI o faz — verificado no sops 3.13.3: sem stdin, sai com `EOF`).

Remover um recipient remove seu acesso em arquivos reencapsulados depois disso.

## Variáveis esperadas no `secrets.sops.env`

| Variável | Usada por | Classe | Observação |
| --- | --- | --- | --- |
| `GITHUB_PERSONAL_ACCESS_TOKEN` | server GitHub | **obrigatória** | PAT do GitHub; no transporte HTTP o token vai por header `Authorization: Bearer` por chamada; sem o PAT o server responde 401 em toda tool call |
| `AZURE_DEVOPS_PAT` | serviço `ado` | opcional (seletor de modo) | presente ⇒ modo `pat`; ausente ou vazia ⇒ modo `azcli`, que exige sessão Azure (SPEC §4) |
| `ADO_ORG` | serviço `ado` | **obrigatória** | organização Azure DevOps (argumento do server) |

O `up` valida as **obrigatórias antes do start**: contexto incompleto ⇒ exit 1 com a variável e o serviço nomeados, `secrets edit` como fix e **nenhum container criado** (SPEC §5). A validação só usa nomes de variáveis, nunca valores (SPEC §12).

Valores são `KEY=VALUE` por linha. O arquivo é fonte no container (`. /run/secrets/secrets.env`) — valores com caracteres especiais de shell exigem aspas válidas de shell.

## Modo 1 — HTTP persistente em loopback (SPEC §1)

```bash
.harness/tools/mcp-runtime/mcp-runtime up --context <contexto>
# github:   http://127.0.0.1:8377/   (transporte HTTP nativo do GitHub MCP Server)
# ado:      http://127.0.0.1:8378/mcp (adaptador supergateway, endpoint /mcp)
# xharness: http://127.0.0.1:8379/mcp (MCP normativo; prefixo canônico arch.*)
.harness/tools/mcp-runtime/mcp-runtime status --context <contexto>
.harness/tools/mcp-runtime/mcp-runtime down --context <contexto>
```

Antes do `up`, opcionalmente defina o corpus para habilitar o xharness (SPEC §5 / ADR-0008):

```bash
export MCP_RUNTIME_ARCH_CORPUS=/caminho/absoluto/do/clone-com-arch-graph
# opcional: também sincroniza .cursor/mcp.json do repositório consumidor
export MCP_RUNTIME_CLIENT_ROOT=/caminho/do/repo-consumidor
```

Sem corpus válido (env ou `arch-corpus.path` do contexto), o `up` sobe `github` e `ado` normalmente e emite aviso de que o `xharness` foi omitido.

O clone deve conter `arch-graph/graph-doc` (repositório x-harness ou instância derivada de arquitetura).

Após o handshake, o `up` sincroniza o Cursor (SPEC §14): entrada `awu` (quando o xharness estiver ativo) em `~/.cursor/mcp.json`, sem segredos. Desligar com `MCP_RUNTIME_SKIP_CLIENT_CONFIG=1`.

`up` é idempotente. Em cada `up`: `doctor` lite → valida os arquivos do contexto, a identidade age e **as variáveis obrigatórias de cada serviço** (falha antes de criar container) → `sops -d` para `$TMPDIR/ai-playbook-mcp-runtime/<contexto>/secrets.env` (dir `0700`, arquivo `0600`) → `compose -p mcp-<contexto> up -d --build` (com cwd e `PWD` da CLI fixos, independentes do diretório do usuário — veja Divergências) → **remove o arquivo efêmero logo após o start** → **handshake MCP `initialize`** por serviço, com falha rápida quando o container está morto → no modo `azcli`, checagem/login da sessão Azure no container. Restart espontâneo de container sem o `up` falha por ausência do arquivo — garantia aceita (SPEC §9). `down` roda `compose down` (containers e redes) e remove só o volume `mcp-<contexto>-ado-auth`; o cache QMD `mcp-<contexto>-xharness-qmd` é preservado (busca híbrida pronta mais cedo nas próximas subidas).

Consumo por um cliente MCP (exemplo de `initialize` no github; o token vai por header):

```bash
curl -sS http://127.0.0.1:8377/ \
  -H 'accept: application/json, text/event-stream' \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer <PAT>' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"cli","version":"0"}}}'
```

Para o ado, o mesmo `initialize` vale contra `http://127.0.0.1:8378/mcp`. Para o xharness: `http://127.0.0.1:8379/mcp` (sem bearer).

### Saída do `up`

As saídas abaixo são as do contrato 0.3.2; as mensagens de orientação citam o nome do CLI, e o executável é sempre o caminho desta seção (`.harness/tools/mcp-runtime/mcp-runtime`).

Variáveis obrigatórias ausentes — exit 1, **nenhum container criado**:

```text
[mcp-runtime] contexto kevsystem: variáveis obrigatórias ausentes
  - ADO_ORG (serviço: ado) — o server Azure DevOps não inicia sem a organização
  - GITHUB_PERSONAL_ACCESS_TOKEN (serviço: github) — o server GitHub responde 401 em toda tool call
[mcp-runtime] corrija com: mcp-runtime secrets edit --context kevsystem
[mcp-runtime] nada foi iniciado; nenhum container foi criado
```

Prontidão — só depois do handshake MCP `initialize`, não mais por qualquer resposta HTTP:

```text
[mcp-runtime] aguardando handshake MCP ...
[mcp-runtime] github: initialize OK — github-mcp-server v1.12.2 (HTTP 200)
[mcp-runtime] ado: initialize OK — Azure DevOps MCP Server v2.10.0 (HTTP 200)
[mcp-runtime] stack pronta; endpoints em loopback (SPEC §1)
```

- os **dois** serviços precisam responder ao `initialize` com `serverInfo` — é isso que separa "porta aberta" de "MCP consumível";
- credencial recusada (401/403) também **reprova** o `up`: o server está vivo, mas toda tool call falharia. A causa vem classificada na linha do serviço e o `up` aponta a rotação:

```text
[mcp-runtime] prontidão reprovada: credencial recusada (HTTP 401)
[mcp-runtime] github: container running | credencial recusada (HTTP 401)
[mcp-runtime] rotacione com: mcp-runtime secrets edit --context kevsystem
```

- falha rápida: o `up` consulta o estado do container (`inspect --format '{{.State.Status}}|{{.State.ExitCode}}' mcp-<contexto>-<serviço>-1`); `exited`/`dead` interrompe na hora, sem esperar os 120 s de deadline;
- em qualquer reprovação, o `up` imprime `<runtime> logs --tail 50 mcp-<contexto>-<serviço>-1` dos três serviços e sai 1 — só mensagens classificadas e nomes de variáveis, nunca valores (SPEC §12).

### Saída do `status`

```text
[mcp-runtime] stack mcp-kevsystem (contexto kevsystem)
[mcp-runtime]   github: container running | initialize OK — github-mcp-server v1.12.2 (HTTP 200)
[mcp-runtime]   ado: container exited (64) | sem resposta (conexão recusada)
[mcp-runtime]   efêmero: ausente
[mcp-runtime]   autenticação do serviço ado: modo pat
```

Exit 0 somente quando os dois containers estão `running` **e** os dois handshakes passam; 1 caso contrário. Estado do container, resultado do handshake e existência do arquivo efêmero aparecem juntos: é o que distingue "credencial recusada" de "pronto". Um `up` interrompido deixa o plaintext no disco e o `status` mostra `efêmero: presente`, com o comando de recuperação e exit 1 — plaintext no disco nunca é estado pronto (SPEC §9).

### Saída do `doctor`

Além dos pré-requisitos (SPEC §7), o `.harness/tools/mcp-runtime/mcp-runtime doctor --context <contexto>` reporta, sem efeito colateral:

- variáveis do contexto: **nome** + presente/ausente (nunca valores);
- modo de autenticação resultante (`pat` quando há `AZURE_DEVOPS_PAT`; `azcli` quando não há);
- estado da sessão Azure no container (modo `azcli`);
- como o CLI foi resolvido (`executável: /caminho`), com aviso quando invocado fora do diretório do artefato; as mensagens de orientação da CLI usam o nome nu `mcp-runtime`, e o `doctor --context` é quem mostra o caminho real.

### Login az (modo azcli, SPEC §4)

No modo `azcli` (sem `AZURE_DEVOPS_PAT`) o `up` verifica a sessão **dentro do container** e, quando ela falta ou expirou, inicia o login por device code e retransmite a interação ao terminal do host. Não há comando novo (SPEC §8): o login é parte do `up`.

```bash
.harness/tools/mcp-runtime/mcp-runtime up --context <contexto>
```

```text
[mcp-runtime] modo azcli: verificando a sessão Azure no container ...
[mcp-runtime] sessão ausente/expirada; iniciando login por device code no container
[az] To sign in, use a web browser to open the page https://microsoft.com/devicelogin and enter the code ABC-123-XYZ to authenticate.
[mcp-runtime] sessão Azure validada (conta: <upn>)
```

- checagem de sessão: `az account get-access-token --resource https://app.vssps.visualstudio.com -o none` no container em execução;
- login: `az login --use-device-code --allow-no-subscriptions`, com stdout e stderr do `az` retransmitidos linha a linha ao terminal do host (prefixo `[az] `) — o código de device code é lido do stderr do `az`; timeout próprio de 600 s, com mensagem e exit 1 ao estourar;
- sessão válida ⇒ nenhuma interação (o `up` segue idempotente);
- **sem TTY no host a CLI não interage**: imprime o comando manual e sai 1 — uso por agente/CI nunca pendura.

```text
[mcp-runtime] sem TTY: rode manualmente para autenticar
  nerdctl exec -i mcp-kevsystem-ado-1 az login --use-device-code --allow-no-subscriptions
```

O comando manual, no formato genérico, é `<runtime> exec -i mcp-<contexto>-ado-1 az login --use-device-code --allow-no-subscriptions`. A sessão fica no volume `mcp-<contexto>-ado-auth` (montado em `/home/mcp/.azure`); nada sai do container.

## Modo 2 — stdio por conexão (SPEC §1)

Sem arquivo em disco: `sops exec-env` alimenta o ambiente do run pontual. O comando é uma única string (formato do `sops exec-env`).

GitHub (imagem oficial pinada, sem build):

```bash
SOPS_AGE_KEY_FILE=~/.config/ai-playbook/mcp-runtime/keys/<contexto>.agekey \
  sops exec-env ~/.config/ai-playbook/mcp-runtime/contexts/<contexto>/secrets.sops.env \
  'nerdctl run -i --rm -e GITHUB_PERSONAL_ACCESS_TOKEN="$GITHUB_PERSONAL_ACCESS_TOKEN" ghcr.io/github/github-mcp-server@sha256:508a0857ec762b1ab1cece29193345b501fab1dd9d1228a7b617062954cecac6 stdio'
```

Azure DevOps (usa a imagem `mcp-runtime:<contexto>` construída pelo `up`; modo `pat`):

```bash
SOPS_AGE_KEY_FILE=~/.config/ai-playbook/mcp-runtime/keys/<contexto>.agekey \
  sops exec-env ~/.config/ai-playbook/mcp-runtime/contexts/<contexto>/secrets.sops.env \
  'nerdctl run -i --rm -e AZURE_DEVOPS_PAT="$AZURE_DEVOPS_PAT" -e ADO_ORG="$ADO_ORG" mcp-runtime:<contexto> sh -c "PERSONAL_ACCESS_TOKEN=\$(printf ado-mcp:%s \"\$AZURE_DEVOPS_PAT\" | base64); exec node /opt/mcp-runtime/node_modules/@azure-devops/mcp/dist/index.js \"\$ADO_ORG\" --authentication pat"'
```

Variante `azcli` (mantém a sessão do volume):

```bash
SOPS_AGE_KEY_FILE=~/.config/ai-playbook/mcp-runtime/keys/<contexto>.agekey \
  sops exec-env ~/.config/ai-playbook/mcp-runtime/contexts/<contexto>/secrets.sops.env \
  'nerdctl run -i --rm -v mcp-<contexto>-ado-auth:/home/mcp/.azure mcp-runtime:<contexto> sh -c "exec node /opt/mcp-runtime/node_modules/@azure-devops/mcp/dist/index.js \"\$ADO_ORG\" --authentication azcli"'
```

Os comandos acima são strings únicas com o comando entre aspas simples no shell do host (nada é expandido no host); os `\$` e `\"` protegem as expansões para as camadas internas (`sops exec-env` → shell do run → `sh -c` do container). Os `-e NOME="$VALOR"` são expandidos pelo shell do `exec-env`: o nerdctl não replica o comportamento docker de `-e NOME` sem valor herdar o ambiente do processo. Em fallback docker, troque `nerdctl` por `docker`.

## Hardening (SPEC §11)

Aplicado inline nos dois serviços do `containers/compose.yaml`:

- usuário não-root (`user` compose; default `10001:10001`);
- rootfs read-only com tmpfs em `/tmp`;
- `cap_drop: [ALL]`;
- `security_opt: no-new-privileges`;
- `pids_limit: 256`, `mem_limit: 512m` (github/ado) / `2g` (xharness), `cpus: "1.0"` (github/ado) / `"2.0"` (xharness);
- portas somente `127.0.0.1:8377`, `127.0.0.1:8378` e `127.0.0.1:8379`;
- `working_dir` explícito — diretório de execução determinístico do server, sem depender do cliente do runtime;
- nenhuma montagem de socket do daemon;
- secrets file-based (`file: ${MCP_RUNTIME_SECRETS_FILE}`) nos serviços `github`/`ado`, sem `uid`/`gid`/`mode` e sem `external` (denominador comum nerdctl/docker, SPEC §10); `xharness` não monta secrets.

## Divergências nerdctl × docker (verificadas empiricamente)

- `security_opt: ["no-new-privileges:true"]` — o nerdctl rejeita o sufixo `:true` (trata como security-opt desconhecido e o container sobe **sem** a flag); a forma bare `no-new-privileges` é aceita pelos dois. O compose usa a forma bare.
- `healthcheck` — o nerdctl compose ignora (avisa `Ignoring: [HealthCheck]`); a prontidão real é o handshake MCP `initialize` do `up` (polling com deadline de 120 s). O healthcheck permanece no compose para o docker e não é critério de prontidão do produto.
- Secret file-based no nerdctl é bind-mount do arquivo do host: em hosts Linux o `up` passa `MCP_RUNTIME_CONTAINER_USER=<uid>:<gid>` do arquivo efêmero (o processo do container roda com a identidade do próprio usuário, SPEC §4); em macOS/Windows o compartilhamento do runtime rematerializa o conteúdo e o default `10001:10001` é mantido (verificado no nerdctl/Rancher Desktop e no Docker Desktop).
- O docker materializa file secrets internamente (modo `0444` na criação do container): um restart de container no docker preserva o segredo materializado, enquanto no nerdctl o restart re-bind o arquivo do host (ausente após o `up`) e falha — comportamento aceito por SPEC §9 e ADR §7.
- `compose logs` em projeto inexistente: o docker sai imediatamente com código 0; o nerdctl **pende** (fica aguardando o container do serviço e não retorna). A captura de logs da suite smoke é feita por container (`$RT logs mcp-<contexto>-<serviço>-1`, denominador comum) — os nomes determinísticos do compose (`<projeto>-<serviço>-<índice>`) são iguais nos dois runtimes.
- O docker compose rotula a imagem local construída (`com.docker.compose.project`, `com.docker.compose.service`, `com.docker.compose.version` nos labels da imagem); containers `docker run` criados a partir dela herdam esses labels. O nerdctl não rotula a imagem construída (`Config.Labels` nulo). Consequência prática: filtro por label de projeto (`ps -a --filter label=com.docker.compose.project=...`) no docker pode listar containers one-shot transientes do próprio fluxo (ex.: servidor stdio iniciado da imagem local, ainda não recolhido pelo `--rm` assíncrono); o nome determinístico do compose disambigua (a suite smoke cruza label × prefixo do nome).
- Segundo `up` com recreate (o bind do arquivo efêmero muda a cada `up` → config-hash muda → docker recria containers): na janela do recreate, sockets keep-alive em pool do cliente (ex.: pool global do `fetch`) podem apontar para a instância anterior e receber RST (observado no docker/Rancher Desktop; não reproduzido no nerdctl). O driver dos testes usa conexão nova por request (`node:http` com `keepAlive: false`); interativamente, reabrir a conexão resolve — a stack nova responde em loopback.
- **Rancher Desktop/macOS — `/tmp` do host ≠ `/tmp` do guest**: no host macOS `/tmp` é symlink para `/private/tmp`; o `/tmp` do guest (VM Lima) é disco próprio da VM (`/dev/vda1`) e a ponte `rdctl shell` usa o `$PWD` do host literal. Invocar o runtime de um diretório sob `/tmp` degradava o cwd do lado do guest e imprimia `ash: cd: line 0: can't cd to ...` no meio da saída do `up` (a mensagem nunca foi log de container). Correção no produto (0.3.2): todo spawn do runtime usa `current_dir` **e** `PWD` fixos (diretório do artefato, fallback `/`), então a CLI funciona de qualquer diretório do usuário e não depende de o diretório existir no guest (SPEC §10).

## Pins das fontes oficiais (SPEC §2)

Valores fixos em `containers/pins.env` — proibido `latest`; alterar um pin exige bump de versão do artefato:

| Pin | Valor |
| --- | --- |
| `GITHUB_MCP_IMAGE` | `ghcr.io/github/github-mcp-server@sha256:508a0857ec762b1ab1cece29193345b501fab1dd9d1228a7b617062954cecac6` (v1.12.2) |
| `ADO_MCP_NPM_VERSION` | `2.10.0` (`@azure-devops/mcp`) |
| `ADO_HTTP_ADAPTER` | `supergateway@3.4.3` |
| `AZURE_CLI_VERSION` | `2.90.0-1~bookworm` (repo apt oficial da Microsoft) |
| `SOPS_VERSION` (imagem de teste) | `3.13.3` + sha256 amd64/arm64 dos releases oficiais |

Na imagem oficial do GitHub MCP (distroless) o binário fica em `/server/github-mcp-server` — o `Containerfile` copia esse caminho para `/usr/local/bin/github-mcp-server`.

## Imagem publicada (GHCR)

Em pushes para `main` que alteram o artefato, o workflow de release publica a imagem multi-arch (`linux/amd64`, `linux/arm64`, com atestation de provenance) em:

```text
ghcr.io/<owner>/mcp-runtime:v<versão do artefato>
ghcr.io/<owner>/mcp-runtime:latest
```

- O `compose.yaml` referencia essa imagem ao lado do `build:` — default de owner `eximiaco` via interpolação; override com `export MCP_RUNTIME_IMAGE_OWNER=<owner>`.
- O `up` do script repassa `--build` (rebuild a partir dos pins, SPEC §2 — reproducibilidade): o fallback de build local mantém a suíte funcionando pré-publicação. Para consumir a imagem publicada, faça `<runtime> compose ... pull` e `up` direto (sem `--build`).
- O digest publicado fica registrado no output/summary do job de release.

## Solução de problemas

```bash
.harness/tools/mcp-runtime/mcp-runtime doctor --context <contexto>
$RT compose --env-file containers/pins.env --file containers/compose.yaml -p mcp-<contexto> logs
$RT logs --tail 200 mcp-<contexto>-github-1   # alternativa por container (denominador comum)
```

- `compose logs` com projeto inexistente pende no nerdctl (o docker sai com código 0) — veja Divergências; se o projeto estiver no ar, o `compose logs` funciona nos dois.
- **`variáveis obrigatórias ausentes`** no `up`: contexto incompleto — corrija com `.harness/tools/mcp-runtime/mcp-runtime secrets edit --context <contexto>` (SPEC §5). Nenhum container foi criado.
- **`MCP_RUNTIME_ARCH_CORPUS` ausente/inválido** no `up`: aviso no stderr; a stack sobe **sem** `xharness` (github/ado seguem). Para habilitar a norma: exporte o caminho absoluto do clone com `arch-graph/graph-doc` (ADR-0008). O `awu-compiler` usa cascata/lacuna se precisar de `arch.*` e o MCP normativo não estiver no ar.
- **`credencial recusada (HTTP 401)`**: o server está vivo e a credencial está inválida ou expirada — o `up` **reprova** (a stack não é consumível) e a saída já traz `rotacione com: mcp-runtime secrets edit --context <contexto>`; vale para o `github` e para o `ado` no modo `pat`.
- **`container exited (<código>)`** no github/ado/xharness: o `up` já imprime `logs --tail 50` dos serviços e falha rápido (sem esperar o deadline); para inspecionar mais, `$RT logs --tail 200 mcp-<contexto>-<serviço>-1`.
- **pull da imagem `x-harness-mcp` falhou**: publique a imagem pelo pipeline do repositório x-harness (GHCR) e atualize `XHARNESS_MCP_IMAGE` em `pins.env` com o digest do summary; ou faça tag local da imagem pinada.
- **QMD degradado no xharness**: o handshake pode passar com busca léxica; não é falha dura do `up` se `serverInfo` estiver presente.
- **xharness unhealthy no boot**: a imagem `x-harness-mcp` v1+ abre HTTP na hora e indexa QMD em background (busca léxica até o embed terminar). O `up` só aguarda `/health` até **90s** (`start_period` 30s). Se falhar, confira `compose logs xharness` — não espere o fim do embed.
- **`efêmero: presente`** no `status`: sobrou o plaintext de um `up` interrompido (o `status` sai 1); rode o `up` de novo ou o `down` — o arquivo é recriado e removido na passada seguinte (SPEC §9).
- **`ash: cd: line 0: can't cd to ...`** na saída: sintoma da ponte Rancher Desktop/macOS quando o processo roda de um diretório sob `/tmp` — não deve ocorrer na 0.3.2 (a CLI fixa cwd e `PWD`); se aparecer, confira a versão do binário (veja Divergências).
- Porta ocupada (8377/8378/8379): existe outra stack do mcp-runtime no ar; rode `.harness/tools/mcp-runtime/mcp-runtime down --context <outro>` primeiro (um contexto por vez por máquina).
- `compose up` sem `MCP_RUNTIME_SECRETS_FILE` definido: todo start passa pelo `up` do CLI (SPEC §9); para uso manual do compose, exporte `MCP_RUNTIME_CONTEXT`, `MCP_RUNTIME_ARCH_CORPUS` e um arquivo efêmero seu com `MCP_RUNTIME_SECRETS_FILE`.

## Harness de testes

```bash
node artifacts/tools/mcp-runtime/scripts/run-tests.mjs                                # perfil default: cargo (container) + integração
node artifacts/tools/mcp-runtime/scripts/run-tests.mjs --profile smoke                # somente a suite smoke
node artifacts/tools/mcp-runtime/scripts/run-tests.mjs --profile smoke --runtime docker
node artifacts/tools/mcp-runtime/scripts/run-tests.mjs --profile smoke --runtime nerdctl
```

- `--profile default` (sem flag): suite Rust no container (`rust:1-bookworm`: `cargo test` + `cargo fmt --check` + `cargo clippy -- -D warnings`; o runner garante rustfmt/clippy no volume rustup) + build do binário Rust no host + suite de integração no host (`test/integration/*.test.mjs`).
- `--profile smoke`: executa SOMENTE a suite smoke (`test/smoke/*.test.mjs`) — os invariantes do fluxo ponta a ponta, na ordem do fluxo, com contexto efêmero `teste-*` criado pelos wrappers do artefato (`secrets init`/`keys`/`tools install`) e PATs dummy apenas nos valores. O fluxo inteiro é exercido PELO BINÁRIO RUST: o runner constrói e injeta o caminho via `MCP_RUNTIME_BIN`. Valores de segredo são verificados por digest (SPEC §12): nenhum valor dummy é gravado em captura — nem de host, nem de container.
- `--runtime nerdctl|docker`: força o runtime de container de todo o fluxo de teste. Sem a flag, o produto resolve nerdctl→docker (SPEC §10). O runner propaga a escolha via `MCP_RUNTIME_CONTAINER_RUNTIME` (o mesmo override aceito pelo próprio produto), e as suites host-driven (integração e smoke) a honram. A mesma suite smoke verde nos dois runtimes na mesma máquina é o critério cross-runtime.
- Uso inválido (`--profile bogus`, `--runtime podman`, valor ausente, flag desconhecida) sai com código 2 e mensagem de uso clara.
- Suites de integração e smoke: driver `node --test` no host (apenas infraestrutura de teste; o produto sob teste é o binário Rust) — necessário porque o nerdctl do Rancher Desktop no macOS é binário do host e não executa dentro de containers; **todo comportamento de produto exercido por elas roda em containers** (compose up/down, `compose exec`, `run -i`, endpoints em loopback), com stack real (SOPS/age, servers) e PATs dummy apenas nos valores. Helpers de driver vivem em `test/helpers.mjs`.
- A suite smoke limpa o que cria em `after()`: containers, volumes `mcp-*`, arquivos efêmeros e tmpdirs. A imagem local construída pelo compose (`ghcr.io/eximiaco/mcp-runtime:v<versão>`) permanece e é reutilizada nas próximas rodadas.

## Smoke test por plataforma

Os mesmos comandos servem em macOS, Linux e Windows-WSL2: o driver roda no host, o produto roda 100% em containers e os paths são resolvidos pelo driver de teste (sem shells específicos no runner).

```bash
node artifacts/tools/mcp-runtime/scripts/run-tests.mjs --profile smoke                 # runtime resolvido (nerdctl→docker)
node artifacts/tools/mcp-runtime/scripts/run-tests.mjs --profile smoke --runtime nerdctl
node artifacts/tools/mcp-runtime/scripts/run-tests.mjs --profile smoke --runtime docker
```

- Requisitos no host: Rust/cargo (o runner constrói o binário Rust do driver), um runtime de container com compose (`nerdctl` ou `docker`) e `sops`/`age` (auto-instaláveis pelo próprio artefato via `.harness/tools/mcp-runtime/mcp-runtime tools install`; o doctor valida).
- macOS: nerdctl/Rancher Desktop ou docker/Docker Desktop; `sops`/`age` via Homebrew (`brew install sops age`). Testado em nerdctl 2.2.1 (Rancher Desktop, containerd) e docker (Docker Desktop) na mesma máquina.
- Linux: mesmos comandos; `sops`/`age` do gerenciador de pacotes ou release do GitHub. O `up` passa `MCP_RUNTIME_CONTAINER_USER=<uid>:<gid>` automaticamente quando o backend compartilha o filesystem (nerdctl em Linux).
- Windows: rode dentro do WSL2 (distribuição com Node, sops, age e o runtime de container); os testes exigem loopback do próprio ambiente do driver (127.0.0.1:8377/8378 dentro do WSL). Não rode o driver a partir do PowerShell contra um runtime dentro do WSL — o driver precisa enxergar os binários nativos de segredos e o runtime.
- Um contexto por vez por máquina (portas fixas 8377/8378): se outra stack do mcp-runtime estiver no ar, `.harness/tools/mcp-runtime/mcp-runtime down --context <outro>` antes de rodar a suite.
- A suite nunca toca containers/volumes de outros workstreams (`workmanager-*`, `pkm-*`, etc.) e limpa os próprios recursos ao final; imagens locais construídas ficam tagadas `ghcr.io/eximiaco/mcp-runtime:v<x.y.z>` e são reutilizadas nas próximas rodadas.
