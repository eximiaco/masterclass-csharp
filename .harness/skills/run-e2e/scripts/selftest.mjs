#!/usr/bin/env node
// Testes da skill run-e2e sem Docker: parser de argumentos, resolução de alvos, parser de resultados,
// filtro de logs, summary e o CLI em --dry-run/--list contra o repositório real.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, playwrightArgs } from "./lib/cli.mjs";
import { listSpecs, resolveTargets } from "./lib/targets.mjs";
import { parseResults, verdictOf, toHostPath } from "./lib/results.mjs";
import { filterHighlights, logsWindow } from "./lib/logs.mjs";
import { renderSummary } from "./lib/summary.mjs";
import { holdStackLock } from "./lib/stack-lock.mjs";

import { resolveAuthProfile, resolveEnvironment, createRunPaths, validateOwnedRun, composeArgs, sanitizeControlledText } from '../../../../contexts/core/frontend/e2e/identity/controller.mjs';
import { AuthJourneyTenant, ForeignTenant, createCredentials, createRealm, createApplicationSettings, getClientScopeNames, getServiceRoleNames } from '../../../../contexts/core/frontend/e2e/identity/fixture.mjs';

import { createControlledViteConfig } from '../../../../contexts/core/frontend/e2e/identity/frontend-config.mjs';

import { executeControlledRun } from './lib/controlled.mjs';

import { readIntegratedContract, inspectAuthImage } from '../../../../contexts/core/frontend/e2e/identity/auth-integrated/profile.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const cliPath = join(scriptDir, "run-e2e.mjs");
const tempRoot = mkdtempSync(join(tmpdir(), "run-e2e-selftest-"));
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const assertEqual = (a, e, label) => assert(JSON.stringify(a) === JSON.stringify(e), `${label}: esperado ${JSON.stringify(e)}, obtido ${JSON.stringify(a)}`);
const assertThrows = (fn, re, label) => { try { fn(); } catch (error) { assert(re.test(error.message), `${label}: mensagem inesperada: ${error.message}`); return; } throw new Error(`${label}: nao lancou`); };

function fakeFrontend() {
  const frontendDir = join(tempRoot, "contexts", "core", "frontend");
  mkdirSync(join(frontendDir, "e2e", "features", "smoke"), { recursive: true });
  mkdirSync(join(frontendDir, "e2e", "shared"), { recursive: true });
  writeFileSync(join(frontendDir, "e2e", "features", "smoke", "a.spec.ts"), "import { test } from '../../shared/auth.fixture';\ntest.describe('Grupo', () => {\n  test('abre a tela', async () => {});\n  test.skip(\"caso \\\"x\\\"\", async () => {});\n});\n");
  writeFileSync(join(frontendDir, "e2e", "shared", "db.helpers.ts"), "export const x = 1;\n");
  return { repoRoot: tempRoot, frontendDir };
}

function fixtureResults() {
  const result = (status, extra = {}) => ({ workerIndex: 0, parallelIndex: 0, status, duration: 1200, errors: [], stdout: [], stderr: [], retry: 0, startTime: "2026-10-12T19:12:54.767Z", annotations: [], attachments: [], ...extra });
  const failing = result("failed", {
    errors: [{ message: "\u001b[31mError: Timeout 30000ms exceeded.\u001b[39m\nwaiting for getByRole('button')\n    at /e2e-runner/e2e/features/smoke/a.spec.ts:12:5", location: { file: "/e2e-runner/e2e/features/smoke/a.spec.ts", line: 12, column: 5 } }],
    attachments: [{ name: "error-context", contentType: "text/markdown", path: "/e2e-runner/test-results/smoke-a-x-chromium/error-context.md" }, { name: "trace", contentType: "application/zip", path: "/e2e-runner/test-results/smoke-a-x-chromium/trace.zip" }],
    stderr: [{ text: "linha 1\nlinha 2\n" }]
  });
  const spec = (title, line, tests) => ({ title, ok: true, tags: [], tests, id: "x", file: "features/smoke/a.spec.ts", line, column: 3 });
  const t = (status, results) => ({ timeout: 30000, annotations: [], expectedStatus: "passed", projectId: "chromium", projectName: "chromium", results, status });
  return {
    config: { version: "1.60.0", workers: 3, metadata: { actualWorkers: 3 } },
    suites: [{ title: "features/smoke/a.spec.ts", file: "features/smoke/a.spec.ts", line: 0, column: 0, specs: [], suites: [{ title: "Grupo", file: "features/smoke/a.spec.ts", line: 2, column: 6, specs: [
      spec("passa", 3, [t("expected", [result("passed")])]),
      spec("falha", 12, [t("unexpected", [failing, failing])]),
      spec("oscila", 20, [t("flaky", [result("failed", { errors: [{ message: "Page crashed" }] }), result("passed")])]),
      spec("fixture", 25, [t("unexpected", [result("timedOut", { errors: [{ message: "Fixture \"workerStorageState\" timeout of 1ms exceeded during setup.\n   at shared/auth.fixture.ts:60" }] })])]),
      spec("pulado", 30, [t("skipped", [result("skipped")])])
    ] }] }],
    errors: [],
    stats: { startTime: "2026-10-12T19:12:48.709Z", duration: 23384.03, expected: 1, skipped: 1, unexpected: 1, flaky: 1 }
  };
}

