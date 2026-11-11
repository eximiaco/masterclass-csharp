// Suite smoke do mcp-runtime (Units mcp-runtime-smoke-test e
// mcp-runtime-smoke-switch, ADR-0001 rev 0.2.0) — driver no host, fluxo pela
// CLI Rust (binário do release/npm até 0.2.2; binário Rust a partir da troca),
// na ordem do fluxo:
//   1 doctor → 2 segredos nativos → 2b wrappers de segredos → 2c tools
//   install → 3 up → 4 efemeridade → 5 consumo (HTTP e stdio) → 6 regra de
//   logs → 7 hardening → 8 idempotência do up → 9 down.
// Invariantes 10 a 17 (PROPOSTA-CORRECAO §9) entram nos pontos em que a stack
// permite exercitá-los com determinismo:
//   antes do up (portas livres)  10 up com contexto incompleto · 11 prontidão
//                                reprovada (skip, sem caminho determinístico) ·
//                                14 status sem stack e 14 status distinguindo
//                                401 de handshake OK · 17 tag do compose
//   stack viva                   12 handshake com serverInfo no up ·
//                                14 status pronto · 15 cwd sob /tmp ·
//                                16 binário via symlink · 13 nenhum dummy no
//                                dump do up/status (varredura antes do down)
// Stack real: compose, SOPS/age, servers oficiais pinados — sem mock do
// produto; o invariante 14 fixa apenas o que as portas fixas 8377/8378
// devolvem (fixture loopback local), para classificar o handshake sem depender
// do ambiente. Dummy apenas nos VALORES dos segredos (PATs de teste). O runtime de container é o
// resolvido pelo produto (nerdctl→docker; MCP_RUNTIME_CONTAINER_RUNTIME força,
// flag --runtime do runner) e a mesma suíte roda nos dois runtimes.
// Verificações de valor de segredo são por digest (SPEC §12): nenhuma captura
// contém o próprio valor.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// A partir da troca (unit mcp-runtime-smoke-switch) o fluxo é exercido PELO
// BINÁRIO RUST (MCP_RUNTIME_BIN injetado pelo runner); o script Node 0.1.x foi
// removido e os helpers do driver vivem em ../helpers.mjs.
import { ARCH_CORPUS_FIXTURE, ephemeralPaths, findRuntime, findSecretsTools, loadPins, writeComposeEnvFile } from '../helpers.mjs';

const ART_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONTAINERS_DIR = join(ART_DIR, 'containers');
const COMPOSE_FILE = join(CONTAINERS_DIR, 'compose.yaml');
const PINS_FILE = join(CONTAINERS_DIR, 'pins.env');
const ARCH_CORPUS = process.env.MCP_RUNTIME_ARCH_CORPUS || ARCH_CORPUS_FIXTURE;

const BIN = process.env.MCP_RUNTIME_BIN;
if (!BIN) {
  throw new Error('MCP_RUNTIME_BIN não definido; o runner deve construir o binário Rust e injetar o caminho');
}

const FORCED = (process.env.MCP_RUNTIME_CONTAINER_RUNTIME || '').trim().toLowerCase() || null;
if (FORCED && !['nerdctl', 'docker'].includes(FORCED)) {
  throw new Error(`MCP_RUNTIME_CONTAINER_RUNTIME inválido: "${FORCED}" (use nerdctl ou docker)`);
}

const CTX = `teste-${randomBytes(3).toString('hex')}`;
// nomes determinísticos do compose: <project>-<service>-<index> (iguais nos dois runtimes)
const NAME_PREFIX = `mcp-${CTX}-`;
const CONFIG_ROOT = mkdtempSync(join(tmpdir(), 'mcp-runtime-smoke-cfg-'));
const EPH = ephemeralPaths(CTX);
const EPH_DIR = EPH.dir;
const EPH_SECRETS = EPH.secretsFile;
// formato clássico do GitHub (ghp_ + 36 alfanuméricos): o server valida o formato do header
const DUMMY_GH = `ghp_${randomBytes(18).toString('hex')}`;
const DUMMY_ADO = `azpat-dummy-${randomBytes(8).toString('hex')}`;
const DUMMY_ORG = `dummy-org-${randomBytes(3).toString('hex')}`;
// o valor de PERSONAL_ACCESS_TOKEN dentro do container é base64("ado-mcp:<PAT>")
const DUMMY_ADO_B64 = Buffer.from(`ado-mcp:${DUMMY_ADO}`).toString('base64');
const GITHUB_IMAGE = 'ghcr.io/github/github-mcp-server@sha256:508a0857ec762b1ab1cece29193345b501fab1dd9d1228a7b617062954cecac6';

// Referência da imagem local construída pelo compose (fonte única: o campo
// `image:` do compose.yaml, com a mesma resolução `${VAR:-default}` dos runtimes).
const COMPOSE_IMAGE = readFileSync(COMPOSE_FILE, 'utf8')
  .match(/^\s*image:\s*(ghcr\.io\/\$\{MCP_RUNTIME_IMAGE_OWNER:-[a-z0-9-]+}\/mcp-runtime:v\S+)$/m)[1]
  .replace('${MCP_RUNTIME_IMAGE_OWNER:-eximiaco}', 'eximiaco');

const MCP_CLIENT_INFO = { name: 'mcp-runtime-smoke', version: '0' };
const INITIALIZE_PARAMS = { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: MCP_CLIENT_INFO };
// sequência MCP completa por conexão: initialize → notifications/initialized → tools/list
const MCP_STEPS = [
  { id: 1, method: 'initialize', params: INITIALIZE_PARAMS },
  { kind: 'notification', method: 'notifications/initialized' },
  { id: 2, method: 'tools/list', params: {} },
];

const captured = [];

// nerdctl compose interpola somente via --env-file: o harness usa o mesmo
// mecanismo do produto (arquivo efêmero com pins + variáveis do runtime).
const COMPOSE_ENV_FILE = writeComposeEnvFile(CTX, { secretsFile: EPH_SECRETS, archCorpus: ARCH_CORPUS });
const composeBase = ['compose', '--env-file', COMPOSE_ENV_FILE, '--file', COMPOSE_FILE, '--project-name', `mcp-${CTX}`];

let RT = null;
let SOPS = null;
let AGE_KEYGEN = null;

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function record(label, result) {
  captured.push({ label, stdout: result.stdout || '', stderr: result.stderr || '' });
}

function cliEnv(extra = {}) {
  return {
    ...process.env,
    MCP_RUNTIME_CONFIG_DIR: CONFIG_ROOT,
    MCP_RUNTIME_ARCH_CORPUS: ARCH_CORPUS,
    ...extra,
  };
}

function runBin(...args) {
  const result = spawnSync(BIN, args, {
    env: cliEnv(),
    encoding: 'utf8',
    timeout: 900_000,
    windowsHide: true,
  });
  record(`bin ${args.join(' ')}`, result);
  return result;
}

