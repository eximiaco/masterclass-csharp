// Helpers do driver de testes (runner e suites smoke/integração).
// Infraestrutura de TESTE — não faz parte do produto: após a troca da unit
// mcp-runtime-smoke-switch, o único Node restante no artefato é o runner e
// este módulo. A resolução de ferramentas segue o produto (SPEC §7):
// bin-dir próprio → PATH.
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HELPERS_DIR = dirname(fileURLToPath(import.meta.url));
const ARTIFACT_DIR = resolve(HELPERS_DIR, '..');
export const PINS_FILE = join(ARTIFACT_DIR, 'containers', 'pins.env');
export const COMPOSE_FILE = join(ARTIFACT_DIR, 'containers', 'compose.yaml');

function pathEntries(pathValue, platform = process.platform) {
  return String(pathValue || '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
}

function executableCandidates(dir, name, platform = process.platform) {
  if (platform === 'win32') {
    const exts = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.toLowerCase());
    return exts.map((ext) => join(dir, `${name}${ext.toLowerCase()}`));
  }
  return [join(dir, name)];
}

export function findOnPath(name, pathValue = process.env.PATH, platform = process.platform) {
  for (const dir of pathEntries(pathValue, platform)) {
    for (const candidate of executableCandidates(dir, name, platform)) {
      try {
        const st = statSync(candidate);
        if (st.isFile() && (platform === 'win32' || st.mode & 0o111)) return candidate;
      } catch {
        // segue para o próximo candidato
      }
    }
  }
  return null;
}

// bin-dir próprio (~/.config/ai-playbook/bin) primeiro, PATH como fallback —
// mesma ordem da CLI Rust (SPEC §7). O PATH do usuário não é mutado.
export function findTool(name, env = process.env, platform = process.platform) {
  const binDir = join(homedir(), '.config', 'ai-playbook', 'bin');
  for (const candidate of executableCandidates(binDir, name, platform)) {
    try {
      const st = statSync(candidate);
      if (st.isFile() && (platform === 'win32' || st.mode & 0o111)) return candidate;
    } catch {
      // segue para o próximo candidato
    }
  }
  return findOnPath(name, env.PATH, platform);
}

export function findSecretsTools(env = process.env, platform = process.platform) {
  return {
    age: findTool('age', env, platform),
    ageKeygen: findTool('age-keygen', env, platform),
    sops: findTool('sops', env, platform),
  };
}

// Runtime de container: nerdctl primeiro, docker como fallback (SPEC §10).
// MCP_RUNTIME_CONTAINER_RUNTIME força a escolha: o runner propaga a flag
// --runtime por ela; o driver verifica que o produto reportou o mesmo runtime.
export function findRuntime(env = process.env, platform = process.platform) {
  const forced = String(env.MCP_RUNTIME_CONTAINER_RUNTIME || '').trim().toLowerCase();
  if (forced && forced !== 'nerdctl' && forced !== 'docker') {
    throw new Error(`MCP_RUNTIME_CONTAINER_RUNTIME inválido: "${env.MCP_RUNTIME_CONTAINER_RUNTIME}" (use nerdctl ou docker)`);
  }
  for (const name of (forced ? [forced] : ['nerdctl', 'docker'])) {
    const path = findOnPath(name, env.PATH, platform);
    if (path) return { name, path };
  }
  return null;
}

// O caminho efêmero é fixo (SPEC §9) — MCP_RUNTIME_CONFIG_DIR não o afeta.
export function ephemeralPaths(context, env = process.env, tempRoot = tmpdir()) {
  const dir = join(tempRoot, 'ai-playbook-mcp-runtime', context);
  return { dir, secretsFile: join(dir, 'secrets.env') };
}

// ---------------------------------------------------------------------------
// pins.env — fontes oficiais pinadas (mecanismo fixo).
// ---------------------------------------------------------------------------

export function loadPins(pinsFile = PINS_FILE) {
  const text = readFileSync(pinsFile, 'utf8');
  const pins = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) throw new Error(`${pinsFile}: linha inválida: ${line}`);
    pins[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return pins;
}

function composeEnvFileContents(pins, context, { secretsFile, containerUser, archCorpus } = {}) {
  const lines = Object.entries(pins).map(([key, value]) => `${key}=${value}`);
  lines.push(`MCP_RUNTIME_CONTEXT=${context}`);
  lines.push(`MCP_RUNTIME_SECRETS_FILE=${secretsFile ?? ephemeralPaths(context).secretsFile}`);
  // O default live no env-file (nunca em interpolação `${VAR:-default}` no
  // compose.yaml: o nerdctl mangela defaults com dois-pontos — verificado).
  lines.push(`MCP_RUNTIME_CONTAINER_USER=${containerUser ?? '10001:10001'}`);
  if (archCorpus) {
    lines.push(`MCP_RUNTIME_ARCH_CORPUS=${archCorpus}`);
  }
  return `${lines.join('\n')}\n`;
}

export function writeComposeEnvFile(context, { secretsFile, containerUser, archCorpus } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-runtime-compose-env-'));
  const file = join(dir, 'compose.env');
  writeFileSync(
    file,
    composeEnvFileContents(loadPins(PINS_FILE), context, { secretsFile, containerUser, archCorpus }),
    { mode: 0o600 },
  );
  return file;
}

/** Corpus mínimo para testes (SPEC §5 / ADR-0008). */
export const ARCH_CORPUS_FIXTURE = join(ARTIFACT_DIR, 'test', 'fixtures', 'arch-corpus');


export function removeTree(target) {
  rmSync(target, { recursive: true, force: true });
}