test("parseArgs: alvos, opcoes e passthrough", () => {
  const opts = parseArgs(["smoke", "features/x.spec.ts", "--grep", "ADR", "--workers", "2", "--keep-stack", "--", "--project=chromium"]);
  assertEqual(opts.targets, ["smoke", "features/x.spec.ts"], "targets");
  assertEqual([opts.grep, opts.workers, opts.keepStack, opts.passthrough], ["ADR", 2, true, ["--project=chromium"]], "opcoes");
  assertEqual(playwrightArgs(opts, [{ path: "e2e/features/smoke" }]), ["e2e/features/smoke", "--grep", "ADR", "--workers", "2", "--project=chromium"], "playwrightArgs");
});

test("parseArgs: rejeita workers > 3, opcoes invalidas e combinacoes excludentes", () => {
  assertThrows(() => parseArgs(["--workers", "5"]), /entre 1 e 3/, "workers");
  assertThrows(() => parseArgs(["--foo"]), /opcao desconhecida/, "desconhecida");
  assertThrows(() => parseArgs(["--keep-stack", "--teardown-reset"]), /excludentes/, "excludentes");
  assertThrows(() => parseArgs(["--no-stack", "--reset-db"]), /--no-stack nao combina/, "no-stack+db");
  assertThrows(() => parseArgs(["--logs", "sometimes"]), /--logs aceita/, "logs");
  assertThrows(() => parseArgs(["--grep"]), /exige um valor/, "valor ausente");
});

test("resolveTargets: normaliza pasta, prefixo e caminho absoluto; rejeita invalidos", () => {
  const ctx = fakeFrontend();
  const ok = resolveTargets(["smoke", "features/smoke/a.spec.ts", join(ctx.frontendDir, "e2e", "features", "smoke"), "contexts/core/frontend/e2e/features/smoke/"], ctx);
  assertEqual(ok.errors, [], "sem erros");
  assertEqual(ok.resolved.map((r) => r.path), ["e2e/features/smoke", "e2e/features/smoke/a.spec.ts", "e2e/features/smoke", "e2e/features/smoke"], "paths");
  const bad = resolveTargets(["nao-existe", "shared/db.helpers.ts"], ctx);
  assertEqual(bad.resolved, [], "nada resolvido");
  assert(bad.errors[0].message.includes("nao encontrado") && bad.errors[0].suggestions[1].includes("e2e/features/smoke"), "sugere pastas");
  assert(/nao e um spec/.test(bad.errors[1].message), "rejeita nao-spec");
});

test("listSpecs: extrai titulos por regex sem Docker", () => {
  const ctx = fakeFrontend();
  const specs = listSpecs([{ path: "e2e/features", kind: "dir" }], ctx);
  assertEqual(specs.map((s) => s.file), ["e2e/features/smoke/a.spec.ts"], "arquivos");
  assertEqual(specs[0].entries, [{ line: 2, kind: "describe", title: "Grupo" }, { line: 3, kind: "test", title: "abre a tela" }, { line: 4, kind: "test", title: "caso \\\"x\\\"" }], "entradas");
});