// Variante assíncrona: obrigatória quando o próprio teste sobe fixtures em
// processo. `spawnSync` BLOQUEIA o event loop do processo de teste, então as
// fixtures (que respondem por callback) não conseguem atender a requisição e o
// produto só vê timeout — o teste mediria o bloqueio do driver, não o produto.
function runBinAsync(...args) {
  return new Promise((resolveRun) => {
    const child = spawn(BIN, args, {
      env: cliEnv(),
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => {
      const result = { status, stdout, stderr };
      record(`bin ${args.join(' ')}`, result);
      resolveRun(result);
    });
  });
}

function composeExec(service, shellScript) {
  const result = spawnSync(RT.path, [...composeBase, 'exec', '-T', service, '/bin/sh', '-c', shellScript], {
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
  });
  record(`compose exec ${service}`, result);
  return result;
}

function containerNamesForProject() {
  const result = spawnSync(RT.path, ['ps', '-a', '--filter', `label=com.docker.compose.project=mcp-${CTX}`, '--format', '{{.Names}}'], {
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
  });
  record('ps -a', result);
  // o compose rotula a IMAGEM local construída com project/service (docker
  // compose v2+); um container `run -i --rm` criado dessa imagem herda os
  // labels e o recolhimento de --rm é assíncrono — o filtro por label sozinho
  // pode listar transientes do próprio fluxo. O nome determinístico do
  // compose (<project>-<service>-<index>, igual nos dois runtimes) disambigua.
  return (result.stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((name) => name.startsWith(NAME_PREFIX));
}

// Logs de containers pelo runtime (denominador comum nerdctl/docker): o
// `compose logs` do nerdctl pende em projeto inexistente, então os nomes vêm
// do label de projeto do compose e os logs, do runtime direto.
function captureContainerLogs() {
  const logs = [];
  for (const name of containerNamesForProject()) {
    const result = spawnSync(RT.path, ['logs', '--tail', '400', name], {
      encoding: 'utf8',
      timeout: 60_000,
      windowsHide: true,
    });
    record(`logs ${name}`, result);
    logs.push({ name, ...result });
  }
  return logs;
}

// Nomes de container de um contexto QUALQUER (os invariantes 10+ usam contexto
// próprio, fora do CTX da suíte): mesmo mecanismo do compose (project-name
// `mcp-<contexto>`) e, como defesa extra, o filtro determinístico por nome.
function containerNamesForContext(context) {
  const result = spawnSync(RT.path, ['ps', '-a', '--filter', `label=com.docker.compose.project=mcp-${context}`, '--format', '{{.Names}}'], {
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
  });
  record(`ps -a (contexto ${context})`, result);
  return (result.stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function containerNamesByName(context) {
  const result = spawnSync(RT.path, ['ps', '-a', '--filter', `name=^mcp-${context}-`, '--format', '{{.Names}}'], {
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
  });
  record(`ps -a (name=^mcp-${context}-)`, result);
  return (result.stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

// runBin com cwd explícito e PWD coerente: um shell real exporta PWD ao mudar
// de diretório e o spawnSync do Node NÃO o define — sem PWD o defeito de cwd da
// ponte nerdctl↔VM (SPEC §10) nem se reproduz.
function runBinFrom(cwd, ...args) {
  const result = spawnSync(BIN, args, {
    cwd,
    env: cliEnv({ PWD: cwd }),
    encoding: 'utf8',
    timeout: 900_000,
    windowsHide: true,
  });
  record(`bin ${args.join(' ')} (cwd ${cwd})`, result);
  return result;
}

// Linha do relatório do produto para um serviço ("github: ...", "ado: ..."),
// opcionalmente restrita a uma linha que contenha `needle`.
function serviceLine(text, service, needle) {
  return String(text)
    .split(/\r?\n/)
    .find((line) => line.includes(`${service}:`) && (!needle || line.includes(needle))) || '';
}

// Fixture loopback do invariante 14 (classificação do handshake no `status`):
// NÃO mocka o produto — fixa só o que os endpoints de porta fixa (SPEC §1)
// devolvem, para exercitar "credencial recusada" (401) e "initialize OK" (SSE)
// sem rede, sem stack e sem depender de falha de ambiente.
const FIXTURE_ADO_INFO = { name: 'fixture-ado-server', version: '0.0.1-fixture' };

function readBody(request) {
  return new Promise((resolveBody) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => resolveBody(body));
  });
}

function listenFixture(port, handler) {
  return new Promise((resolveFixture, rejectFixture) => {
    const server = http.createServer(handler);
    server.once('error', rejectFixture);
    server.listen(port, '127.0.0.1', () => resolveFixture(server));
  });
}

async function closeFixture(server) {
  if (!server) return;
  await new Promise((resolveClose) => server.close(() => resolveClose()));
}

// sops -d NÃO é gravado em captured: o stdout é o plaintext por construção
// (SPEC §12 — o valor do segredo não pode existir em nenhuma captura).
function sopsDecrypt(sopsFile, keyFile) {
  return spawnSync(SOPS, ['-d', '--input-type', 'env', '--output-type', 'env', sopsFile], {
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, SOPS_AGE_KEY_FILE: keyFile },
    windowsHide: true,
  });
}

// -----------------------------------------------------------------------
// MCP por HTTP (modo 1 — transporte persistente em loopback)
// -----------------------------------------------------------------------

function extractResult(text, id) {
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    const payload = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed.startsWith('{') ? trimmed : null;
    if (!payload) continue;
    try {
      const message = JSON.parse(payload);
      if (message.id === id && message.result) return message.result;
    } catch {
      // linha parcial — segue
    }
  }
  return null;
}

// POST JSON-RPC em conexão NOVA por request (agent keepAlive:false): sockets
// keep-alive em pool apontam para a instância anterior de um container
// recriado e recebem RST no recreate (invariante 8) — a pool global do fetch
// introduz essa corrida; conexão nova por request elimina a dependência de
// reaproveitamento.
function postJson(url, jsonBody, headers = {}) {
  return new Promise((resolvePost, rejectPost) => {
    const target = new URL(url);
    const payload = JSON.stringify(jsonBody);
    const request = http.request({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: 'POST',
      headers: {
        'accept': 'application/json, text/event-stream',
        'content-type': 'application/json',
        ...headers,
        'content-length': Buffer.byteLength(payload),
      },
      agent: new http.Agent({ keepAlive: false }),
      timeout: 15_000,
    }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => resolvePost({ status: response.statusCode, text, headers: response.headers }));
    });
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', rejectPost);
    request.end(payload);
  });
}

async function mcpInitialize(url, bearer) {
  const response = await postJson(url, { jsonrpc: '2.0', id: 1, method: 'initialize', params: INITIALIZE_PARAMS }, bearer ? { authorization: `Bearer ${bearer}` } : {});
  captured.push({ label: `initialize ${url}`, stdout: response.text, stderr: '' });
  return { status: response.status, result: extractResult(response.text, 1) };
}

// Handshake completo: initialize → notifications/initialized → tools/list.
// O session id (quando o server o devolve) é repassado nas chamadas seguintes.
async function httpToolsList(url, bearer) {
  const headers = {
    'accept': 'application/json, text/event-stream',
    'content-type': 'application/json',
    ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
  };
  const init = await postJson(url, { jsonrpc: '2.0', id: 1, method: 'initialize', params: INITIALIZE_PARAMS }, headers);
  captured.push({ label: `http initialize ${url}`, stdout: init.text, stderr: '' });
  const initResult = extractResult(init.text, 1);
  const sessionId = init.headers['mcp-session-id'];
  const sessionHeaders = sessionId ? { ...headers, 'mcp-session-id': sessionId } : headers;
  const notified = await postJson(url, { jsonrpc: '2.0', method: 'notifications/initialized' }, sessionHeaders);
  captured.push({ label: `http notifications/initialized ${url} (HTTP ${notified.status})`, stdout: notified.text, stderr: '' });
  const list = await postJson(url, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, sessionHeaders);
  captured.push({ label: `http tools/list ${url}`, stdout: list.text, stderr: '' });
  return { init, initResult, list, listResult: extractResult(list.text, 2) };
}

// -----------------------------------------------------------------------
// MCP por stdio (modo 2 — por conexão): stdin aberto até todas as respostas;
// o grupo do processo é morto após a última resposta (bash → sops → runtime
// → server). Respostas casadas por id, na ordem declarada em MCP_STEPS.
// -----------------------------------------------------------------------

function stdioSession(command, timeoutMs = 90_000) {
  return new Promise((resolveSession) => {
    // detached: o bash vira líder de grupo — o kill(-pid) derruba bash → sops → runtime → server.
    const child = spawn('bash', ['-c', command], { stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const responses = [];
    let index = 0;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        // grupo já encerrado
      }
      resolveSession({ ok: result.ok, reason: result.reason, responses, stdout, stderr });
    };
    const timer = setTimeout(() => finish({ ok: false, reason: 'timeout' }), timeoutMs);
    const sendNext = () => {
      const step = MCP_STEPS[index];
      if (!step) {
        finish({ ok: true });
        return;
      }
      try {
        if (step.kind === 'notification') {
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: step.method })}\n`);
        } else {
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: step.id, method: step.method, params: step.params ?? {} })}\n`);
        }
      } catch (err) {
        finish({ ok: false, reason: `stdin: ${String(err)}` });
        return;
      }
      if (step.kind === 'notification') {
        index += 1;
        sendNext();
      }
    };
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      for (;;) {
        const parsed = takeNextResult(stdout);
        if (!parsed) break;
        stdout = parsed.rest;
        if (parsed.message.id === MCP_STEPS[index]?.id && parsed.message.result !== undefined) {
          responses.push(parsed.message.result);
          index += 1;
          sendNext();
          if (settled) break;
        }
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (err) => finish({ ok: false, reason: String(err) }));
    child.on('close', (code) => finish({ ok: false, reason: `exit ${code}` }));
    sendNext();
  });
}

// Consome a primeira linha completa de JSON-RPC com id e result; tolera linhas
// SSE ("data: ...") e linhas de log sem JSON.
function takeNextResult(buffer) {
  const lines = String(buffer).split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    const payload = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed;
    if (!payload.startsWith('{')) continue;
    try {
      const message = JSON.parse(payload);
      if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
        return { message, rest: lines.slice(i + 1).join('\n') };
      }
    } catch {
      // linha parcial — segue
    }
  }
  return null;
}

function stdioGithubCommand() {
  // imagem oficial pinada, sem build (TOOL.md, modo 2)
  const inner = `nerdctl run -i --rm -e GITHUB_PERSONAL_ACCESS_TOKEN="$GITHUB_PERSONAL_ACCESS_TOKEN" ${GITHUB_IMAGE} stdio`
    .replace('nerdctl', RT.name);
  const keyFile = join(CONFIG_ROOT, 'keys', `${CTX}.agekey`);
  const sopsFile = join(CONFIG_ROOT, 'contexts', CTX, 'secrets.sops.env');
  return `SOPS_AGE_KEY_FILE='${keyFile}' '${SOPS}' exec-env '${sopsFile}' '${inner}'`;
}

