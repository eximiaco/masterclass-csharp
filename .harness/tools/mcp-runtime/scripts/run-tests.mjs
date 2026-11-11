#!/usr/bin/env node
// Harness de testes do mcp-runtime (SPEC §12):
//   1) suite Rust dentro de container (rust:1-bookworm): cargo test,
//      cargo fmt --check e cargo clippy -- -D warnings;
//   2) build do binário Rust no host (driver) + suite de integração com driver
//      no host — o nerdctl do Rancher Desktop (macOS) é binário do host e não
//      executa em containers; todo comportamento de produto exercido roda em
//      containers (compose up/exec, run -i, loopback) e o produto sob teste é
//      o binário Rust, injetado via MCP_RUNTIME_BIN;
//   3) suite smoke (Units mcp-runtime-smoke-test e mcp-runtime-smoke-switch):
//      fluxo completo por invariantes 1–9 pelo binário Rust com o runtime de
//      container forçado — a mesma rodada é executada com nerdctl e com docker
//      no mesmo ambiente (ADR-0001).
// Executa uma única rodada; códigos de saída são propagados sem reexecução.
//
// Uso:
//   run-tests.mjs [--profile default|smoke] [--runtime nerdctl|docker] [--help]
//   --profile default  suite cargo (container) + integração (host)
//   --profile smoke    SOMENTE a suite smoke (test/smoke/)
//   --runtime          força o runtime de container; default é a resolução
//                      automática nerdctl→docker. A escolha é propagada ao
//                      produto e às suites via MCP_RUNTIME_CONTAINER_RUNTIME.

import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const CONTAINERS_DIR = resolve(SCRIPT_DIR, '..', 'containers');
const PINS_FILE = join(CONTAINERS_DIR, 'pins.env');
const ARTIFACT_DIR = resolve(SCRIPT_DIR, '..');
const REPO_ROOT = resolve(SCRIPT_DIR, '..', '..', '..', '..');
const TARGET_BIN = join(ARTIFACT_DIR, 'target', 'debug', process.platform === 'win32' ? 'mcp-runtime.exe' : 'mcp-runtime');
const INTEGRATION_DIR = resolve(SCRIPT_DIR, '..', 'test', 'integration');
const SMOKE_DIR = resolve(SCRIPT_DIR, '..', 'test', 'smoke');
const PROFILES = ['default', 'smoke'];
const RUNTIMES = ['nerdctl', 'docker'];

class UsageError extends Error {}

function usage() {
  return [
    'Uso: run-tests.mjs [--profile default|smoke] [--runtime nerdctl|docker]',
    '',
    '  --profile default  suite cargo (container) + integração (host)',
    '  --profile smoke    somente a suite smoke (test/smoke/)',
    '  --runtime <nome>   força o runtime de container (nerdctl|docker);',
    '                     default: resolução automática nerdctl→docker',
  ].join('\n');
}

function parseArgs(argv) {
  const options = { profile: 'default', runtime: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (!arg.startsWith('--')) {
      throw new UsageError(`argumento desconhecido: ${arg} (opções: --profile, --runtime, --help)`);
    }
    const eq = arg.indexOf('=');
    const flag = eq > 2 ? arg.slice(0, eq) : arg;
    if (flag !== '--profile' && flag !== '--runtime') {
      throw new UsageError(`opção desconhecida: ${flag} (opções: --profile, --runtime, --help)`);
    }
    const allowed = flag === '--profile' ? PROFILES.join('|') : RUNTIMES.join('|');
    let value;
    if (eq > 2) {
      value = arg.slice(eq + 1);
    } else {
      i += 1;
      if (i >= argv.length) throw new UsageError(`opção ${flag} exige um valor (${allowed})`);
      value = argv[i];
    }
    if (flag === '--profile') {
      if (!PROFILES.includes(value)) throw new UsageError(`--profile inválido: "${value}" (use ${allowed})`);
      options.profile = value;
    } else {
      if (!RUNTIMES.includes(value)) throw new UsageError(`--runtime inválido: "${value}" (use ${allowed})`);
      options.runtime = value;
    }
  }
  return options;
}

function findRuntime(forced) {
  for (const name of (forced ? [forced] : ['nerdctl', 'docker'])) {
    for (const dir of String(process.env.PATH || '').split(':')) {
      const candidate = join(dir, name);
      try {
        const st = statSync(candidate);
        if (st.isFile() && st.mode & 0o111) return { name, path: candidate };
      } catch {
        // segue
      }
    }
  }
  return null;
}

// Volumes nomeados: mantêm toolchain (rustfmt/clippy) e cache do cargo entre
// rodadas — na primeira execução o runtime copia o conteúdo da imagem.
const CARGO_VOLUMES = [
  ['ai-playbook-rustup-cache', '/usr/local/rustup'],
  ['ai-playbook-cargo-cache', '/usr/local/cargo'],
];