test("parseResults: stats, falhas com caminhos do host, dicas e veredito", () => {
  const frontendDir = "/repo/contexts/core/frontend";
  const parsed = parseResults(fixtureResults(), { frontendDir });
  assertEqual(parsed.stats.expected + parsed.stats.unexpected + parsed.stats.flaky + parsed.stats.skipped, 4, "stats");
  assertEqual(parsed.tests.length, 5, "tests");
  assertEqual(parsed.failures.map((f) => f.status), ["unexpected", "flaky", "unexpected"], "falhas");
  assertEqual(parsed.failures[2].hint.category, "auth-env", "hint fixture de auth");
  const failure = parsed.failures[0];
  assertEqual(failure.file, `${frontendDir}/e2e/features/smoke/a.spec.ts`, "file host");
  assertEqual(failure.attempts, 2, "tentativas");
  assertEqual(failure.error.location, `${frontendDir}/e2e/features/smoke/a.spec.ts:12:5`, "location");
  assert(!failure.error.message.includes("\u001b"), "ANSI removido");
  assertEqual(failure.attachments.error_context, `${frontendDir}/test-results/smoke-a-x-chromium/error-context.md`, "error-context");
  assertEqual(failure.hint.category, "ui-wait", "hint timeout");
  assertEqual(parsed.failures[1].hint.category, "runner-resources", "hint crash");
  assertEqual(failure.stderr_tail, ["linha 1", "linha 2"], "stderr tail");
  assertEqual(verdictOf(parsed), "failed", "veredito");
  assertEqual(verdictOf({ stats: { expected: 3, unexpected: 0, skipped: 0 }, run_errors: [] }), "passed", "verde");
  assertEqual(verdictOf({ stats: { expected: 0, unexpected: 0, skipped: 0 }, run_errors: [] }), "failed", "zero testes = falha");
  assertEqual(toHostPath("/outro/caminho", frontendDir), "/outro/caminho", "path fora do container intacto");
});

test("filterHighlights: mantem erros, descarta ruido do healthcheck", () => {
  const noise = ["[19:30:14 INF] Request starting HTTP/1.1 GET http://localhost:5001/auth/user - null null", "[19:30:14 INF] Executing endpoint 'HTTP: GET /auth/user'", "[19:30:14 DBG] [AuthFlow] GetUser: request started. IsAuthenticated: False, RequestId: x", "[19:30:14 DBG] [AuthFlow] GetUser Unauthorized: not authenticated. RequestId: x", "[19:30:14 INF] HTTP GET /auth/user responded 401 in 8.5510 ms", "[19:30:14 INF] Request finished HTTP/1.1 GET http://localhost:5001/auth/user - 401 0 null 16.3651ms"];
  const text = [...noise, "warn: Tenant not found. Identifier: default-tenant", "info: GET /api/identity/users/me responded 401", "info: GET /ok responded 200", "[INF] HTTP GET /auth/user responded 500 in 2 ms", "\u001b[31mfail: Unhandled exception\u001b[0m"].join("\n");
  const out = filterHighlights(text, 10);
  assertEqual(out.total_matches, 4, "total");
  assert(!out.lines.some((l) => /GetUser|\/auth\/user.*401/.test(l)), "healthcheck excluido");
  assert(out.lines.some((l) => l.includes("/auth/user responded 500")), "500 em /auth/user mantido");
  assert(out.lines[3] === "fail: Unhandled exception", "ANSI removido");
  assertEqual(filterHighlights(text, 1).lines.length, 1, "limite");
});

test("logsWindow: janela com margem a partir das stats", () => {
  const w = logsWindow({ start_time: "2026-10-12T19:12:48.709Z", duration_ms: 23384 });
  assertEqual([w.since, w.until], ["2026-10-12T19:12:38.709Z", "2026-10-12T19:13:22.093Z"], "janela");
  assertEqual(logsWindow({ start_time: null }), null, "sem start");
});

test("renderSummary: veredito, ponteiros da falha e proximos passos", () => {
  const parsed = parseResults(fixtureResults(), { frontendDir: "/repo/contexts/core/frontend" });
  const report = { run_id: "20261012-191248", verdict: "failed", git: { branch: "feature/x", head: "abc1234" }, targets: [{ path: "e2e/features/smoke" }], playwright_args: ["e2e/features/smoke"], stack: { mode: "up", db_mode: "up", up_seconds: 42 }, stats: parsed.stats, failures: parsed.failures, run_errors: [], logs: { "shell-bff": { file: "/x/shell-bff.log", window: null, highlights: { total_matches: 1, lines: ["warn: Tenant not found"] } } }, teardown: { performed: true, status: "ok" }, artifacts: { summary_md: "/x/summary.md" }, next_steps: ["passo 1"] };
  const md = renderSummary(report);
  for (const needle of ["**Veredito:** FALHOU", "| 1 | 1 | 1 | 1 |", "### 1. Grupo › falha", "a.spec.ts:12`", "error-context.md", "--no-stack --keep-stack", "Tenant not found", "- passo 1", "Teardown: ok"]) assert(md.includes(needle), `summary sem ${JSON.stringify(needle)}`);
});

