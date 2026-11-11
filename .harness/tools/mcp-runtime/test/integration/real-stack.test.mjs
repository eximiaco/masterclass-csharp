// Suite de integração do mcp-runtime (SPEC §12) — driver no host, produto 100% em containers.
// O nerdctl do Rancher Desktop (macOS) é binário do host e não executa dentro de
// containers; todo comportamento de produto é exercido em containers (compose
// up/down/exec, `run -i` via sops exec-env, endpoints em loopback).
// Stack real: SOPS/age, servidores oficiais pinados, sem mocks — valores dummy
// apenas no CONTEÚDO dos segredos; nenhuma saída pode conter esses valores.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ARCH_CORPUS_FIXTURE, findRuntime, findSecretsTools, writeComposeEnvFile } from '../helpers.mjs';

const ART_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
// Produto sob teste nesta unit: o binário Rust (port do script Node, que segue
// green até a unit de troca da smoke). O runner constrói no host e injeta o
// caminho via MCP_RUNTIME_BIN; o driver continua usando os helpers do script.
const BIN = process.env.MCP_RUNTIME_BIN;
if (!BIN) {
  throw new Error('MCP_RUNTIME_BIN não definido; o runner deve construir o binário Rust e injetar o caminho');
}
const CONTAINERS_DIR = join(ART_DIR, 'containers');
const PINS_FILE = join(CONTAINERS_DIR, 'pins.env');
const COMPOSE_FILE = join(CONTAINERS_DIR, 'compose.yaml');
const ARCH_CORPUS = process.env.MCP_RUNTIME_ARCH_CORPUS || ARCH_CORPUS_FIXTURE;

const CTX = `teste-${randomBytes(3).toString('hex')}`;
const CONFIG_ROOT = mkdtempSync(join(tmpdir(), 'mcp-runtime-it-cfg-'));
const EPH_DIR = join(tmpdir(), 'ai-playbook-mcp-runtime', CTX);
const EPH_SECRETS = join(EPH_DIR, 'secrets.env');
// formato clássico do GitHub (ghp_ + 36 alfanuméricos): o server valida o formato do header
const DUMMY_GH = `ghp_${randomBytes(18).toString('hex')}`;
const DUMMY_ADO = `azpat-dummy-${randomBytes(8).toString('hex')}`;
const DUMMY_ORG = `dummy-org-${randomBytes(3).toString('hex')}`;
const GITHUB_IMAGE = 'ghcr.io/github/github-mcp-server@sha256:508a0857ec762b1ab1cece29193345b501fab1dd9d1228a7b617062954cecac6';

// Referência da imagem local construída pelo compose (fonte única: o campo
// `image:` do compose.yaml, com a mesma resolução `${VAR:-default}` que os
// runtimes aplicam — o nome não depende mais do contexto, só da versão).
const COMPOSE_IMAGE = readFileSync(COMPOSE_FILE, 'utf8')
  .match(/^\s*image:\s*(ghcr\.io\/\$\{MCP_RUNTIME_IMAGE_OWNER:-[a-z0-9-]+}\/mcp-runtime:v\S+)$/m)[1]
  .replace('${MCP_RUNTIME_IMAGE_OWNER:-eximiaco}', 'eximiaco');

const captured = [];

// nerdctl compose interpola somente via --env-file: o harness usa o mesmo
// mecanismo do produto (arquivo efêmero com pins + variáveis do runtime).
const COMPOSE_ENV_FILE = writeComposeEnvFile(CTX, { secretsFile: EPH_SECRETS, archCorpus: ARCH_CORPUS });
const composeBase = ['compose', '--env-file', COMPOSE_ENV_FILE, '--file', COMPOSE_FILE, '--project-name', `mcp-${CTX}`];

let RT = null;
let SOPS = null;
let AGE_KEYGEN = null;

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

function runScript(...args) {
  const result = spawnSync(BIN, args, {
    env: cliEnv(),
    encoding: 'utf8',
    timeout: 600_000,
    windowsHide: true,
  });
  record(`bin ${args.join(' ')}`, result);
  return result;
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
  return (result.stdout || '').split(/\r?\n/).filter(Boolean);
}

