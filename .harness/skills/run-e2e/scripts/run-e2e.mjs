#!/usr/bin/env node
import { resolveEnvironment, resolveAuthProfile, runControlled } from './lib/controlled.mjs';
// Executa os testes E2E (Playwright em containers) de ponta a ponta: sobe a stack, roda os specs
// selecionados, coleta resultado e logs, derruba a stack SEMPRE (salvo --keep-stack) e emite
// um relatório padronizado (JSON em stdout + report.json/summary.md no diretório de artefatos).
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EXIT_INFRA_ERROR, EXIT_PASSED, EXIT_TESTS_FAILED, FORBIDDEN_ACTIONS, emit, fail, log } from "./lib/report.mjs";
import { commandAvailable, runStreaming, runSync, tail } from "./lib/shell.mjs";
import { listSpecs, resolveTargets } from "./lib/targets.mjs";
import { parseResults, verdictOf } from "./lib/results.mjs";
import { DEFAULT_LOG_SERVICES, filterHighlights, logsWindow, parseServiceList } from "./lib/logs.mjs";
import { renderSummary } from "./lib/summary.mjs";
import { USAGE, parseArgs, playwrightArgs } from "./lib/cli.mjs";
import { holdStackLock } from "./lib/stack-lock.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..", "..", "..", "..");
const FRONTEND_DIR = join(REPO_ROOT, "contexts", "core", "frontend");
const E2E_DIR = join(FRONTEND_DIR, "e2e");
const ENV_FILE = join(E2E_DIR, "docker", ".env");
const RESULTS_FILE = join(FRONTEND_DIR, "test-results", "e2e-results.json");
const RUNS_DIR = join(REPO_ROOT, ".harness", "workspace", "e2e-runs");
// Telemetria do coletor OTel (otel/) e diagnóstico do login por worker (login/), gravados pela stack fora do outputDir.
const DIAGNOSTICS_DIR = join(FRONTEND_DIR, "e2e-diagnostics");
const COMPOSE_ARGS = ["compose", "-f", join(E2E_DIR, "docker", "compose.yml"), "-f", join(E2E_DIR, "docker", "compose.stack.yml")];
const RUN_ID_RE = /^\d{8}-\d{6}$/;

const SUGGESTIONS = {
  "stack-up": ["Ler o stderr: up.sh lista chaves vazias do .env (sem valores) ou o servico que nao ficou healthy.", "Conferir `docker compose ps` e `npm run e2e:stack:logs -- <servico>` em contexts/core/frontend.", "Primeiro boot dos frontends roda npm ci e leva minutos; o wait-timeout e 900 s."],
  runner: ["O runner nao produziu test-results/e2e-results.json: ler o stderr (build da imagem playwright, servico exigido fora do ar, argumento invalido do playwright).", "Com --no-stack, a stack precisa estar no ar: `npm run e2e:stack:status`."],
  "stack-lock": ["A stack E2E e unica na maquina e esta em uso por outra frente (holder.owner). Aguardar o fim daquela execucao e repetir.", "Nao derrubar nem reiniciar a stack alheia."],
  teardown: ["Derrubar manualmente: `npm run e2e:stack:down` em contexts/core/frontend; conferir containers orfaos com `docker ps --filter name=ftc-e2e`."]
};

function runId() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function gitInfo() {
  const branch = runSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: REPO_ROOT });
  const head = runSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO_ROOT });
  return { branch: branch.stdout.trim() || "?", head: head.stdout.trim() || "?" };
}

function prepareOutDir(opts, id) {
  const dir = opts.out ? resolve(opts.out) : join(RUNS_DIR, id);
  mkdirSync(join(dir, "logs"), { recursive: true });
  if (!opts.out) {
    writeFileSync(join(RUNS_DIR, ".gitignore"), "# Artefatos efemeros de execucoes E2E (skill run-e2e); nunca versionar.\n*\n!.gitignore\n");
    pruneRuns(id, opts.keepRuns);
  }
  return dir;
}