test("stack-lock: segunda frente recebe o dono atual; dono encerrado e recuperado", async () => {
  const repo = join(tempRoot, "lock-repo");
  mkdirSync(repo, { recursive: true });
  assertEqual(spawnSync("git", ["init", "-q", repo]).status, 0, "git init");
  const holder = spawn("node", ["-e", "setTimeout(() => {}, 60000)"]);
  try {
    holdStackLock(repo, holder.pid);
    let busy = null;
    try { holdStackLock(repo, process.pid); } catch (error) { busy = error; }
    assertEqual(busy?.step, "lock-busy", "step com dono vivo");
    assertEqual(busy.details.holder.pid, holder.pid, "dono reportado");
    holder.kill();
    await new Promise((resolve) => holder.once("exit", resolve));
    holdStackLock(repo, process.pid);
  } finally {
    holder.kill();
  }
});

test("CLI --dry-run e --list contra o repositorio real (sem Docker)", () => {
  const dry = spawnSync("node", [cliPath, "smoke", "--grep", "Shell", "--dry-run"], { encoding: "utf8" });
  assertEqual(dry.status, 0, `dry-run exit (${dry.stdout}${dry.stderr})`);
  const plan = JSON.parse(dry.stdout);
  assertEqual([plan.status, plan.mode, plan.targets[0].path, plan.playwright_args, plan.stack.teardown], ["ok", "dry-run", "e2e/features/smoke", ["e2e/features/smoke", "--grep", "Shell"], "down"], "plano");
  const list = spawnSync("node", [cliPath, "--list"], { encoding: "utf8" });
  assertEqual(list.status, 0, `list exit (${list.stderr})`);
  const listed = JSON.parse(list.stdout);
  assert(listed.total_tests > 0 && listed.specs.some((s) => s.file.includes("smoke")), "lista o smoke");
  const bad = spawnSync("node", [cliPath, "nao-existe", "--dry-run"], { encoding: "utf8" });
  assertEqual(bad.status, 2, "alvo invalido = exit 2");
  assertEqual(JSON.parse(bad.stdout).step, "targets", "step targets");
  const usage = spawnSync("node", [cliPath, "--workers", "9"], { encoding: "utf8" });
  assertEqual([usage.status, JSON.parse(usage.stdout).step], [2, "usage"], "usage");
});

test('auth profile: enum e ambiente sem fallback', () => {
  assertEqual(resolveAuthProfile(undefined, 'controlled'), 'native', 'default native');
  assertEqual(resolveAuthProfile('auth-integrated', 'controlled'), 'auth-integrated', 'integrado');
  assertThrows(() => resolveAuthProfile('other', 'controlled'), /inválido/, 'profile inválido');
  assertThrows(() => resolveAuthProfile('auth-integrated', 'stg'), /exige controlled/, 'HML proibido');
});

test('auth profile: fonte/base/realm e par sintético fechados', async () => {
  const { contract, baseline } = await readIntegratedContract();
  assertEqual(contract.source.revision, '3284765037d9e19b81f78a0a6acbd38b0e665602', 'fonte pinada');
  assertEqual(contract.image.version, '26.4.5', 'versão Auth');
  const integrated = createCredentials('test-auth-integration', 'auth-integrated');
  assertEqual(integrated.accounts.length, 2, 'par exclusivo');
  assertEqual(integrated.accounts[0].password, integrated.accounts[1].password, 'senha igual sintética');
  const realm = createRealm(integrated, baseline);
  assertEqual([realm.loginTheme, realm.browserFlow], ['keywind', 'browser'], 'tema/flow');
  assert(realm.requiredActions.some((entry) => entry.alias === 'CONFIGURE_TOTP' && entry.enabled && entry.defaultAction), 'MFA preservado');
  assert(realm.users.every((entry) => entry.requiredActions.includes('CONFIGURE_TOTP')), 'matrícula real exigida');
  assert(!realm.clients[0].authenticationFlowBindingOverrides, 'sem override inventado');
  assertEqual(AuthJourneyTenant.name, 'AuthJourneyE2E', 'metadata de tenant');
  assert(AuthJourneyTenant.id !== ForeignTenant.id, 'ForeignTenant preservado');
  const native = createCredentials('test-auth-native');
  assert(native.accounts[0].password !== native.accounts[3].password, 'native não compartilha senha');
});

