/** Coordena estado local, sem executar comandos do pacote. Uso: node package-state.mjs begin --manifest <path> [--repo <worktree>]. */
import fs from "node:fs";
import path from "node:path";
import { commonRepoRoot, repoRoot, currentBranch, headCommit, listStatus } from "../../awu-workspace/scripts/lib/git.mjs";
import { loadPackage, StateBase, validateState, eligible } from "./lib/package.mjs";
import { hash, fail, json, readJson, safe, exists, write, locked } from "./lib/storage.mjs";
import { reconcile } from "./lib/evidence.mjs";
import { record } from "./lib/events.mjs";
import { close, verifyPackage } from "./lib/close.mjs";
import { archivePath, archivedResult, retire } from "./lib/retention.mjs";
import { refine } from "./lib/refine.mjs";

function options(argv) {
  const [operation, ...args] = argv;
  if (!["begin", "status", "next", "record", "resume", "refine", "close", "retire"].includes(operation))
    fail(`Operação desconhecida: ${operation}`);
  const parsed = { operation };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    const flags = ["--manifest", "--state", "--event", "--full", "--resume-paused", "--reason", "--repo", "--authorization", "--invalidate"];
    if (!flags.includes(flag)) fail(`Opção desconhecida: ${flag}`);
    const key = flag.slice(2);
    if (Object.hasOwn(parsed, key)) fail(`Opção repetida: ${flag}`);
    parsed[key] = ["full", "resume-paused"].includes(key) ? true : args[++index];
    if (!parsed[key] || String(parsed[key]).startsWith("--")) fail(`Falta valor: ${flag}`);
  }
  return parsed;
}