function pruneRuns(currentId, keep) {
  const runs = readdirSync(RUNS_DIR, { withFileTypes: true }).filter((e) => e.isDirectory() && RUN_ID_RE.test(e.name) && e.name !== currentId).map((e) => e.name).sort();
  const excess = runs.slice(0, Math.max(0, runs.length - Math.max(0, keep - 1)));
  for (const name of excess) rmSync(join(RUNS_DIR, name), { recursive: true, force: true });
}

function preflight(opts) {
  const { resolved, errors } = resolveTargets(opts.targets, { repoRoot: REPO_ROOT, frontendDir: FRONTEND_DIR });
  if (errors.length) fail({ phase: "preflight", step: "targets", message: errors.map((e) => e.message).join("; "), errors, usage: USAGE });
  const docker = commandAvailable("docker", ["compose", "version"]);
  const envPresent = existsSync(ENV_FILE);
  if (opts.list || opts.dryRun) return { resolved, docker, envPresent };
  if (!docker) fail({ phase: "preflight", step: "docker", message: "docker compose indisponivel", suggestions: ["Abrir o Docker Desktop e repetir."] });
  if (!envPresent) fail({ phase: "preflight", step: "env-file", message: `arquivo de segredos ausente: ${ENV_FILE}`, suggestions: ["Copiar e2e/docker/.env.example para e2e/docker/.env e pedir a responsavel para preencher (o agente nao le nem imprime valores)."] });
  return { resolved, docker, envPresent };
}

function listMode(resolved) {
  const specs = listSpecs(resolved.length ? resolved : [{ path: "e2e/features", kind: "dir" }], { frontendDir: FRONTEND_DIR });
  const total = specs.reduce((sum, s) => sum + s.entries.filter((e) => e.kind === "test").length, 0);
  emit({ status: "ok", mode: "list", note: "listagem estatica por regex (sem Docker); test.describe conta como grupo", total_tests: total, specs }, EXIT_PASSED);
}

async function stackUp(opts, outDir) {
  const flag = opts.dbMode === "reset" ? ["--reset-db"] : opts.dbMode === "skip" ? ["--skip-db"] : [];
  rmSync(join(FRONTEND_DIR, "playwright", ".auth"), { recursive: true, force: true });
  const started = Date.now();
  log(`subindo a stack (${flag.join(" ") || "db padrao"})...`);
  const result = await runStreaming("bash", [join(E2E_DIR, "stack", "up.sh"), ...flag], { cwd: FRONTEND_DIR });
  const upSeconds = Math.round((Date.now() - started) / 1000);
  if (result.exit_code !== 0) {
    captureStackState(outDir);
    throw infra("stack-up", "a stack E2E nao subiu", result);
  }
  return upSeconds;
}

function captureStackState(outDir) {
  const ps = runSync("docker", [...COMPOSE_ARGS, "ps", "--all"], { cwd: FRONTEND_DIR });
  writeFileSync(join(outDir, "logs", "compose-ps.txt"), ps.stdout + ps.stderr);
  const services = runSync("docker", [...COMPOSE_ARGS, "ps", "--all", "--services"], { cwd: FRONTEND_DIR }).stdout.split("\n").filter(Boolean);
  for (const service of services) {
    const logs = runSync("docker", [...COMPOSE_ARGS, "logs", "--no-color", "--tail", "200", service], { cwd: FRONTEND_DIR });
    writeFileSync(join(outDir, "logs", `${service}.log`), logs.stdout + logs.stderr);
  }
}

async function runPlaywright(args) {
  rmSync(RESULTS_FILE, { force: true });
  log(`playwright test ${args.join(" ")}`);
  return runStreaming("bash", [join(E2E_DIR, "docker", "run.sh"), ...args], { cwd: FRONTEND_DIR });
}

function collectResults(runResult) {
  if (!existsSync(RESULTS_FILE)) throw infra("runner", "o runner terminou sem gerar test-results/e2e-results.json", runResult);
  return parseResults(JSON.parse(readFileSync(RESULTS_FILE, "utf8")), { frontendDir: FRONTEND_DIR });
}