test("controlled: seleção explícita, sem fallback para stg", () => {
  assertEqual(resolveEnvironment(), 'stg', 'default');
  assertEqual(resolveEnvironment('controlled'), 'controlled', 'controlled');
  assertThrows(() => resolveEnvironment('unknown'), /inválido/, 'modo inválido');
});

test("controlled: contas/paths/projetos independentes e configuração sem STG", () => {
  const first = createRunPaths(tempRoot);
  const second = createRunPaths(tempRoot);
  assert(first.project !== second.project && first.runtime !== second.runtime, 'identidade exclusiva');
  const one = createCredentials(first.id);
  const two = createCredentials(second.id);
  assert(one.accounts.every(account => !two.accounts.some(other => other.email === account.email || other.password === account.password)), 'contas exclusivas');
  assertEqual(one.accounts.length, 15, 'cinco papéis por três workers');
  const realm = createRealm(one);
  assertEqual(realm.users.filter(user => user.groups.length === 0).length, 3, 'no-access sem grupo');
  for (const service of ['core-api', 'identity-api', 'tenant-api', 'shell-bff']) {
    const settings = createApplicationSettings(one, service);
    assert(!/appstg|FTC-HML|auth\.eximia|auth\.followthecode/.test(JSON.stringify(settings)), 'somente config local');
  }
});

test("controlled: cleanup recusa terceiro e compose usa env próprio", () => {
  const paths = createRunPaths(tempRoot);
  const marker = { schema_version: 1, owner: 'run-e2e-controlled', repoRoot: tempRoot, ...paths };
  validateOwnedRun(marker, tempRoot);
  assertThrows(() => composeArgs(tempRoot, { ...marker, project: 'ftc-e2e' }, ['down']), /Ownership/, 'preservar STG');
  const args = composeArgs(tempRoot, marker, ['down']);
  assert(args.includes(join(marker.runtime, 'control.env')) && !args.some(arg => arg.endsWith('/docker/.env')), 'env próprio');
});

test("controlled: diagnóstico elimina credenciais/JWT e dry-run mantém flags", () => {
  const credentials = createCredentials('test-run-123');
  const output = sanitizeControlledText(`${credentials.admin.password} ${credentials.accounts[0].password} eyJabcdefghijkl.abcdefghijklmnop.abcdefghijklmnop`, credentials);
  assert(!output.includes(credentials.admin.password) && !output.includes(credentials.accounts[0].password) && !output.includes('eyJ'), 'sem segredo');
  const result = spawnSync('node', [cliPath, 'smoke', '--workers', '1', '--retries', '0', '--dry-run'], {
    encoding: 'utf8', env: { ...process.env, FTC_E2E_ENVIRONMENT: 'controlled' },
  });
  assertEqual(result.status, 0, 'dry-run controlled');
  const report = JSON.parse(result.stdout);
  assertEqual(report.environment, 'controlled', 'ambiente');
  assert(report.playwright_args.includes('--workers') && report.playwright_args.includes('--retries'), 'flags preservadas');
  assertEqual(report.env_file_present, false, 'sem ler env STG');
});

test("controlled: falha de ambiente retorna exit 2 e executa teardown próprio", async () => {
  const paths = createRunPaths(tempRoot, join(tempRoot, 'controlled-failure'));
  const run = { marker: { ...paths }, credentials: createCredentials(paths.id), versions: {} };
  mkdirSync(paths.outDir, { recursive: true });
  const calls = [];
  const engine = {
    start: async () => { calls.push('start'); throw new Error('readiness failed'); },
    command: async () => { calls.push('logs'); return { exit_code: 0, output: 'safe log' }; },
    stop: async () => { calls.push('down'); return { exit_code: 0 }; },
  };
  const result = await executeControlledRun(tempRoot, join(tempRoot, 'frontend'), { logs: 'always' }, [], [], run, engine);
  assertEqual(result.exitCode, 2, 'infra-error');
  assertEqual(result.output.teardown.status, 'ok', 'teardown');
  assertEqual(calls, ['start', 'logs', 'down'], 'sem fallback STG após falha');
});