function stdioAdoCommand() {
  // imagem do contexto (construída pelo up), modo pat (TOOL.md, modo 2)
  const inner = [
    `nerdctl run -i --rm -e AZURE_DEVOPS_PAT="$AZURE_DEVOPS_PAT" -e ADO_ORG="$ADO_ORG" ${COMPOSE_IMAGE} sh -c`,
    '"export PERSONAL_ACCESS_TOKEN=\\$(printf ado-mcp:%s \\"\\$AZURE_DEVOPS_PAT\\" | base64); exec node /opt/mcp-runtime/node_modules/@azure-devops/mcp/dist/index.js \\"\\$ADO_ORG\\" --authentication pat"',
  ].join(' ').replace('nerdctl', RT.name);
  const keyFile = join(CONFIG_ROOT, 'keys', `${CTX}.agekey`);
  const sopsFile = join(CONFIG_ROOT, 'contexts', CTX, 'secrets.sops.env');
  return `SOPS_AGE_KEY_FILE='${keyFile}' '${SOPS}' exec-env '${sopsFile}' '${inner}'`;
}

before(async () => {
  RT = findRuntime();
  assert.ok(RT, 'nerdctl ou docker necessário no host');
  if (FORCED) {
    assert.equal(RT.name, FORCED, `o runner pediu ${FORCED}, mas o produto resolveu ${RT.name}`);
  }
  const tools = findSecretsTools();
  assert.ok(tools.sops, 'sops necessário no host');
  assert.ok(tools.ageKeygen, 'age-keygen necessário no host');
  SOPS = tools.sops;
  AGE_KEYGEN = tools.ageKeygen;

  // preflight: as portas fixas precisam estar livres (um contexto por vez)
  for (const port of [8377, 8378, 8379]) {
    try {
      await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1_000) });
      assert.fail(`porta ${port} já está em uso; encerre a stack existente antes dos testes`);
    } catch (err) {
      if (err instanceof assert.AssertionError) throw err;
      // sem resposta — porta livre
    }
  }
});

after(async () => {
  try {
    spawnSync(BIN, ['down', '--context', CTX], {
      env: cliEnv(),
      encoding: 'utf8',
      timeout: 180_000,
      stdio: 'pipe',
      windowsHide: true,
    });
  } catch {
    // limpeza de melhor esforço
  }
  rmSync(CONFIG_ROOT, { recursive: true, force: true });
  rmSync(EPH_DIR, { recursive: true, force: true });
  rmSync(dirname(COMPOSE_ENV_FILE), { recursive: true, force: true });
});

// -----------------------------------------------------------------------
// Invariante 1 — doctor
// -----------------------------------------------------------------------

test('doctor: pré-requisitos completos e runtime reportado é o exercido (invariante 1)', async () => {
  const result = runBin('doctor');
  assert.equal(result.status, 0, `doctor falhou:\n${result.stderr}`);
  const text = `${result.stdout}\n${result.stderr}`;
  assert.ok(text.includes('pré-requisitos completos'), `doctor deveria confirmar pré-requisitos:\n${text}`);
  assert.ok(text.includes(`runtime de container: ${RT.name}`), `doctor deveria reportar o runtime ${RT.name}:\n${text}`);
  if (FORCED) {
    assert.ok(text.includes(FORCED), `doctor deveria refletir o runtime forçado ${FORCED}:\n${text}`);
  }
});

// -----------------------------------------------------------------------
// Invariante 2 — segredos nativos (age-keygen, sops --encrypt --age, updatekeys)
// -----------------------------------------------------------------------

