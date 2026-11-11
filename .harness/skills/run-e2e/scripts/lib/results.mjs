// Normaliza test-results/e2e-results.json (reporter json do Playwright) em um resumo padronizado.
import { stripAnsi } from "./shell.mjs";

const CONTAINER_ROOT = "/e2e-runner";
const TAIL_LINES = 20;
const ERROR_LINES = 40;

// Heurística determinística por padrão de mensagem: dica inicial, não diagnóstico.
const HINTS = [
  { category: "auth-env", re: /keycloak|\/realms\/|\/auth\/login|login\.ts|auth\.fixture|workerStorageState|storageState|sign in|signin/i, action: "Teste parou no login/sessao: conferir highlights de shell-bff e core-api (401/400 de /api/identity, Tenant API, logout). Se for STG, registrar e repetir UMA vez sem alterar spec ou seed." },
  { category: "runner-resources", re: /page crashed|target (?:page|context|browser) has been closed|browser has been closed|out of memory/i, action: "Chromium caiu no container: manter workers <= 3, conferir memoria do Docker Desktop (>= 4 GB livres para a stack) e repetir." },
  { category: "stack-network", re: /net::ERR_|ECONNREFUSED|ECONNRESET|50[234] /i, action: "Servico da stack indisponivel: conferir `status` dos containers e os logs do servico citado na mensagem." },
  { category: "data", re: /queryRows|relation .* does not exist|column .* does not exist|db\.helpers|received: 0|toHaveCount/i, action: "Asserção de dado: conferir seed (e2e/db/seed) e contagens de e2e/db/_db.sh; divergencia que indique defeito de produto e reportada, nao mascarada no seed." },
  { category: "ui-wait", re: /timeout .* exceeded|waiting for|toBeVisible|toHaveText|toContainText|locator\(|getBy/i, action: "Espera/locator: abrir error-context.md (snapshot da pagina) e o trace antes de mexer no spec; confirmar se a tela mudou ou se o dado esperado nao existe." }
];

function hintFor(message) {
  const hit = HINTS.find((h) => h.re.test(message));
  return hit ? { category: hit.category, action: hit.action } : { category: "unclassified", action: "Ler error-context.md e os highlights de logs; aplicar templates/failure-analysis.md para classificar a causa." };
}

export function toHostPath(path, frontendDir) {
  if (!path) return path;
  return path.startsWith(CONTAINER_ROOT + "/") ? `${frontendDir}/${path.slice(CONTAINER_ROOT.length + 1)}` : path;
}

function attachmentsOf(result, frontendDir) {
  const out = {};
  for (const att of result.attachments ?? []) {
    const path = toHostPath(att.path, frontendDir);
    if (!path) continue;
    if (att.name === "error-context") out.error_context = path;
    else if (att.name === "trace") out.trace = path;
    else if (att.name === "screenshot") out.screenshot = path;
    else if (att.name === "video") out.video = path;
    else (out.other ??= []).push({ name: att.name, path });
  }
  return out;
}

function streamTail(entries) {
  return (entries ?? []).map((e) => stripAnsi(e.text ?? "")).join("").split("\n").filter(Boolean).slice(-TAIL_LINES);
}

function errorOf(result, frontendDir) {
  const first = (result.errors ?? [])[0];
  if (!first) return null;
  const message = stripAnsi(first.message ?? "").split("\n").slice(0, ERROR_LINES).join("\n");
  const loc = first.location;
  return { message, location: loc ? `${toHostPath(loc.file, frontendDir)}:${loc.line}:${loc.column}` : null, snippet: first.snippet ? stripAnsi(first.snippet) : null };
}

function walk(suite, titlePath, acc) {
  for (const spec of suite.specs ?? []) acc.push({ spec, titlePath: [...titlePath, spec.title] });
  for (const child of suite.suites ?? []) walk(child, [...titlePath, child.title], acc);
}

function failureEntry({ spec, titlePath }, test, frontendDir) {
  const results = test.results ?? [];
  const last = results[results.length - 1] ?? {};
  const failed = [...results].reverse().find((r) => (r.errors ?? []).length > 0) ?? last;
  const error = errorOf(failed, frontendDir);
  return {
    title: titlePath.join(" › "),
    file: `${frontendDir}/e2e/${spec.file}`,
    line: spec.line,
    project: test.projectName,
    status: test.status,
    attempts: results.length,
    last_status: last.status,
    error,
    hint: hintFor(error?.message ?? ""),
    attachments: attachmentsOf(failed, frontendDir),
    stdout_tail: streamTail(failed.stdout),
    stderr_tail: streamTail(failed.stderr)
  };
}

export function parseResults(json, { frontendDir }) {
  const specs = [];
  for (const suite of json.suites ?? []) walk(suite, [], specs);
  const tests = [];
  const failures = [];
  for (const entry of specs) {
    for (const test of entry.spec.tests ?? []) {
      const item = { title: entry.titlePath.join(" › "), file: `e2e/${entry.spec.file}`, line: entry.spec.line, project: test.projectName, status: test.status, duration_ms: (test.results ?? []).reduce((sum, r) => sum + (r.duration ?? 0), 0) };
      tests.push(item);
      if (test.status === "unexpected" || test.status === "flaky") failures.push(failureEntry(entry, test, frontendDir));
    }
  }
  const stats = json.stats ?? {};
  return {
    stats: { expected: stats.expected ?? 0, unexpected: stats.unexpected ?? 0, flaky: stats.flaky ?? 0, skipped: stats.skipped ?? 0, duration_ms: Math.round(stats.duration ?? 0), start_time: stats.startTime ?? null, workers: json.config?.metadata?.actualWorkers ?? json.config?.workers ?? null, playwright_version: json.config?.version ?? null },
    tests,
    failures,
    run_errors: (json.errors ?? []).map((e) => stripAnsi(e.message ?? String(e)))
  };
}

export function verdictOf(parsed) {
  if (parsed.stats.unexpected > 0 || parsed.run_errors.length > 0) return "failed";
  if (parsed.stats.expected === 0 && parsed.stats.skipped === 0) return "failed";
  return "passed";
}