function relativePath(root, filename) {
  if (typeof filename !== "string" || filename.split(/[\\/]/).includes("..")) fail(`Path inválido: ${filename}`);
  const relative = path.isAbsolute(filename) ? path.relative(root, filename) : filename.replace(/^\.\//, "");
  safe(root, relative);
  return relative;
}

function retirementEvent(root, relative, opts) {
  if (!opts.event || exists(safe(root, archivePath(relative)))) return null;
  return readJson(root, relativePath(root, opts.event));
}

function begin(root, worktree, opts) {
  const manifestPath = relativePath(worktree, opts.manifest);
  const pkg = loadPackage(worktree, manifestPath);
  const branch = currentBranch(worktree);
  if (!branch) fail("HEAD destacado");
  const executionId = hash(`${worktree}\n${branch}`).slice(0, 20);
  const relative = `${StateBase}/${pkg.manifest.id}/${executionId}/state.json`;
  return locked(root, relative, () => beginLocked(root, worktree, branch, relative, manifestPath, pkg));
}

function beginLocked(root, worktree, branch, relative, manifestPath, pkg) {
  if (exists(safe(root, archivePath(relative)))) fail("Execução já arquivada; reconciliar histórico antes de reutilizar identidade");
  if (exists(safe(root, relative))) {
    const state = readJson(root, relative);
    validateState(state, relative);
    if (state.worktree !== worktree) fail("Execução existente incompatível; reconciliar sem duplicar");
    if (JSON.stringify(state.files) !== JSON.stringify(pkg.files))
      fail("Pacote mudou desde o begin; registrar refinamento com refine --reason --authorization");
    reconcile(state);
    verifyPackage(state);
    return { state, relative };
  }
  const state = {
    schema_version: 1,
    package_id: pkg.manifest.id,
    execution_id: relative.split("/").at(-2),
    root,
    worktree,
    branch,
    manifest_path: manifestPath,
    manifest: pkg.manifest,
    directory: pkg.directory,
    files: pkg.files,
    baseline: { head: headCommit(worktree), status: listStatus(worktree) },
    status: "planned",
    checkpoints: {},
    units: Object.fromEntries(
      pkg.manifest.units.map((unit) => [
        unit.id,
        {
          status: "pending",
          work_type: unit.work_type,
          spec: unit.spec,
          dependencies: unit.depends_on.map((dep) => (typeof dep === "string" ? dep : dep.id)),
        },
      ]),
    ),
    obligations: { learning: null, delivery: null },
    lifecycles: [],
    created_at: new Date().toISOString(),
  };
  write(root, relative, state);
  return { state, relative };
}

function resume(state, opts) {
  if (state.status === "completed") return;
  if (state.status === "paused" && (!opts["resume-paused"] || !opts.reason?.trim()))
    fail("Pausa exige pedido explícito: --resume-paused --reason");
  if (state.status === "blocked" && !opts.reason?.trim()) fail("Bloqueio exige causa reconciliada em --reason");
  for (const unit of Object.values(state.units)) {
    if (unit.status !== "running") continue;
    unit.status = "blocked";
    unit.interrupted = "Tentativa interrompida: conferir efeitos; revalidar antes de concluir";
    delete unit.validation;
  }
  if (state.status !== "finalizing") state.status = "running";
  delete state.reason;
}

function operate(root, worktree, relative, opts) {
  const state = readJson(root, relative);
  validateState(state, relative);
  if (state.root !== root || state.worktree !== worktree || state.branch !== currentBranch(worktree))
    fail("Identidade de repo/branch/worktree divergente");
  try {
    reconcile(state);
    if (opts.operation === "refine") {
      // Pacote divergente é o pré-requisito do refine; conferência volta a valer após aplicar.
      refine(state, opts);
      verifyPackage(state);
      write(root, relative, state);
      return { state, relative };
    }
    verifyPackage(state);
    if (opts.operation === "resume") resume(state, opts);
    if (opts.operation === "record") record(state, readJson(root, relativePath(root, opts.event)));
    if (opts.operation === "close") {
      const eventPath = opts.event ? relativePath(root, opts.event) : null;
      close(state, relative, eventPath ? readJson(root, eventPath) : null, eventPath);
    }
    if (["resume", "record"].includes(opts.operation)) write(root, relative, state);
    return { state, relative };
  } catch (error) {
    if (!["status", "next"].includes(opts.operation) && !["paused", "completed"].includes(state.status)) {
      state.status = "blocked";
      state.reason = error.message;
      write(root, relative, state);
    }
    throw error;
  }
}

function summary(state, relative) {
  const pending = Object.entries(state.units).filter(([, unit]) => unit.status !== "completed");
  return {
    package_id: state.package_id,
    execution_id: state.execution_id,
    state: relative,
    status: state.status === "completed" && !state.operational_retirement ? "finalizing" : state.status,
    reason: state.reason ?? null,
    units: Object.fromEntries(Object.entries(state.units).map(([id, unit]) => [id, unit.status])),
    eligible: ["planned", "running"].includes(state.status)
      ? pending.filter(([id, unit]) => ["pending", "blocked"].includes(unit.status) && eligible(state, id)).map(([id]) => id)
      : [],
    obligations: {
      checkpoints: state.manifest.commit_checkpoints.filter((cp) => !state.checkpoints[cp.id]).map((cp) => cp.id),
      learning: !state.obligations.learning,
      delivery: !state.obligations.delivery,
      interrupted: pending.filter(([, unit]) => unit.interrupted).map(([id, unit]) => ({ unit_id: id, reason: unit.interrupted })),
      cleanup: state.status !== "completed" || !state.operational_retirement,
    },
    detail_command: `status --state ${relative} --full`,
    receipt: state.receipt ?? null,
    archive: state.operational_retirement?.archive ?? null,
  };
}

try {
  const opts = options(process.argv.slice(2));
  // --repo aponta o worktree da frente quando o processo roda em outro diretório.
  const worktree = fs.realpathSync(repoRoot(opts.repo ?? process.cwd()) ?? fail("Não é repositório Git"));
  const root = fs.realpathSync(commonRepoRoot(worktree));
  const relative = opts.operation === "begin" ? null : relativePath(root, opts.state);
  const execute = () => operate(root, worktree, relative, opts);
  const historical = relative && opts.operation !== "retire" ? archivedResult(root, relative, opts.operation) : null;
  let result =
    historical ??
    (opts.operation === "begin"
      ? begin(root, worktree, opts)
      : opts.operation === "retire"
        ? retire(root, relative, retirementEvent(root, relative, opts), opts.event ? relativePath(root, opts.event) : null)
        : ["status", "next"].includes(opts.operation)
          ? execute()
          : locked(root, relative, execute));
  if (opts.operation === "close") {
    if (historical) verifyPackage(historical.state);
    else result = retire(root, relative, result.state.closure?.retirement, opts.event ? relativePath(root, opts.event) : null);
  }
  process.stdout.write(json({ status: "ok", result: opts.full ? result.state : summary(result.state, result.relative) }));
} catch (error) {
  process.stdout.write(json({ status: "blocked", message: error.message }));
  process.exitCode = 1;
}