test('segredos nativos: round-trip sops/age e updatekeys preserva valores (invariante 2)', async () => {
  // criação do contexto com os comandos nativos documentados no TOOL.md
  const root = CONFIG_ROOT;
  const keyFile = join(root, 'keys', `${CTX}.agekey`);
  const ctxDir = join(root, 'contexts', CTX);
  mkdirSync(join(root, 'keys'), { recursive: true });
  mkdirSync(ctxDir, { recursive: true });
  const keygen = spawnSync(AGE_KEYGEN, ['-o', keyFile], { encoding: 'utf8', timeout: 30_000 });
  record('age-keygen (identidade do contexto)', keygen);
  assert.equal(keygen.status, 0, `age-keygen falhou: ${keygen.stderr}`);
  const pub = readFileSync(keyFile, 'utf8').match(/^# public key: (age1\S+)$/m)?.[1];
  assert.ok(pub, 'public key ausente no arquivo gerado');
  writeFileSync(join(ctxDir, 'recipients.txt'), `${pub}\n`);
  writeFileSync(join(ctxDir, '.sops.yaml'), `creation_rules:\n  - age: "${pub}"\n`);
  const sopsFile = join(ctxDir, 'secrets.sops.env');
  const expectedPlain = `GITHUB_PERSONAL_ACCESS_TOKEN=${DUMMY_GH}\nAZURE_DEVOPS_PAT=${DUMMY_ADO}\nADO_ORG=${DUMMY_ORG}\n`;
  writeFileSync(sopsFile, expectedPlain);
  const encrypt = spawnSync(SOPS, ['--encrypt', '--age', pub, '--in-place', '--input-type', 'env', '--output-type', 'env', sopsFile], {
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
  });
  record('sops --encrypt --age (in-place)', encrypt);
  assert.equal(encrypt.status, 0, `sops encrypt falhou: ${encrypt.stderr}`);
  assert.ok(!readFileSync(sopsFile, 'utf8').includes(DUMMY_GH), 'plaintext deveria estar cifrado');

  // round-trip: o decriptado confere com o plaintext (comparação por digest —
  // o stdout de sops -d nunca é gravado em captura)
  const plainDigest = sha256(expectedPlain);
  const decrypt = sopsDecrypt(sopsFile, keyFile);
  assert.equal(decrypt.status, 0, `sops -d falhou: ${decrypt.stderr}`);
  assert.equal(sha256(decrypt.stdout), plainDigest, 'round-trip divergiu do plaintext original');

  // updatekeys: nova identidade como recipient; valores preservados
  const key2File = join(root, 'keys', `${CTX}-rot.agekey`);
  const keygen2 = spawnSync(AGE_KEYGEN, ['-o', key2File], { encoding: 'utf8', timeout: 30_000 });
  record('age-keygen (recipient de rotação)', keygen2);
  assert.equal(keygen2.status, 0, `age-keygen (rotação) falhou: ${keygen2.stderr}`);
  const pub2 = readFileSync(key2File, 'utf8').match(/^# public key: (age1\S+)$/m)?.[1];
  assert.ok(pub2, 'public key de rotação ausente');
  writeFileSync(join(ctxDir, 'recipients.txt'), `${pub}\n${pub2}\n`);
  writeFileSync(join(ctxDir, '.sops.yaml'), `creation_rules:\n  - age: "${pub},${pub2}"\n`);
  // updatekeys é interativo: pede confirmação no stdin ("Is this okay? (y/n)")
  // e sai com EOF sem um stdin alimentado.
  const update = spawnSync(SOPS, ['updatekeys', sopsFile], {
    encoding: 'utf8',
    timeout: 30_000,
    input: 'y\n',
    cwd: ctxDir,
    env: { ...process.env, SOPS_AGE_KEY_FILE: keyFile },
    windowsHide: true,
  });
  record('sops updatekeys', update);
  assert.equal(update.status, 0, `sops updatekeys falhou: ${update.stderr}`);
  const decrypt1 = sopsDecrypt(sopsFile, keyFile);
  assert.equal(decrypt1.status, 0, `sops -d (identidade original) falhou após updatekeys: ${decrypt1.stderr}`);
  assert.equal(sha256(decrypt1.stdout), plainDigest, 'updatekeys deveria preservar os valores');
  const decrypt2 = sopsDecrypt(sopsFile, key2File);
  assert.equal(decrypt2.status, 0, 'o novo recipient deveria conseguir decriptar após updatekeys');
  assert.equal(sha256(decrypt2.stdout), plainDigest, 'valores divergem ao decriptar com o novo recipient');

  // doctor reconhece o contexto recém-criado
  const doctorCtx = runBin('doctor', '--context', CTX);
  assert.equal(doctorCtx.status, 0, `doctor --context falhou:\n${doctorCtx.stderr}`);
});

// -----------------------------------------------------------------------
// Invariante 2b — wrappers de segredos via binário (SPEC §6/§8)
// -----------------------------------------------------------------------

test('wrappers: secrets init/edit e keys add/remove preservam valores (invariante 2b)', () => {
  const WCTX = `${CTX}-w`;
  const init = runBin('secrets', 'init', '--context', WCTX);
  assert.equal(init.status, 0, `secrets init falhou:\n${init.stdout}\n${init.stderr}`);
  const wPaths = {
    key: join(CONFIG_ROOT, 'keys', `${WCTX}.agekey`),
    sopsFile: join(CONFIG_ROOT, 'contexts', WCTX, 'secrets.sops.env'),
    recipients: join(CONFIG_ROOT, 'contexts', WCTX, 'recipients.txt'),
  };
  const pub = readFileSync(wPaths.recipients, 'utf8').trim();
  assert.match(pub, /^age1/);
  assert.ok(readFileSync(wPaths.sopsFile, 'utf8').startsWith('#ENC['), 'template deveria nascer cifrado');

  // preenche os segredos ATRAVÉS do wrapper: o EDITOR do sops (invocado por
  // `secrets edit`) grava o plaintext definitivo no arquivo temporário do sops
  // (sobrescreve: o template traz chaves vazias e o dotenv não desduplica)
  const editor = join(CONFIG_ROOT, 'fill-editor.sh');
  writeFileSync(editor, `#!/bin/sh\nprintf 'GITHUB_PERSONAL_ACCESS_TOKEN=%s\\nADO_ORG=%s\\n' "$DUMMY_GH" "$DUMMY_ORG" > "$1"\n`, { mode: 0o755 });
  const edit = spawnSync(BIN, ['secrets', 'edit', '--context', WCTX], {
    env: cliEnv({ EDITOR: editor, DUMMY_GH, DUMMY_ORG }),
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
  });
  record('bin secrets edit (EDITOR preenche valores)', edit);
  assert.equal(edit.status, 0, `secrets edit falhou:\n${edit.stdout}\n${edit.stderr}`);
  const expected = `GITHUB_PERSONAL_ACCESS_TOKEN=${DUMMY_GH}\nADO_ORG=${DUMMY_ORG}\n`;
  const decrypted = sopsDecrypt(wPaths.sopsFile, wPaths.key);
  assert.equal(decrypted.status, 0, `decifra pós-edit falhou:\n${decrypted.stderr}`);
  assert.equal(sha256(decrypted.stdout), sha256(expected), 'valores divergem após secrets edit');

  // keys add: segundo recipient (identidade de um segundo contexto wrapper)
  const WCTX2 = `${CTX}-w2`;
  const init2 = runBin('secrets', 'init', '--context', WCTX2);
  assert.equal(init2.status, 0, `secrets init (2º contexto) falhou:\n${init2.stderr}`);
  const pub2 = readFileSync(join(CONFIG_ROOT, 'contexts', WCTX2, 'recipients.txt'), 'utf8').trim();
  const key2 = join(CONFIG_ROOT, 'keys', `${WCTX2}.agekey`);
  const add = runBin('keys', 'add', '--context', WCTX, '--recipient', pub2);
  assert.equal(add.status, 0, `keys add falhou:\n${add.stdout}\n${add.stderr}`);
  assert.ok(readFileSync(wPaths.recipients, 'utf8').includes(pub2));
  const withKey1 = sopsDecrypt(wPaths.sopsFile, wPaths.key);
  assert.equal(withKey1.status, 0, `decifra com key1 falhou:\n${withKey1.stderr}`);
  assert.equal(sha256(withKey1.stdout), sha256(expected), 'keys add deveria preservar os valores');
  const withKey2 = sopsDecrypt(wPaths.sopsFile, key2);
  assert.equal(withKey2.status, 0, 'novo recipient deveria decifrar após keys add');

  // keys remove: acesso removido, valores preservados
  const remove = runBin('keys', 'remove', '--context', WCTX, '--recipient', pub2);
  assert.equal(remove.status, 0, `keys remove falhou:\n${remove.stdout}\n${remove.stderr}`);
  const afterRemove = sopsDecrypt(wPaths.sopsFile, wPaths.key);
  assert.equal(afterRemove.status, 0, `decifra com key1 falhou pós-remove:\n${afterRemove.stderr}`);
  assert.equal(sha256(afterRemove.stdout), sha256(expected), 'keys remove deveria preservar os valores');
  const removedAccess = sopsDecrypt(wPaths.sopsFile, key2);
  assert.notEqual(removedAccess.status, 0, 'recipient removido ainda decifra');

  // remover o último recipient falha com erro explícito
  const last = runBin('keys', 'remove', '--context', WCTX, '--recipient', pub);
  assert.notEqual(last.status, 0);
  assert.match(last.stderr, /último recipient/);
  const stillThere = sopsDecrypt(wPaths.sopsFile, wPaths.key);
  assert.equal(stillThere.status, 0, 'arquivo deixou de decifrar após tentativa inválida');
});

// -----------------------------------------------------------------------
// Invariante 2c — tools install (bin-dir, checksum, adulteração limpa)
// -----------------------------------------------------------------------

const AGE_PIN_KEY = {
  'darwin-arm64': 'AGE_DARWIN_ARM64_SHA256',
  'darwin-x64': 'AGE_DARWIN_AMD64_SHA256',
  'linux-x64': 'AGE_LINUX_AMD64_SHA256',
  'linux-arm64': 'AGE_LINUX_ARM64_SHA256',
  'win32-x64': 'AGE_WINDOWS_AMD64_SHA256',
}[`${process.platform}-${process.arch}`];

test('tools install: pinado no bin-dir, doctor resolve de lá e adulteração falha limpa (invariante 2c)', () => {
  assert.ok(AGE_PIN_KEY, `plataforma sem pin de age: ${process.platform}-${process.arch}`);
  const binDir = join(homedir(), '.config', 'ai-playbook', 'bin');
  const pins = loadPins(PINS_FILE);
  // PATH restrito: sops/age só podem vir do bin-dir próprio (SPEC §7);
  // o runtime precisa continuar resolvendo para o doctor.
  const restrictedPath = [dirname(RT.path), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');
  const env = { ...process.env, PATH: restrictedPath, MCP_RUNTIME_CONFIG_DIR: CONFIG_ROOT, MCP_RUNTIME_ARCH_CORPUS: ARCH_CORPUS };

  const install = spawnSync(BIN, ['tools', 'install', '--force'], { env, encoding: 'utf8', timeout: 300_000, windowsHide: true });
  record('bin tools install --force (PATH restrito)', install);
  assert.equal(install.status, 0, `tools install falhou:\n${install.stdout}\n${install.stderr}`);
  assert.match(install.stdout, /sha256 verificado/);
  const sopsBin = join(binDir, 'sops');
  const ageBin = join(binDir, 'age');
  assert.ok(existsSync(sopsBin) && existsSync(ageBin) && existsSync(join(binDir, 'age-keygen')));
  const sopsVersion = spawnSync(sopsBin, ['--version'], { encoding: 'utf8', timeout: 30_000 });
  assert.ok(sopsVersion.stdout.includes(pins.SOPS_VERSION), `sops instalado não é o pinado (${pins.SOPS_VERSION}): ${sopsVersion.stdout}`);
  const ageVersion = spawnSync(ageBin, ['--version'], { encoding: 'utf8', timeout: 30_000 });
  assert.ok(ageVersion.stdout.includes(pins.AGE_VERSION), `age instalado não é o pinado (${pins.AGE_VERSION}): ${ageVersion.stdout}`);

  const doctor = spawnSync(BIN, ['doctor'], { env, encoding: 'utf8', timeout: 60_000, windowsHide: true });
  record('bin doctor (PATH restrito, pós-install)', doctor);
  assert.equal(doctor.status, 0, `doctor pós-install falhou:\n${doctor.stdout}\n${doctor.stderr}`);
  const doctorText = `${doctor.stdout}\n${doctor.stderr}`;
  assert.ok(doctorText.includes(sopsBin), `doctor deveria resolver sops do bin-dir próprio:\n${doctorText}`);
  assert.ok(doctorText.includes('pré-requisitos completos'));

  // adulteração do pin: cópia do artifact com sha256 errado para a plataforma
  // corrente; a instalação deve abortar ANTES de gravar qualquer binário.
  const tamperRoot = mkdtempSync(join(tmpdir(), 'mcp-runtime-tamper-'));
  try {
    mkdirSync(join(tamperRoot, 'containers'), { recursive: true });
    const tampered = { ...pins, [AGE_PIN_KEY]: 'ab'.repeat(32) };
    writeFileSync(
      join(tamperRoot, 'containers', 'pins.env'),
      `${Object.entries(tampered).map(([key, value]) => `${key}=${value}`).join('\n')}\n`,
    );
    rmSync(ageBin, { force: true });
    rmSync(join(binDir, 'age-keygen'), { force: true });
    const failed = spawnSync(BIN, ['tools', 'install'], {
      env: { ...env, MCP_RUNTIME_ARTIFACT_DIR: tamperRoot },
      encoding: 'utf8',
      timeout: 300_000,
      windowsHide: true,
    });
    record('bin tools install (pin adulterado)', failed);
    assert.notEqual(failed.status, 0, 'instalação com checksum adulterado deveria falhar');
    assert.match(`${failed.stdout}\n${failed.stderr}`, /checksum inválido/);
    assert.ok(!existsSync(ageBin), 'binário parcial deixado após falha de checksum');
    assert.ok(!existsSync(join(binDir, 'age-keygen')), 'binário parcial (age-keygen) após falha de checksum');
    // recuperação: instalação válida repõe o age
    const restored = spawnSync(BIN, ['tools', 'install'], { env, encoding: 'utf8', timeout: 300_000, windowsHide: true });
    record('bin tools install (recuperação)', restored);
    assert.equal(restored.status, 0, `reinstalação de recuperação falhou:\n${restored.stderr}`);
    const doctorAfter = spawnSync(BIN, ['doctor'], { env, encoding: 'utf8', timeout: 60_000, windowsHide: true });
    assert.equal(doctorAfter.status, 0, `doctor não voltou ao verde:\n${doctorAfter.stderr}`);
  } finally {
    rmSync(tamperRoot, { recursive: true, force: true });
  }
});

// -----------------------------------------------------------------------
// Invariante 10 — contexto incompleto: up falha rápido, sem criar container
// -----------------------------------------------------------------------

test('up com variável obrigatória vazia falha sem criar container (invariante 10)', () => {
  // Contexto PRÓPRIO (o up que deve falhar não pode contaminar o CTX da
  // suíte), com o layout de SPEC §5: config dir + identidade age isolados,
  // limpeza garantida no finally.
  const failContext = `teste-${randomBytes(3).toString('hex')}`;
  const failRoot = mkdtempSync(join(tmpdir(), 'mcp-runtime-smoke-fail-'));
  const failEnv = { ...process.env, MCP_RUNTIME_CONFIG_DIR: failRoot, MCP_RUNTIME_ARCH_CORPUS: ARCH_CORPUS };
  const failEph = ephemeralPaths(failContext);
  try {
    const keyFile = join(failRoot, 'keys', `${failContext}.agekey`);
    const ctxDir = join(failRoot, 'contexts', failContext);
    mkdirSync(join(failRoot, 'keys'), { recursive: true });
    mkdirSync(ctxDir, { recursive: true });
    const keygen = spawnSync(AGE_KEYGEN, ['-o', keyFile], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
    record('age-keygen (contexto do invariante 10)', keygen);
    assert.equal(keygen.status, 0, `age-keygen falhou: ${keygen.stderr}`);
    const pub = readFileSync(keyFile, 'utf8').match(/^# public key: (age1\S+)$/m)?.[1];
    assert.ok(pub, 'public key ausente no arquivo gerado');
    writeFileSync(join(ctxDir, 'recipients.txt'), `${pub}\n`);
    writeFileSync(join(ctxDir, '.sops.yaml'), `creation_rules:\n  - age: "${pub}"\n`);
    const sopsFile = join(ctxDir, 'secrets.sops.env');
    // ADO_ORG deliberadamente vazia; as outras variáveis presentes (dummy)
    writeFileSync(sopsFile, `GITHUB_PERSONAL_ACCESS_TOKEN=${DUMMY_GH}\nAZURE_DEVOPS_PAT=${DUMMY_ADO}\nADO_ORG=\n`);
    const encrypt = spawnSync(SOPS, ['--encrypt', '--age', pub, '--in-place', '--input-type', 'env', '--output-type', 'env', sopsFile], {
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true,
    });
    record('sops --encrypt (contexto do invariante 10)', encrypt);
    assert.equal(encrypt.status, 0, `sops encrypt falhou: ${encrypt.stderr}`);

    const startedAt = Date.now();
    const result = spawnSync(BIN, ['up', '--context', failContext], { env: failEnv, encoding: 'utf8', timeout: 900_000, windowsHide: true });
    const elapsedMs = Date.now() - startedAt;
    record(`bin up --context ${failContext} (contexto incompleto)`, result);
    const text = `${result.stdout}\n${result.stderr}`;

    assert.equal(result.status, 1, `up com ADO_ORG vazia deveria falhar:\n${text}`);
    assert.ok(text.includes('variáveis obrigatórias ausentes'), `up deveria nomear o bloco de variáveis ausentes:\n${text}`);
    assert.match(text, /ADO_ORG\s*\(serviço:\s*ado\)/, `up deveria nomear ADO_ORG e o serviço ado:\n${text}`);
    assert.ok(text.includes(`secrets edit --context ${failContext}`), `up deveria apontar a correção para o contexto:\n${text}`);
    assert.ok(text.includes('nenhum container foi criado'), `up deveria confirmar que nada foi iniciado:\n${text}`);
    // §5 nomeia o que FALTA: só a ausente entra nesse bloco (o PAT dummy está presente)
    assert.ok(!text.includes('GITHUB_PERSONAL_ACCESS_TOKEN'), 'o bloco de variáveis ausentes não deveria listar a variável presente (GITHUB_PERSONAL_ACCESS_TOKEN)');
    // a validação é fail-fast: não espera o deadline de prontidão
    assert.ok(elapsedMs < 60_000, `up deveria falhar na validação, não no deadline de prontidão (levou ${elapsedMs} ms)`);

    // nada foi criado: label do compose do contexto + nome determinístico
    assert.deepEqual(containerNamesForContext(failContext), [], 'um container do contexto foi criado apesar da falha de validação');
    assert.deepEqual(containerNamesByName(failContext), [], 'um container com o nome do contexto foi criado apesar da falha');
    // SPEC §9: falha de validação não pode deixar plaintext no host
    assert.equal(existsSync(failEph.secretsFile), false, 'plaintext efêmero sobreviveu ao up que falhou');
  } finally {
    try {
      spawnSync(BIN, ['down', '--context', failContext], { env: failEnv, encoding: 'utf8', timeout: 180_000, stdio: 'pipe', windowsHide: true });
    } catch {
      // limpeza de melhor esforço
    }
    rmSync(failRoot, { recursive: true, force: true });
    rmSync(failEph.dir, { recursive: true, force: true });
  }
});

// -----------------------------------------------------------------------
// Invariante 11 — up com prontidão reprovada: exit 1 + dump de logs
// -----------------------------------------------------------------------

// Sem caminho determinístico hoje: as portas são fixas (SPEC §1) e a stack do
// CTX as ocupa; um conflito de porta reprova o `compose up` ANTES do handshake,
// e no nerdctl/macOS a publicação acontece dentro da VM (o host vê a ponte),
// então o desfecho dependeria do ambiente — não do produto. O binário só
// aceita MCP_RUNTIME_CONFIG_DIR, _CONTEXT, _SECRETS_FILE, _CONTAINER_RUNTIME,
// _CONTAINER_USER, _ARTIFACT_DIR, _IMAGE_OWNER e _BIN (nenhum hook de
// prontidão), e forjar um server seria mockar o produto. Uma fixture 401/SSE
// como a do invariante 14 forçaria a classificação, mas o desfecho variaria por
// runtime (no docker o `compose up` morre no conflito de porta e não chega ao
// dump dos dois serviços; no nerdctl/macOS os containers sobem na VM) — o
// invariante precisa ser determinístico.
// Quando existir caminho determinístico (hook de prontidão documentado no
// INTERFACE-0.3.2, por exemplo), este teste deve passar a exigir: (a) exit 1;
// (b) `logs --tail 50` dos DOIS containers no dump; (c) nenhum resíduo efêmero
// após a falha; (d) nenhum valor dummy no dump (coberto pelo invariante 13).
test('up com prontidão reprovada: exit 1 e dump de logs dos dois containers (invariante 11)', { skip: 'sem caminho determinístico sem mock: portas 8377/8378 fixas e ocupadas pela stack do CTX, e nenhum hook de prontidão sancionado no INTERFACE-0.3.2' }, () => {
  assert.fail('inalcançável: invariante 11 marcada como skip');
});

// -----------------------------------------------------------------------
// Invariante 14 — status distingue pronto de credencial recusada
// -----------------------------------------------------------------------

test('status sem stack reporta container e efêmero e sai != 0 (invariante 14)', () => {
  // Antes do up do CTX: portas livres (preflight do before) e nenhum container
  // do contexto. O status deve reportar container + handshake por serviço.
  const result = runBin('status', '--context', CTX);
  const text = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 1, `status sem containers vivos deveria sair 1:\n${text}`);
  for (const service of ['github', 'ado']) {
    const line = serviceLine(text, service);
    assert.ok(line, `status sem a linha do serviço ${service}:\n${text}`);
    assert.ok(line.includes('container'), `status deveria reportar o estado do container de ${service}: ${line}`);
    assert.match(line, /(sem resposta|conexão recusada|porta \d+ fechada|não respondendo)/, `status deveria classificar o handshake indisponível de ${service}: ${line}`);
  }
  assert.match(text, /efêmero:\s*ausente/, `status deveria reportar o arquivo efêmero (SPEC §9):\n${text}`);
});

test('status distingue credencial recusada (401) de initialize OK (invariante 14)', async () => {
  // Mesmo cenário sem stack, agora com as fixtures fixando as respostas dos
  // endpoints de porta fixa: o produto classifica 401 como "credencial
  // recusada" e um handshake SSE como "initialize OK" — as duas classificações
  // na MESMA saída, de forma determinística.
  let refused = null;
  let mcp = null;
  try {
    refused = await listenFixture(8377, (request, response) => {
      response.writeHead(401, { 'content-type': 'text/plain' });
      response.end('Unauthorized');
    });
    mcp = await listenFixture(8378, async (request, response) => {
      const body = await readBody(request);
      let id = 1;
      try {
        id = JSON.parse(body).id ?? 1;
      } catch {
        // corpo não-JSON: id default
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify({ jsonrpc: '2.0', id, result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: FIXTURE_ADO_INFO } })}\n\n`);
    });

    // `runBinAsync`: as fixtures respondem pelo event loop deste processo —
    // um `runBin` (spawnSync) o bloquearia e o status só veria timeout.
    const result = await runBinAsync('status', '--context', CTX);
    const text = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.status, 1, `status sem containers vivos deveria sair 1:\n${text}`);

    const githubLine = serviceLine(text, 'github');
    assert.ok(githubLine, `status sem a linha do github:\n${text}`);
    assert.match(githubLine, /credencial recusada/, `github deveria ser classificado como credencial recusada: ${githubLine}`);
    assert.match(githubLine, /401/, `a classificação deveria trazer o código HTTP: ${githubLine}`);

    const adoLine = serviceLine(text, 'ado');
    assert.ok(adoLine, `status sem a linha do ado:\n${text}`);
    assert.match(adoLine, /initialize OK/, `ado deveria ser classificado como handshake OK: ${adoLine}`);
    assert.ok(adoLine.includes(FIXTURE_ADO_INFO.name), `status deveria reportar o serverInfo do handshake: ${adoLine}`);
    assert.ok(adoLine.includes(FIXTURE_ADO_INFO.version), `status deveria reportar a versão do serverInfo: ${adoLine}`);
  } finally {
    await closeFixture(refused);
    await closeFixture(mcp);
  }
});

// -----------------------------------------------------------------------
// Invariante 17 — tag da imagem do compose casa com metadata.version
// -----------------------------------------------------------------------

test('guard: tag da imagem no compose.yaml casa com metadata.version (invariante 17)', () => {
  const version = readFileSync(join(ART_DIR, 'artifact.yaml'), 'utf8')
    .match(/^\s*version:\s*([0-9]+\.[0-9]+\.[0-9]+[^\s]*)\s*$/m)?.[1];
  assert.ok(version, 'artifact.yaml sem metadata.version (a tag da imagem local é derivada dela)');
  const refs = [...readFileSync(COMPOSE_FILE, 'utf8').matchAll(/^\s*image:\s*(ghcr\.io\/[^\s]*\/mcp-runtime:[^\s]+)\s*$/gm)].map((match) => match[1]);
  assert.ok(refs.length > 0, 'compose.yaml sem a imagem do mcp-runtime');
  for (const ref of refs) {
    const tag = ref.match(/mcp-runtime:(.+)$/)?.[1] ?? '';
    const literal = tag.match(/^v?([0-9]+\.[0-9]+\.[0-9]+[^\s{}]*)$/)?.[1];
    if (literal) {
      assert.equal(literal, version, `tag do compose (${ref}) divergente de metadata.version (${version}) do artifact.yaml`);
      continue;
    }
    // Forma indireta (fora do INTERFACE-0.3.2, que fixa a tag literal): a tag
    // viria do env-file do up, derivada do artifact.yaml — o guard exige que a
    // derivação exista no fonte do produto.
    const variable = tag.match(/^\$\{MCP_RUNTIME_IMAGE_TAG(?::-([^}]*))?\}$/);
    if (variable) {
      if (variable[1]) {
        assert.equal(variable[1].replace(/^v/, ''), version, `default da variável (${variable[1]}) divergente do artifact.yaml`);
      }
      const sources = ['compose.rs', 'pins.rs', 'lifecycle.rs']
        .map((name) => join(ART_DIR, 'src', name))
        .filter((file) => existsSync(file))
        .map((file) => readFileSync(file, 'utf8'))
        .join('\n');
      assert.ok(sources.includes('MCP_RUNTIME_IMAGE_TAG'), 'a tag vem de ${MCP_RUNTIME_IMAGE_TAG}, mas o produto não define a variável');
      assert.ok(sources.includes('artifact.yaml'), 'a variável MCP_RUNTIME_IMAGE_TAG deveria ser derivada do artifact.yaml');
      continue;
    }
    assert.fail(`tag da imagem não reconhecida em ${ref}: "${tag}"`);
  }
});

// -----------------------------------------------------------------------
// Invariante 3 — up completo (3 healthy, initialize nos 3 endpoints)
// -----------------------------------------------------------------------

test('up completo: stack em loopback e initialize nos tres endpoints (invariante 3)', async () => {
  const result = runBin('up', '--context', CTX);
  assert.equal(result.status, 0, `up falhou:\n${result.stderr}\n${result.stdout}`);
  const text = `${result.stderr}\n${result.stdout}`;
  assert.ok(text.includes('arquivo efêmero removido'), 'janela efêmera não confirmada');
  assert.ok(text.includes(`runtime: ${RT.name}`), `up deveria exercitar o runtime ${RT.name}:\n${text}`);
  assert.equal(existsSync(EPH_SECRETS), false, 'arquivo efêmero deveria ter sido removido');

  const github = await mcpInitialize('http://127.0.0.1:8377/', DUMMY_GH);
  assert.equal(github.status, 200, `initialize github: HTTP ${github.status}`);
  assert.ok(github.result, 'initialize github sem result');
  assert.ok(github.result.serverInfo, 'initialize github sem serverInfo');

  const ado = await mcpInitialize('http://127.0.0.1:8378/mcp', null);
  assert.equal(ado.status, 200, `initialize ado: HTTP ${ado.status}`);
  assert.ok(ado.result, 'initialize ado sem result');
  assert.ok(ado.result.serverInfo, 'initialize ado sem serverInfo');

  const xharness = await mcpInitialize('http://127.0.0.1:8379/mcp', null);
  assert.equal(xharness.status, 200, `initialize xharness: HTTP ${xharness.status}`);
  assert.ok(xharness.result, 'initialize xharness sem result');
  assert.ok(xharness.result.serverInfo, 'initialize xharness sem serverInfo');
});

// -----------------------------------------------------------------------
// Invariante 12 — up prova o handshake (serverInfo), não só HTTP 200
// -----------------------------------------------------------------------

test('up imprime o serverInfo dos tres servicos no handshake (invariante 12)', async () => {
  const result = runBin('up', '--context', CTX);
  assert.equal(result.status, 0, `up falhou:\n${result.stderr}\n${result.stdout}`);
  const text = `${result.stderr}\n${result.stdout}`;
  assert.match(text, /stack pronta/, `up deveria confirmar a stack pronta:\n${text}`);

  // o serverInfo esperado vem do handshake VIVO (não de versão hardcoded):
  // o up tem de provar o mesmo serverInfo que o cliente vê.
  const live = {
    github: await mcpInitialize('http://127.0.0.1:8377/', DUMMY_GH),
    ado: await mcpInitialize('http://127.0.0.1:8378/mcp', null),
    xharness: await mcpInitialize('http://127.0.0.1:8379/mcp', null),
  };
  for (const service of ['github', 'ado', 'xharness']) {
    const handshake = live[service];
    assert.equal(handshake.status, 200, `${service}: handshake vivo HTTP ${handshake.status}`);
    const info = handshake.result?.serverInfo;
    assert.ok(info?.name, `${service}: handshake vivo sem serverInfo.name`);
    const line = serviceLine(text, service, 'initialize OK');
    assert.ok(line, `${service}: up sem a linha "initialize OK" (prova do handshake):\n${text}`);
    assert.match(line, /HTTP 200/, `${service}: a linha do handshake deveria trazer o status HTTP: ${line}`);
    assert.ok(line.includes(info.name), `${service}: a linha do up não traz o serverInfo (${info.name}): ${line}`);
    if (info.version) {
      assert.ok(line.includes(String(info.version)), `${service}: a linha do up não traz a versão do serverInfo (${info.version}): ${line}`);
    }
  }
});

// -----------------------------------------------------------------------
// Invariante 4 — efemeridade (arquivo no host, file secret, ambiente dos servers)
// -----------------------------------------------------------------------

test('efemeridade: plaintext ausente no host; segredo como file e no ambiente dos servers filhos (invariante 4)', () => {
  assert.equal(existsSync(EPH_SECRETS), false, 'arquivo decriptado deveria estar ausente no host após o up');
  for (const service of ['github', 'ado']) {
    const present = composeExec(service, 'test -s /run/secrets/secrets.env && echo presente');
    assert.ok((present.stdout || '').includes('presente'), `${service}: /run/secrets/secrets.env ausente`);
    const mode = composeExec(service, "stat -c '%a' /run/secrets/secrets.env");
    // nerdctl: bind do arquivo do host (0600); docker: materializado (0444)
    assert.ok(['600', '444'].includes((mode.stdout || '').trim()), `${service}: modo inesperado do secret: ${(mode.stdout || '').trim()}`);
  }

  // github: o server é o PID 1 (entrypoint executa o binário com o ambiente assinado)
  const ghDigest = sha256(DUMMY_GH);
  const ghEnv = composeExec('github',
    "tr '\\0' '\\n' </proc/1/environ | sed -n 's/^GITHUB_PERSONAL_ACCESS_TOKEN=//p' | tr -d '\\n' | sha256sum | cut -d' ' -f1");
  assert.equal((ghEnv.stdout || '').trim(), ghDigest, 'GITHUB_PERSONAL_ACCESS_TOKEN não confere no ambiente do server (digest)');

  // ado: o server é filho do supergateway; a variável assinada dentro do
  // container (source do /run/secrets) chega ao processo do server; verificação
  // por digest (o pipeline nunca imprime o valor — SPEC §12)
  const adoB64Digest = sha256(DUMMY_ADO_B64);
  const adoChild = composeExec('ado', [
    "n=0; d=''",
    'for p in /proc/[0-9]*; do',
    "  c=$(tr '\\0' ' ' <\"$p/cmdline\" 2>/dev/null)",
    "  case \"$c\" in *@azure-devops/mcp*)",
    "    n=$((n+1))",
    "    if [ -z \"$d\" ]; then",
    "      v=$(tr '\\0' '\\n' <\"$p/environ\" 2>/dev/null | sed -n 's/^PERSONAL_ACCESS_TOKEN=//p' | tr -d '\\n')",
    "      if [ -n \"$v\" ]; then d=$(printf '%s' \"$v\" | sha256sum | cut -d' ' -f1); fi",
    '    fi',
    '  ;;',
    'esac; done',
    'echo "count=$n"',
    'echo "digest=${d:-none}"',
  ].join('\n'));
  assert.equal(adoChild.status, 0, `inspeção do processo do server ado falhou: ${adoChild.stderr}`);
  const fields = Object.fromEntries((adoChild.stdout || '').trim().split(/\r?\n/).map((line) => line.split('=')));
  assert.ok(Number(fields.count) >= 1, `server ado (@azure-devops/mcp) não encontrado nos processos do container`);
  assert.equal(fields.digest, adoB64Digest, 'PERSONAL_ACCESS_TOKEN não confere no ambiente do server ado (digest)');

  const adoOrgDigest = sha256(DUMMY_ORG);
  const adoOrg = composeExec('ado',
    "tr '\\0' '\\n' </proc/1/environ | sed -n 's/^ADO_ORG=//p' | tr -d '\\n' | sha256sum | cut -d' ' -f1");
  assert.equal((adoOrg.stdout || '').trim(), adoOrgDigest, 'ADO_ORG não confere no ambiente do server (digest)');
});

// -----------------------------------------------------------------------
// Invariante 5 — consumo nos dois modos
// -----------------------------------------------------------------------

test('consumo HTTP persistente: initialize e tools/list nos tres endpoints (invariante 5)', async () => {
  for (const endpoint of [
    { name: 'github', url: 'http://127.0.0.1:8377/', bearer: DUMMY_GH },
    { name: 'ado', url: 'http://127.0.0.1:8378/mcp', bearer: null },
    { name: 'xharness', url: 'http://127.0.0.1:8379/mcp', bearer: null },
  ]) {
    const session = await httpToolsList(endpoint.url, endpoint.bearer);
    assert.equal(session.init.status, 200, `${endpoint.name}: initialize HTTP ${session.init.status}`);
    assert.ok(session.initResult, `${endpoint.name}: initialize sem result`);
    assert.ok(session.initResult.serverInfo, `${endpoint.name}: initialize sem serverInfo`);
    assert.equal(session.list.status, 200, `${endpoint.name}: tools/list HTTP ${session.list.status}`);
    assert.ok(Array.isArray(session.listResult?.tools), `${endpoint.name}: tools/list sem lista de tools`);
    assert.ok(session.listResult.tools.length > 0, `${endpoint.name}: tools/list vazio`);
  }
});

test('consumo stdio por conexão: sops exec-env + run -i --rm com initialize e tools/list (invariante 5)', async () => {
  const github = await stdioSession(stdioGithubCommand(), 60_000);
  captured.push({ label: 'stdio github', stdout: github.stdout, stderr: github.stderr });
  assert.ok(github.ok, `stdio github sem completar a sequência MCP: ${github.reason}\n${github.stderr}`);
  assert.equal(github.responses.length, 2, `stdio github: esperadas 2 respostas, veio ${github.responses.length}`);
  assert.ok(github.responses[0].serverInfo, 'stdio github: initialize sem serverInfo');
  assert.ok(Array.isArray(github.responses[1].tools) && github.responses[1].tools.length > 0, 'stdio github: tools/list vazio');

  const ado = await stdioSession(stdioAdoCommand(), 90_000);
  captured.push({ label: 'stdio ado', stdout: ado.stdout, stderr: ado.stderr });
  assert.ok(ado.ok, `stdio ado sem completar a sequência: ${ado.reason}\n${ado.stderr}`);
  assert.equal(ado.responses.length, 2, `stdio ado: esperadas 2 respostas, veio ${ado.responses.length}`);
  assert.ok(ado.responses[0].serverInfo, 'stdio ado: initialize sem serverInfo');
  assert.ok(Array.isArray(ado.responses[1].tools) && ado.responses[1].tools.length > 0, 'stdio ado: tools/list vazio');
});

// -----------------------------------------------------------------------
// Invariante 6 — regra de logs (SPEC §12)
// -----------------------------------------------------------------------

test('regra de logs: logs dos containers sem nenhum valor dummy (invariante 6)', () => {
  const logs = captureContainerLogs();
  const names = logs.map((entry) => entry.name).sort();
  assert.deepEqual(names, [`${NAME_PREFIX}ado-1`, `${NAME_PREFIX}github-1`], `esperados os 2 containers do compose, capturados: ${names.join(', ')}`);
  for (const entry of logs) {
    assert.equal(entry.status, 0, `logs de ${entry.name} falharam: ${entry.stderr}`);
    const text = `${entry.stdout}\n${entry.stderr}`;
    for (const value of [DUMMY_GH, DUMMY_ADO, DUMMY_ADO_B64]) {
      assert.ok(!text.includes(value), `valor dummy em logs de ${entry.name}`);
    }
  }
});

// -----------------------------------------------------------------------
// Invariante 7 — hardening por inspeção
// -----------------------------------------------------------------------

test('hardening em vigor em ambos os serviços (invariante 7)', () => {
  const probe = [
    "echo uid=$(id -u)",
    "awk '/^NoNewPrivs/{print \"nnp=\" $2}' /proc/self/status",
    "awk '/^CapEff/{print \"capeff=\" $2}' /proc/self/status",
    "if touch /usr/.rwprobe 2>/dev/null; then echo rofs=no; rm -f /usr/.rwprobe; else echo rofs=yes; fi",
    "if touch /tmp/.rwprobe 2>/dev/null; then echo tmpfs=yes; rm -f /tmp/.rwprobe; else echo tmpfs=no; fi",
    "if [ -e /var/run/docker.sock ]; then echo dockersock=yes; else echo dockersock=no; fi",
  ].join('; ');
  for (const service of ['github', 'ado']) {
    const result = composeExec(service, probe);
    assert.equal(result.status, 0, `inspeção do ${service} falhou: ${result.stderr}`);
    const fields = Object.fromEntries((result.stdout || '').trim().split(/\r?\n/).map((line) => line.split('=')));
    assert.equal(fields.uid, '10001', `${service}: usuário não-root (uid ${fields.uid})`);
    assert.equal(fields.nnp, '1', `${service}: no-new-privileges`);
    assert.equal(fields.capeff, '0000000000000000', `${service}: CapEff vazio`);
    assert.equal(fields.rofs, 'yes', `${service}: rootfs read-only`);
    assert.equal(fields.tmpfs, 'yes', `${service}: /tmp gravável`);
    assert.equal(fields.dockersock, 'no', `${service}: socket do daemon montado`);
  }
  const psResult = spawnSync(RT.path, [...composeBase, 'ps'], {
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
  });
  record('compose ps', psResult);
  const psText = `${psResult.stdout}\n${psResult.stderr}`;
  assert.ok(psText.includes('127.0.0.1:8377'), 'porta do github deve ser loopback');
  assert.ok(psText.includes('127.0.0.1:8378'), 'porta do ado deve ser loopback');
  assert.ok(!/0\.0\.0\.0/.test(psText), 'nenhuma publicação em 0.0.0.0');
});

// -----------------------------------------------------------------------
// Invariante 14 (continuação) — status com a stack pronta
// -----------------------------------------------------------------------

test('status pronto reporta container running, handshake e efêmero (invariante 14)', () => {
  const result = runBin('status', '--context', CTX);
  const text = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 0, `status com a stack pronta deveria sair 0:\n${text}`);
  for (const service of ['github', 'ado']) {
    const line = serviceLine(text, service);
    assert.ok(line, `status sem a linha do serviço ${service}:\n${text}`);
    assert.ok(line.includes('container running'), `${service}: status deveria reportar "container running": ${line}`);
    // o status decripta o contexto (o arquivo efêmero já foi removido) e prova
    // o handshake com o PAT, como na amostra do INTERFACE-0.3.2
    assert.ok(line.includes('initialize OK'), `${service}: status deveria reportar "initialize OK": ${line}`);
  }
  // O efêmero é removido ao fim de cada `up` (SPEC §9): com a stack pronta o
  // esperado é "ausente" — sem sugestão de reinício, que só confundiria.
  assert.match(text, /efêmero:\s*ausente/, `status deveria reportar o arquivo efêmero ausente (SPEC §9):\n${text}`);
  assert.doesNotMatch(text, /efêmero:\s*presente/, `status não deveria reportar efêmero presente com a stack pronta:\n${text}`);
});

// -----------------------------------------------------------------------
// Invariante 15 — invocação a partir de /tmp (symlink do macOS)
// -----------------------------------------------------------------------

test('cwd sob /tmp não vaza "ash: cd:" e o fluxo funciona igual (invariante 15)', { skip: process.platform === 'win32' ? '/tmp não existe no Windows' : false }, () => {
  const cwd = mkdtempSync(join('/tmp', 'mcp-runtime-cwd-'));
  try {
    // status (compose ps) e up (compose up + handshake) são os dois caminhos
    // que atravessam a ponte nerdctl↔VM; o cwd da ponte é o /tmp do HOST
    // (symlink de /private/tmp no macOS): sem PWD estável o shell da VM
    // imprime `ash: cd: /tmp/...`.
    const result = runBinFrom(cwd, 'status', '--context', CTX);
    const text = `${result.stdout}\n${result.stderr}`;
    assert.ok(!/ash:\s*cd/.test(text), `status de ${cwd} vazou o erro de cwd da ponte nerdctl↔VM:\n${text}`);
    assert.equal(result.status, 0, `status invocado de ${cwd} deveria funcionar igual:\n${text}`);
    for (const service of ['github', 'ado']) {
      assert.ok(serviceLine(text, service).includes('container running'), `${service}: status de ${cwd} deveria ver a stack:\n${text}`);
    }

    const up = runBinFrom(cwd, 'up', '--context', CTX);
    const upText = `${up.stdout}\n${up.stderr}`;
    assert.ok(!/ash:\s*cd/.test(upText), `up de ${cwd} vazou o erro de cwd da ponte nerdctl↔VM:\n${upText}`);
    assert.equal(up.status, 0, `up invocado de ${cwd} deveria funcionar igual:\n${upText}`);
    assert.match(upText, /stack pronta/, `up de ${cwd} deveria confirmar a stack pronta:\n${upText}`);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// -----------------------------------------------------------------------
// Invariante 16 — binário invocado por symlink resolve o artefato
// -----------------------------------------------------------------------

test('binário por symlink resolve containers/compose.yaml (invariante 16)', { skip: process.platform === 'win32' ? 'symlink exige privilégio no Windows' : false }, () => {
  const linkDir = mkdtempSync(join(tmpdir(), 'mcp-runtime-link-'));
  const link = join(linkDir, 'mcp-runtime');
  try {
    symlinkSync(BIN, link);
    // SEM MCP_RUNTIME_ARTIFACT_DIR: o diretório do artefato tem de ser
    // resolvido pelo binário (canonicalize do caminho do executável) — é o
    // guard do P6 (entrega pelo bin-dir próprio, via symlink).
    const result = spawnSync(link, ['status', '--context', CTX], {
      env: cliEnv(),
      encoding: 'utf8',
      timeout: 120_000,
      windowsHide: true,
    });
    record('bin (via symlink) status', result);
    const text = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.status, 0, `status invocado por symlink falhou (o artefato deveria ser resolvido por canonicalize):\n${text}`);
    for (const service of ['github', 'ado']) {
      assert.ok(serviceLine(text, service).includes('container running'), `${service}: status via symlink deveria ver a stack:\n${text}`);
    }
  } finally {
    rmSync(linkDir, { recursive: true, force: true });
  }
});

// -----------------------------------------------------------------------
// Invariante 13 — nenhum valor dummy no dump de logs do up nem no status
// -----------------------------------------------------------------------

test('nem o dump de logs do up nem a saída do status contêm valores dummy (invariante 13)', () => {
  const status = runBin('status', '--context', CTX);
  const statusText = `${status.stdout}\n${status.stderr}`;
  assert.ok(statusText.trim().length > 0, 'status sem saída para a varredura do invariante 13');

  // mesma checagem por VALOR do invariante 6 (que cobre os logs dos
  // containers), agora sobre TODA saída de up (inclusive o dump de logs da
  // reprovação) e todo status: o dump é superfície nova de SPEC §12.
  const secrets = [DUMMY_GH, DUMMY_ADO, DUMMY_ADO_B64];
  const targets = captured.filter((entry) => /^bin (up|status)\b/.test(entry.label));
  assert.ok(targets.some((entry) => /^bin up\b/.test(entry.label)), 'nenhuma saída de up capturada para a varredura');
  assert.ok(targets.some((entry) => /^bin status\b/.test(entry.label)), 'nenhuma saída de status capturada para a varredura');
  for (const entry of targets) {
    const text = `${entry.stdout}\n${entry.stderr}`;
    for (const value of secrets) {
      assert.ok(!text.includes(value), `valor dummy vazou na captura "${entry.label}"`);
    }
  }
  for (const value of secrets) {
    assert.ok(!statusText.includes(value), 'valor dummy vazou na saída de status');
  }
});

// -----------------------------------------------------------------------
// Invariante 8 — idempotência do up
// -----------------------------------------------------------------------

test('up idempotente: recria o efêmero e mantém healthy (invariante 8)', async () => {
  const result = runBin('up', '--context', CTX);
  assert.equal(result.status, 0, `segundo up falhou:\n${result.stderr}`);
  const text = `${result.stderr}\n${result.stdout}`;
  assert.ok(text.includes('arquivo efêmero removido'), 'janela efêmera não reconfirmada no segundo up');
  assert.equal(existsSync(EPH_SECRETS), false, 'arquivo efêmero deveria estar ausente após o segundo up');
  const github = await mcpInitialize('http://127.0.0.1:8377/', DUMMY_GH);
  assert.equal(github.status, 200, 'stack deveria continuar healthy após o segundo up (github)');
  const ado = await mcpInitialize('http://127.0.0.1:8378/mcp', null);
  assert.equal(ado.status, 200, 'stack deveria continuar healthy após o segundo up (ado)');
});

// -----------------------------------------------------------------------
// Invariante 9 — down
// -----------------------------------------------------------------------

test('down: containers, volumes e tmpdir removidos; status reflete a ausência (invariante 9)', async () => {
  const volumesUp = spawnSync(RT.path, ['volume', 'ls'], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
  record('volume ls (up)', volumesUp);
  assert.ok((volumesUp.stdout || '').includes(`mcp-${CTX}-ado-auth`), 'volume de auth ausente após up');

  const result = runBin('down', '--context', CTX);
  assert.equal(result.status, 0, `down falhou:\n${result.stderr}`);
  const volumesDown = spawnSync(RT.path, ['volume', 'ls'], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
  record('volume ls (down)', volumesDown);
  assert.ok(!(volumesDown.stdout || '').includes(`mcp-${CTX}-ado-auth`), 'volume sobreviveu ao down');
  const names = containerNamesForProject();
  assert.deepEqual(names, [], 'containers sobreviveram ao down');
  assert.equal(existsSync(EPH_DIR), false, 'resíduo efêmero sobreviveu ao down');

  // 0.3.2: `status` só sai 0 com os dois containers running E o handshake
  // obrigatório OK (SPEC §9, P8); sem stack o exit é 1 com a classificação por
  // serviço.
  const status = runBin('status', '--context', CTX);
  assert.equal(status.status, 1, `status sem stack deveria sair 1:\n${status.stdout}\n${status.stderr}`);
  const statusText = `${status.stdout}\n${status.stderr}`;
  for (const service of ['github', 'ado']) {
    const line = serviceLine(statusText, service);
    assert.ok(line, `status sem a linha do serviço ${service}:\n${statusText}`);
    assert.ok(line.includes('container ausente'), `${service}: status deveria reportar container ausente: ${line}`);
    assert.match(line, /(sem resposta|conexão recusada|porta \d+ fechada|não respondendo)/, `${service}: status deveria classificar o handshake indisponível: ${line}`);
  }
  assert.match(statusText, /efêmero:\s*ausente/, `status deveria reportar o arquivo efêmero ausente (SPEC §9):\n${statusText}`);
  assert.ok(!statusText.includes(`${CTX}-github`), 'status não deveria listar containers do contexto');
});

// -----------------------------------------------------------------------
// SPEC §12 — varredura final de vazamento em TODAS as capturas do fluxo
// -----------------------------------------------------------------------

test('nenhuma saída capturada (host ou container) contém valores dummy (SPEC §12)', () => {
  const secrets = [DUMMY_GH, DUMMY_ADO, DUMMY_ADO_B64];
  for (const capture of captured) {
    const text = `${capture.stdout}\n${capture.stderr}`;
    for (const value of secrets) {
      assert.ok(!text.includes(value), `valor dummy vazou na captura "${capture.label}"`);
    }
  }
});