test("controlled: falha de coleta não impede teardown", async () => {
  const paths = createRunPaths(tempRoot, join(tempRoot, 'controlled-log-failure'));
  const run = { marker: { ...paths }, credentials: createCredentials(paths.id), versions: {} };
  mkdirSync(paths.outDir, { recursive: true });
  let stopped = false;
  const engine = {
    start: async () => { throw new Error('setup failed'); },
    command: async () => { throw new Error('collector failed'); },
    stop: async () => { stopped = true; return { exit_code: 0 }; },
  };
  const result = await executeControlledRun(tempRoot, join(tempRoot, 'frontend'), { logs: 'always' }, [], [], run, engine);
  assert(stopped && result.exitCode === 2, 'teardown obrigatório');
});

test("controlled: scope administrativo fica restrito à conta Identity", () => {
  assert(getClientScopeNames('ftc-identity-api').includes('kc-admin-api'), 'Identity necessita scope real da Admin API');
  assertEqual(getServiceRoleNames(), ['view-users', 'query-users', 'view-organizations'], 'native mantém roles restritas');
  assertEqual(getServiceRoleNames('auth-integrated'), ['view-users', 'query-users', 'manage-realm'], 'ampliação local explícita exigida por26.4.5');
  assert(!getClientScopeNames('ftc-identity-api', 'auth-integrated').includes('kc-admin-api'), '26.4.5 não inventa scope de26.8.2');
  assert(getClientScopeNames('ftc-identity-api', 'auth-integrated').includes('ftc-core-api'), 'Audiences FTC continuam no profile integrado');
  assert(!getClientScopeNames('ftc-frontend-bff-main').includes('kc-admin-api'), 'BFF não recebe scope administrativo');
  assert(!getClientScopeNames('ftc-core-api').includes('kc-admin-api'), 'Core não recebe scope administrativo');
});

test("controlled: Vite preserva plugins e limites, typecheck executa no gate estático", () => {
  const react = { name: 'vite:react' };
  const original = { plugins: [[react], { name: 'vite-plugin-checker' }], server: { fs: { allow: ['shared'] } } };
  const config = createControlledViteConfig(original, '5174');
  assertEqual(config.plugins, [react], 'plugins do produto');
  assertEqual(config.server, { fs: { allow: ['shared'] }, host: '0.0.0.0', port: 5174, strictPort: true }, 'servidor');
  assertEqual(original.plugins.length, 2, 'config original imutável');
  assertEqual(config.preview, { host: '0.0.0.0', port: 5174, strictPort: true }, 'preview isolado');
  assert(getClientScopeNames('ftc-frontend-bff-main').includes('organization'), 'BFF troca token mantendo membership real por scope padrão');
  assert(!getClientScopeNames('ftc-identity-api').includes('organization'), 'M2M Identity não ganha membership de usuário');
  assertThrows(() => createControlledViteConfig(original, '5001'), /Porta frontend inválida/, 'porta');
});


test("auth-integrated: identidade da imagem exige digest e plataforma reais", async () => {
  const identity = { Id: 'sha256:' + 'a'.repeat(64), Os: 'linux', Architecture: 'arm64', Variant: 'v8' };
  const validInspect = async () => ({ exit_code: 0, output: JSON.stringify(identity) });
  assertEqual(await inspectAuthImage(validInspect, 'owned'), { image: identity.Id, platform: 'linux/arm64/v8' }, 'plataforma efetiva');
  const invalidInspect = async () => ({ exit_code: 0, output: JSON.stringify({ Id: identity.Id }) });
  let rejected = false;
  try { await inspectAuthImage(invalidInspect, 'owned'); } catch { rejected = true; }
  assert(rejected, 'metadados incompletos não viram prova');
});

let failed = 0;
for (const { name, fn } of tests) {
  try { await fn(); process.stdout.write(`ok   ${name}\n`); } catch (error) { failed += 1; process.stdout.write(`FAIL ${name}\n     ${error.message}\n`); }
}
rmSync(tempRoot, { recursive: true, force: true });
process.stdout.write(`${tests.length - failed}/${tests.length} testes passaram\n`);
process.exit(failed ? 1 : 0);