function collectLogs(opts, parsed, outDir) {
  const services = opts.logsServices ? parseServiceList(opts.logsServices) : DEFAULT_LOG_SERVICES;
  const window = logsWindow(parsed.stats);
  const logs = {};
  for (const service of services) {
    const range = window ? ["--since", window.since, "--until", window.until] : ["--tail", "500"];
    const result = runSync("docker", [...COMPOSE_ARGS, "logs", "--no-color", "--no-log-prefix", ...range, service], { cwd: FRONTEND_DIR });
    const file = join(outDir, "logs", `${service}.log`);
    writeFileSync(file, result.stdout + result.stderr);
    logs[service] = { file, window, highlights: filterHighlights(result.stdout) };
  }
  return logs;
}

// Com a stack nova, o coletor começa do zero; com --no-stack ele segue gravando nos mesmos arquivos (não apagar).
function resetDiagnostics(opts) {
  if (!opts.noStack) rmSync(join(DIAGNOSTICS_DIR, "otel"), { recursive: true, force: true });
  rmSync(join(DIAGNOSTICS_DIR, "login"), { recursive: true, force: true });
  mkdirSync(join(DIAGNOSTICS_DIR, "otel"), { recursive: true });
  mkdirSync(join(DIAGNOSTICS_DIR, "login"), { recursive: true });
}

// Depois do teardown o coletor já esvaziou o batch em disco; copia tudo para <run>/diagnostics.
function collectDiagnostics(outDir) {
  if (!existsSync(DIAGNOSTICS_DIR)) return null;
  const target = join(outDir, "diagnostics");
  cpSync(DIAGNOSTICS_DIR, target, { recursive: true });
  const loginRuns = existsSync(join(target, "login")) ? readdirSync(join(target, "login")) : [];
  return { dir: target, otel_dir: join(target, "otel"), login_dir: join(target, "login"), login_failures: loginRuns.filter((n) => n.endsWith("-failed")) };
}

function teardown(opts) {
  if (opts.keepStack) return { performed: false, status: "skipped", reason: "--keep-stack" };
  const flag = opts.teardownReset ? ["--reset"] : [];
  log("derrubando a stack...");
  const result = runSync("bash", [join(E2E_DIR, "stack", "down.sh"), ...flag], { cwd: FRONTEND_DIR });
  process.stderr.write(result.stdout + result.stderr);
  if (result.exit_code !== 0) return { performed: true, status: "error", command: result.command, exit_code: result.exit_code, stderr_tail: tail(result.stderr), suggestions: SUGGESTIONS.teardown };
  return { performed: true, status: "ok", volumes_removed: opts.teardownReset };
}

function infra(step, message, result) {
  const error = new Error(message);
  error.infra = { step, message, command: result?.command, exit_code: result?.exit_code, stdout_tail: tail(result?.stdout), stderr_tail: tail(result?.stderr), suggestions: SUGGESTIONS[step] ?? [] };
  return error;
}

function nextSteps(report) {
  if (report.verdict === "passed") return ["Suite verde: usar templates/evidence-summary.md para anexar a evidencia (stats, specs executados, caminho do summary.md)."];
  if (report.verdict === "infra-error") return [...(report.infra_error?.suggestions ?? []), "Corrigir a causa e reexecutar; nao alterar specs ou seed por erro de infra."];
  const steps = ["Antes de alterar spec ou seed: ler error-context.md de cada falha e os highlights de logs; aplicar templates/failure-analysis.md para classificar a causa (A spec, B ambiente, C produto, D dado)."];
  const categories = [...new Set(report.failures.map((f) => f.hint.category))];
  for (const category of categories) steps.push(`[${category}] ${report.failures.find((f) => f.hint.category === category).hint.action}`);
  steps.push("Reexecutar so os specs que falharam com `--no-stack --keep-stack` enquanto investiga; derrubar a stack ao final (`npm run e2e:stack:down`).");
  return steps;
}

