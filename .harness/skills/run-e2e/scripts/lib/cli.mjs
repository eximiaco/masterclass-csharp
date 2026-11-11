// Parser de argumentos do run-e2e.mjs. Puro: não toca disco nem processo (testável).
export const MAX_WORKERS = 3;
export const DEFAULT_KEEP_RUNS = 5;

export const USAGE = `Uso:
  node run-e2e.mjs [alvos...] [opcoes] [-- <args extras do playwright test>]

Alvos: pasta ou spec sob contexts/core/frontend/e2e (ex.: e2e/features/smoke, features/architecture/decisions.spec.ts,
smoke). Sem alvo = suite completa.

Selecao:      --grep <padrao>  --grep-invert <padrao>  --list (listagem estatica, sem Docker)
Runner:       --workers <1..${MAX_WORKERS}>  --retries <n>  --repeat-each <n>  --timeout <ms>
Stack:        --no-stack  --keep-stack  --reset-db | --skip-db  --teardown-reset
Diagnostico:  --logs on-failure|always|never  --logs-services a,b
Saida:        --out <dir>  --keep-runs <n>  --dry-run`;

const LOG_POLICIES = ["on-failure", "always", "never"];

function parseInt10(flag, raw) {
  const value = Number.parseInt(raw ?? "", 10);
  if (Number.isNaN(value) || value < 0) throw new Error(`${flag} exige um inteiro >= 0; recebido ${JSON.stringify(raw)}`);
  return value;
}

export function defaultOptions() {
  return { targets: [], grep: null, grepInvert: null, list: false, workers: null, retries: null, repeatEach: null, timeout: null, noStack: false, keepStack: false, dbMode: null, teardownReset: false, logs: "on-failure", logsServices: null, out: null, keepRuns: DEFAULT_KEEP_RUNS, dryRun: false, passthrough: [] };
}

function applyFlag(opts, flag, next) {
  switch (flag) {
    case "--grep": opts.grep = next(); return;
    case "--grep-invert": opts.grepInvert = next(); return;
    case "--list": opts.list = true; return;
    case "--workers": opts.workers = parseInt10(flag, next()); return;
    case "--retries": opts.retries = parseInt10(flag, next()); return;
    case "--repeat-each": opts.repeatEach = parseInt10(flag, next()); return;
    case "--timeout": opts.timeout = parseInt10(flag, next()); return;
    case "--no-stack": opts.noStack = true; return;
    case "--keep-stack": opts.keepStack = true; return;
    case "--reset-db": opts.dbMode = "reset"; return;
    case "--skip-db": opts.dbMode = "skip"; return;
    case "--teardown-reset": opts.teardownReset = true; return;
    case "--logs": opts.logs = next(); return;
    case "--logs-services": opts.logsServices = next(); return;
    case "--out": opts.out = next(); return;
    case "--keep-runs": opts.keepRuns = parseInt10(flag, next()); return;
    case "--dry-run": opts.dryRun = true; return;
    default: throw new Error(`opcao desconhecida: ${flag}`);
  }
}

function validate(opts) {
  if (opts.workers != null && (opts.workers < 1 || opts.workers > MAX_WORKERS)) throw new Error(`--workers deve ficar entre 1 e ${MAX_WORKERS} (acima disso o Chromium cai no Docker Desktop e o Keycloak HML recusa logins simultaneos)`);
  if (!LOG_POLICIES.includes(opts.logs)) throw new Error(`--logs aceita ${LOG_POLICIES.join("|")}; recebido ${JSON.stringify(opts.logs)}`);
  if (opts.noStack && opts.dbMode) throw new Error("--no-stack nao combina com --reset-db/--skip-db (a stack nao e tocada)");
  if (opts.teardownReset && opts.keepStack) throw new Error("--teardown-reset e --keep-stack sao excludentes");
  if (opts.list && (opts.noStack || opts.keepStack || opts.dbMode)) throw new Error("--list e estatico e nao usa a stack; remova as opcoes de stack");
}

export function parseArgs(argv) {
  const opts = defaultOptions();
  let index = 0;
  while (index < argv.length) {
    const arg = argv[index];
    if (arg === "--") { opts.passthrough = argv.slice(index + 1); break; }
    if (!arg.startsWith("--")) { opts.targets.push(arg); index += 1; continue; }
    const next = () => { index += 1; if (index >= argv.length) throw new Error(`${arg} exige um valor`); return argv[index]; };
    applyFlag(opts, arg, next);
    index += 1;
  }
  validate(opts);
  return opts;
}

// Argumentos finais do `playwright test` (alvos já resolvidos entram como caminhos relativos ao runner).
export function playwrightArgs(opts, resolvedTargets) {
  const args = resolvedTargets.map((t) => t.path);
  if (opts.grep) args.push("--grep", opts.grep);
  if (opts.grepInvert) args.push("--grep-invert", opts.grepInvert);
  if (opts.workers != null) args.push("--workers", String(opts.workers));
  if (opts.retries != null) args.push("--retries", String(opts.retries));
  if (opts.repeatEach != null) args.push("--repeat-each", String(opts.repeatEach));
  if (opts.timeout != null) args.push("--timeout", String(opts.timeout));
  return [...args, ...opts.passthrough];
}