function runCargoSuite(runtime) {
  console.error('[run-tests] suite Rust (rust:1-bookworm: cargo test + fmt --check + clippy -D warnings) ...');
  for (const [name] of CARGO_VOLUMES) {
    spawnSync(runtime.path, ['volume', 'create', name], { stdio: 'ignore', windowsHide: true });
  }
  // CARGO_TARGET_DIR separado do target/ do host evita briga de versões de
  // rustc (host × rust:1-bookworm) no mesmo diretório.
  const args = [
    'run', '--rm',
    '--volume', `${REPO_ROOT}:/workspace`,
    ...CARGO_VOLUMES.map(([name, mount]) => ['--volume', `${name}:${mount}`]).flat(),
    '--env', 'CARGO_TARGET_DIR=target/container-test',
    '--workdir', '/workspace/artifacts/tools/mcp-runtime',
    'rust:1-bookworm',
    // o volume rustup pode nascer vazio (volume é por runtime): garante os
    // componentes antes de fmt/clippy (idempotente e rápido quando presente)
    'sh', '-c', 'rustup component add rustfmt clippy && cargo test && cargo fmt --check && cargo clippy -- -D warnings',
  ];
  const result = spawnSync(runtime.path, args, { stdio: 'inherit', windowsHide: true });
  if (result.status !== 0) {
    console.error(`[run-tests] suite Rust falhou (exit ${result.status ?? 'signal'})`);
    return result.status ?? 1;
  }
  return 0;
}

function buildBinary() {
  console.error('[run-tests] build do binário Rust no host (driver de integração) ...');
  const result = spawnSync('cargo', ['build'], { cwd: ARTIFACT_DIR, stdio: 'inherit', windowsHide: true });
  if (result.status !== 0) {
    if (result.error) {
      console.error(`[run-tests] build do binário Rust falhou (${result.error}); cargo é necessário no host para o driver de integração`);
    } else {
      console.error(`[run-tests] build do binário Rust falhou (exit ${result.status ?? 'signal'})`);
    }
    return 1;
  }
  console.error(`[run-tests] binário de integração: ${TARGET_BIN}`);
  return 0;
}

function runNodeSuite(dir, label, env) {
  console.error(`[run-tests] suite ${label} (driver no host, produto em containers) ...`);
  const result = spawnSync(process.execPath, ['--test', join(dir, '*.test.mjs')], { stdio: 'inherit', env, windowsHide: true });
  if (result.status !== 0) {
    console.error(`[run-tests] suite ${label} falhou (exit ${result.status ?? 'signal'})`);
    return result.status ?? 1;
  }
  return 0;
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`[run-tests] ${err.message}`);
    console.error(usage());
    return 2;
  }
  if (options.help) {
    console.log(usage());
    return 0;
  }

  const runtime = findRuntime(options.runtime);
  if (!runtime) {
    console.error(options.runtime
      ? `[run-tests] runtime forçado não encontrado no PATH: ${options.runtime}`
      : '[run-tests] runtime de container não encontrado (nerdctl ou docker)');
    return 1;
  }
  console.error(`[run-tests] runtime: ${runtime.name}${options.runtime ? ' (forçado)' : ' (resolução automática nerdctl→docker)'}`);
  console.error(`[run-tests] perfil: ${options.profile}`);
  // A escolha do runtime é propagada ao produto e às suites de driver no host
  // via MCP_RUNTIME_CONTAINER_RUNTIME (o produto resolve o runtime por ela).
  const childEnv = { ...process.env };
  if (options.runtime) childEnv.MCP_RUNTIME_CONTAINER_RUNTIME = options.runtime;

  if (options.profile === 'smoke') {
    const cargoStatus = runCargoSuite(runtime);
    if (cargoStatus !== 0) return cargoStatus;
    if (buildBinary() !== 0) return 1;
    childEnv.MCP_RUNTIME_BIN = TARGET_BIN;
    const smokeStatus = runNodeSuite(SMOKE_DIR, 'smoke', childEnv);
    if (smokeStatus !== 0) return smokeStatus;
    console.error('[run-tests] suite smoke verde');
    return 0;
  }

  const cargoStatus = runCargoSuite(runtime);
  if (cargoStatus !== 0) return cargoStatus;

  if (buildBinary() !== 0) return 1;
  childEnv.MCP_RUNTIME_BIN = TARGET_BIN;

  const integrationStatus = runNodeSuite(INTEGRATION_DIR, 'integração', childEnv);
  if (integrationStatus !== 0) return integrationStatus;
  console.error('[run-tests] suites verdes');
  return 0;
}

process.exitCode = main();