function writeArtifacts(report, outDir) {
  if (existsSync(RESULTS_FILE)) copyFileSync(RESULTS_FILE, join(outDir, "e2e-results.json"));
  report.artifacts = { dir: outDir, report_json: join(outDir, "report.json"), summary_md: join(outDir, "summary.md"), results_json: join(outDir, "e2e-results.json"), html_report: join(FRONTEND_DIR, "playwright-report", "index.html"), test_results_dir: join(FRONTEND_DIR, "test-results") };
  report.next_steps = nextSteps(report);
  writeFileSync(report.artifacts.summary_md, renderSummary(report));
  writeFileSync(report.artifacts.report_json, JSON.stringify(report, null, 2) + "\n");
}

function finish(report) {
  const code = report.verdict === "passed" ? EXIT_PASSED : report.verdict === "failed" ? EXIT_TESTS_FAILED : EXIT_INFRA_ERROR;
  const status = report.verdict === "passed" ? "ok" : report.verdict === "failed" ? "failed" : "error";
  const { tests, ...compact } = report;
  emit({ status, ...compact, tests_total: tests?.length ?? 0, forbidden_actions: FORBIDDEN_ACTIONS }, code);
}

async function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (error) { fail({ phase: "cli", step: "usage", message: error.message, usage: USAGE }); }
  if (!opts.list && !opts.dryRun) {
    try { holdStackLock(REPO_ROOT); } catch (error) { fail({ phase: "preflight", step: "stack-lock", message: error.message, holder: error.details?.holder ?? null, suggestions: SUGGESTIONS["stack-lock"] }); }
  }
  try {
    const environment = resolveEnvironment(process.env.FTC_E2E_ENVIRONMENT);
    resolveAuthProfile(process.env.FTC_E2E_AUTH_PROFILE, environment);
    if (environment === 'controlled') {
      const result = await runControlled(REPO_ROOT, opts);
      emit(result.output, result.exitCode);
      return;
    }
  } catch (error) { fail({ phase: 'preflight', step: 'environment', message: error.message }); }
  const { resolved, docker, envPresent } = preflight(opts);
  if (opts.list) listMode(resolved);
  const args = playwrightArgs(opts, resolved);
  const id = runId();
  if (opts.dryRun) emit({ status: "ok", mode: "dry-run", run_id: id, targets: resolved, playwright_args: args, stack: { mode: opts.noStack ? "no-stack" : "up", db_mode: opts.dbMode ?? "up", teardown: opts.keepStack ? "skip" : opts.teardownReset ? "down --reset" : "down" }, logs: opts.logs, docker_available: docker, env_file_present: envPresent, out_dir: opts.out ?? join(RUNS_DIR, id) }, EXIT_PASSED);

  const outDir = prepareOutDir(opts, id);
  const report = { run_id: id, verdict: "infra-error", git: gitInfo(), targets: resolved, playwright_args: args, stack: { mode: opts.noStack ? "no-stack" : "up", db_mode: opts.noStack ? null : (opts.dbMode ?? "up"), up_seconds: null }, stats: null, failures: [], run_errors: [], logs: {}, teardown: { performed: false, status: "pending" }, infra_error: null };
  const onInterrupt = () => { report.teardown = teardown(opts); report.infra_error = { step: "interrupted", message: "execucao interrompida (SIGINT/SIGTERM)", suggestions: [] }; writeArtifacts(report, outDir); finish(report); };
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onInterrupt);

  try {
    resetDiagnostics(opts);
    if (!opts.noStack) report.stack.up_seconds = await stackUp(opts, outDir);
    const runResult = await runPlaywright(args);
    const parsed = collectResults(runResult);
    Object.assign(report, { stats: parsed.stats, tests: parsed.tests, failures: parsed.failures, run_errors: parsed.run_errors, verdict: verdictOf(parsed) });
    if (opts.logs === "always" || (opts.logs === "on-failure" && report.verdict === "failed")) report.logs = collectLogs(opts, parsed, outDir);
  } catch (error) {
    if (!error.infra) throw error;
    report.verdict = "infra-error";
    report.infra_error = error.infra;
  } finally {
    report.teardown = teardown(opts);
    report.diagnostics = collectDiagnostics(outDir);
  }
  writeArtifacts(report, outDir);
  finish(report);
}

main().catch((error) => fail({ phase: "run", step: "unexpected", message: error.message, stack: error.stack }));