// stdin permanece aberto até a resposta MCP chegar (o server sai ao EOF);
// o grupo do processo é morto após a resposta (bash → sops → nerdctl → server).
function stdioRoundTrip(command, timeoutMs = 45_000) {
  return new Promise((resolveRoundTrip) => {
    // detached: o bash vira líder de grupo — o kill(-pid) derruba bash → sops → nerdctl → server.
    const child = spawn('bash', ['-c', command], { stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        // grupo já encerrado
      }
      resolveRoundTrip({ stdout, stderr, ...result });
    };
    const timer = setTimeout(() => finish({ ok: false, reason: 'timeout' }), timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const parsed = firstResultFromSse(stdout) ?? parseSingleJson(stdout);
      if (parsed) finish({ ok: true, parsed });
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (err) => finish({ ok: false, reason: String(err) }));
    child.on('close', (code) => finish({ ok: false, reason: `exit ${code}` }));
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'mcp-runtime-integration', version: '0' } } })}\n`);
  });
}

function parseSingleJson(text) {
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const message = JSON.parse(trimmed);
      if (message.id === 1 && message.result) return message.result;
    } catch {
      // linha parcial — segue
    }
  }
  return null;
}

function firstResultFromSse(text) {
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    try {
      const message = JSON.parse(line.slice(5).trim());
      if (message.id === 1 && message.result) return message.result;
    } catch {
      // linha parcial — segue
    }
  }
  return null;
}

async function mcpInitialize(url, bearer) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'accept': 'application/json, text/event-stream',
      'content-type': 'application/json',
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'mcp-runtime-integration', version: '0' } } }),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  captured.push({ label: `initialize ${url}`, stdout: text, stderr: '' });
  const result = firstResultFromSse(text) ?? parseSingleJson(text);
  return { status: response.status, result };
}

before(async () => {
  RT = findRuntime();
  assert.ok(RT, 'nerdctl ou docker necessário no host');
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

  // contexto com SOPS/age nativos (SPEC §6): dummy apenas nos valores
  const root = CONFIG_ROOT;
  const keyFile = join(root, 'keys', `${CTX}.agekey`);
  const ctxDir = join(root, 'contexts', CTX);
  mkdirSync(join(root, 'keys'), { recursive: true });
  mkdirSync(ctxDir, { recursive: true });
  const keygen = spawnSync(AGE_KEYGEN, ['-o', keyFile], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(keygen.status, 0, `age-keygen falhou: ${keygen.stderr}`);
  const keyText = readFileSync(keyFile, 'utf8');
  const pub = keyText.match(/^# public key: (age1\S+)$/m)?.[1];
  assert.ok(pub, 'public key ausente no arquivo gerado');
  writeFileSync(join(ctxDir, 'recipients.txt'), `${pub}\n`);
  writeFileSync(join(ctxDir, '.sops.yaml'), `creation_rules:\n  - age: "${pub}"\n`);
  const plainFile = join(ctxDir, 'secrets.sops.env');
  writeFileSync(plainFile, `GITHUB_PERSONAL_ACCESS_TOKEN=${DUMMY_GH}\nAZURE_DEVOPS_PAT=${DUMMY_ADO}\nADO_ORG=${DUMMY_ORG}\n`);
  const encrypt = spawnSync(SOPS, ['--encrypt', '--age', pub, '--in-place', '--input-type', 'env', '--output-type', 'env', plainFile], {
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
  });
  record('sops encrypt', encrypt);
  assert.equal(encrypt.status, 0, `sops encrypt falhou: ${encrypt.stderr}`);
  assert.ok(!readFileSync(plainFile, 'utf8').includes(DUMMY_GH), 'plaintext deveria estar cifrado');
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

test('doctor --context passa com o contexto criado e sem stack no ar', async () => {
  const result = runScript('doctor', '--context', CTX);
  assert.equal(result.status, 0, `doctor falhou:\n${result.stderr}`);
});

test('up sobe a stack em loopback e remove o arquivo efêmero (SPEC §9, §10)', async () => {
  const result = runScript('up', '--context', CTX);
  assert.equal(result.status, 0, `up falhou:\n${result.stderr}\n${result.stdout}`);
  assert.ok((result.stderr || '').includes('arquivo efêmero removido'), 'janela efêmera não confirmada');
  assert.equal(existsSync(EPH_SECRETS), false, 'arquivo efêmero deveria ter sido removido');

  const github = await mcpInitialize('http://127.0.0.1:8377/', DUMMY_GH);
  assert.equal(github.status, 200, `initialize github: HTTP ${github.status}`);
  assert.ok(github.result, 'initialize github sem result');
  assert.ok(github.result.serverInfo, 'initialize github sem serverInfo');

  const ado = await mcpInitialize('http://127.0.0.1:8378/mcp', null);
  assert.equal(ado.status, 200, `initialize ado: HTTP ${ado.status}`);
  assert.ok(ado.result, 'initialize ado sem result');
  assert.ok(ado.result.serverInfo, 'initialize ado sem serverInfo');
});

test('up é idempotente (SPEC §8)', async () => {
  const result = runScript('up', '--context', CTX);
  assert.equal(result.status, 0, `segundo up falhou:\n${result.stderr}`);
  assert.equal(existsSync(EPH_SECRETS), false, 'arquivo efêmero removido no segundo up');
  const ado = await mcpInitialize('http://127.0.0.1:8378/mcp', null);
  assert.equal(ado.status, 200);
});

test('secret chega ao container pelo canal declarado e nunca em saída (SPEC §6, §9)', () => {
  const githubEnv = composeExec('github', "tr '\\0' '\\n' </proc/1/environ | grep -c '^GITHUB_PERSONAL_ACCESS_TOKEN='");
  assert.equal((githubEnv.stdout || '').trim(), '1', 'PAT ausente no PID 1 do github');
  const githubFile = composeExec('github', "test -s /run/secrets/secrets.env && echo presente");
  assert.ok((githubFile.stdout || '').includes('presente'), 'secret file ausente no github');
  const githubMode = composeExec('github', "stat -c '%a' /run/secrets/secrets.env");
  assert.ok(['600', '444'].includes((githubMode.stdout || '').trim()), `modo inesperado do secret: ${(githubMode.stdout || '').trim()}`);

  const adoPat = composeExec('ado', "tr '\\0' '\\n' </proc/1/environ | grep -c '^PERSONAL_ACCESS_TOKEN='");
  assert.equal((adoPat.stdout || '').trim(), '1', 'PERSONAL_ACCESS_TOKEN ausente no PID 1 do ado');
  const adoOrg = composeExec('ado', "tr '\\0' '\\n' </proc/1/environ | grep -c '^ADO_ORG='");
  assert.equal((adoOrg.stdout || '').trim(), '1', 'ADO_ORG ausente no PID 1 do ado');

  // o valor de PERSONAL_ACCESS_TOKEN dentro do container é base64("ado-mcp:<PAT>").
  // Compara por digest: imprimir o valor no stdout da captura faria o teste vazar
  // o próprio dummy na checagem final de vazamento (SPEC §6).
  const expectedDigest = createHash('sha256').update(Buffer.from(`ado-mcp:${DUMMY_ADO}`).toString('base64')).digest('hex');
  const adoB64 = composeExec('ado', "tr '\\0' '\\n' </proc/1/environ | sed -n 's/^PERSONAL_ACCESS_TOKEN=//p' | tr -d '\\n' | sha256sum | cut -d' ' -f1");
  assert.equal((adoB64.stdout || '').trim(), expectedDigest, 'PERSONAL_ACCESS_TOKEN não confere com o contrato do modo pat');
});

test('hardening em vigor em ambos os serviços (SPEC §11)', () => {
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
  assert.ok(psText.includes('127.0.0.1:8379'), 'porta do xharness deve ser loopback');
  assert.ok(!psText.includes('0.0.0.0'), 'nenhuma publicação em 0.0.0.0');
});

test('modo stdio por conexão — github com imagem oficial pinada (TOOL.md, SPEC §1)', async () => {
  const sopsFile = join(CONFIG_ROOT, 'contexts', CTX, 'secrets.sops.env');
  const inner = `nerdctl run -i --rm -e GITHUB_PERSONAL_ACCESS_TOKEN="$GITHUB_PERSONAL_ACCESS_TOKEN" ${GITHUB_IMAGE} stdio`
    .replace('nerdctl', RT.name);
  const keyFile = join(CONFIG_ROOT, 'keys', `${CTX}.agekey`);
  const command = `SOPS_AGE_KEY_FILE='${keyFile}' '${SOPS}' exec-env '${sopsFile}' '${inner}'`;
  const result = await stdioRoundTrip(command, 60_000);
  captured.push({ label: 'stdio github', stdout: result.stdout, stderr: result.stderr });
  assert.ok(result.ok, `stdio github sem initialize: ${result.reason}\n${result.stderr}`);
  assert.ok(result.parsed, 'initialize via stdio sem resposta MCP');
});

test('modo stdio por conexão — ado pat com imagem do contexto (TOOL.md, SPEC §1)', async () => {
  const sopsFile = join(CONFIG_ROOT, 'contexts', CTX, 'secrets.sops.env');
  const inner = [
    `nerdctl run -i --rm -e AZURE_DEVOPS_PAT="$AZURE_DEVOPS_PAT" -e ADO_ORG="$ADO_ORG" ${COMPOSE_IMAGE} sh -c`,
    '"export PERSONAL_ACCESS_TOKEN=\\$(printf ado-mcp:%s \\"\\$AZURE_DEVOPS_PAT\\" | base64); exec node /opt/mcp-runtime/node_modules/@azure-devops/mcp/dist/index.js \\"\\$ADO_ORG\\" --authentication pat"',
  ].join(' ').replace('nerdctl', RT.name);
  const keyFile = join(CONFIG_ROOT, 'keys', `${CTX}.agekey`);
  const command = `SOPS_AGE_KEY_FILE='${keyFile}' '${SOPS}' exec-env '${sopsFile}' '${inner}'`;
  const result = await stdioRoundTrip(command, 90_000);
  captured.push({ label: 'stdio ado', stdout: result.stdout, stderr: result.stderr });
  assert.ok(result.ok, `stdio ado sem initialize: ${result.reason}\n${result.stderr}`);
  assert.ok(result.parsed, 'initialize via stdio (ado) sem resposta MCP');
});

test('down remove containers, volume e resíduo efêmero; status reflete a ausência (SPEC §8, §10)', async () => {
  const volumesUp = spawnSync(RT.path, ['volume', 'ls'], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
  record('volume ls (up)', volumesUp);
  assert.ok((volumesUp.stdout || '').includes(`mcp-${CTX}-ado-auth`), 'volume de auth ausente após up');

  const result = runScript('down', '--context', CTX);
  assert.equal(result.status, 0, `down falhou:\n${result.stderr}`);
  const volumesDown = spawnSync(RT.path, ['volume', 'ls'], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
  record('volume ls (down)', volumesDown);
  assert.ok(!(volumesDown.stdout || '').includes(`mcp-${CTX}-ado-auth`), 'volume sobreviveu ao down');
  const names = containerNamesForProject();
  assert.deepEqual(names, [], 'containers sobreviveram ao down');
  assert.equal(existsSync(EPH_DIR), false, 'resíduo efêmero sobreviveu ao down');

  const status = runScript('status', '--context', CTX);
  assert.equal(status.status, 0, `status falhou:\n${status.stderr}`);
  const statusText = `${status.stdout}\n${status.stderr}`;
  assert.ok(statusText.includes('não respondendo'), 'status deveria apontar endpoints fora do ar');
  assert.ok(!statusText.includes(`${CTX}-github`), 'status não deveria listar containers do contexto');
});

test('nenhuma saída capturada contém valores dummy (SPEC §6)', () => {
  const secrets = [DUMMY_GH, DUMMY_ADO, Buffer.from(`ado-mcp:${DUMMY_ADO}`).toString('base64')];
  for (const capture of captured) {
    const text = `${capture.stdout}\n${capture.stderr}`;
    for (const value of secrets) {
      assert.ok(!text.includes(value), `valor dummy vazou na captura "${capture.label}"`);
    }
  }
});
