import fs from "node:fs";
import path from "node:path";
import { parseSimpleYaml } from "./profile.mjs";
import { packageDir, requestPath, sha256, RequestName } from "./workspace-file.mjs";

// Contrato de dados do executor (schema 1): lido como fato, sem importar código dele.
const StateBase = ".harness/workspace/package-executions";
const ArchiveBase = ".harness/audits/package-executions";

function executionFiles(common, base, name, packageId) {
  const directory = path.join(common, base, packageId);
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory)
    .map((execution) => `${base}/${packageId}/${execution}/${name}`)
    .filter((relative) => fs.existsSync(path.join(common, relative)));
}

const readJson = (common, relative) => JSON.parse(fs.readFileSync(path.join(common, relative), "utf8"));

/** Id de pacote já usado por execução viva ou arquivada; o executor recusa reutilização. Uso: packageIdTaken(common, id). */
export function packageIdTaken(common, packageId) {
  return [StateBase, ArchiveBase].some((base) => fs.existsSync(path.join(common, base, packageId)));
}

/** Execuções não encerradas de um worktree, de qualquer pacote. Uso: activeExecutions(common, workTree). */
export function activeExecutions(common, workTree) {
  const base = path.join(common, StateBase);
  if (!fs.existsSync(base)) return [];
  return fs
    .readdirSync(base)
    .flatMap((packageId) => executionFiles(common, StateBase, "state.json", packageId))
    .map((relative) => ({ relative, state: readJson(common, relative) }))
    .filter(({ state }) => state.worktree === workTree)
    .map(({ relative, state }) => ({ package_id: state.package_id, status: state.status, state: relative }));
}

function liveExecution(state, relative) {
  const units = Object.values(state.units ?? {});
  const done = units.filter((unit) => unit.status === "completed").length;
  const stopped = ["blocked", "paused"].includes(state.status);
  const awaitsDelivery =
    done === units.length && !stopped && !state.obligations?.delivery && state.manifest?.commit_policy?.required_delivery === "published";
  return {
    phase: awaitsDelivery ? "awaiting-delivery" : "executing",
    execution: {
      status: state.status === "completed" ? "finalizing" : state.status,
      reason: state.reason ?? null,
      units: `${done}/${units.length}`,
      state: relative,
    },
  };
}

function executionPhase(common, workTree, packageId) {
  for (const relative of executionFiles(common, StateBase, "state.json", packageId)) {
    const state = readJson(common, relative);
    if (state.worktree === workTree) return liveExecution(state, relative);
  }
  const closed = executionFiles(common, ArchiveBase, "execution.json", packageId).some(
    (relative) => readJson(common, relative).state?.worktree === workTree,
  );
  return closed ? { phase: "closed" } : null;
}

function parseYamlFile(filename) {
  if (!fs.existsSync(filename)) return null;
  try {
    return parseSimpleYaml(fs.readFileSync(filename, "utf8"));
  } catch {
    return null;
  }
}

function requestGap(manifest, requestHash) {
  const declared = (manifest.package_inputs ?? []).find((input) => input?.path?.replace(/^\.\//, "") === RequestName);
  if (!declared) return "request.md não declarado em package_inputs";
  return declared.sha256 === requestHash ? null : "request.md mudou depois da compilação";
}

/**
 * O que falta para o pacote estar compilado; `null` quando a estrutura está completa.
 * Conferência estrutural para roteamento: a validação integral é do `begin` do executor.
 */
function compilationGap(workTree, packageId, requestHash) {
  const directory = packageDir(workTree, packageId);
  const manifest = parseYamlFile(path.join(directory, "execution-manifest.yaml"));
  if (!manifest) return "execution-manifest.yaml ilegível pelo parser do harness";
  if (manifest.id !== packageId) return `id do manifesto (${manifest.id}) difere da pasta do pacote`;
  const request = requestHash ? requestGap(manifest, requestHash) : null;
  if (request) return request;
  const strategy = parseYamlFile(path.join(directory, "test-strategy.yaml"));
  if (!["ready", "not-applicable"].includes(strategy?.status)) return "test-strategy.yaml ausente ou não pronta";
  return fs.existsSync(path.join(directory, "review-manifest.md")) ? null : "review-manifest.md ausente";
}

function compilationPhase(workTree, pkg) {
  const request = requestPath(workTree, pkg.id);
  const requestHash = fs.existsSync(request) ? sha256(fs.readFileSync(request)) : null;
  const facts = requestHash ? { request_sha256: requestHash } : {};
  if (!fs.existsSync(path.join(packageDir(workTree, pkg.id), "execution-manifest.yaml"))) {
    if (!requestHash) return { phase: "empty" };
    return { phase: requestHash === pkg.seed_sha256 ? "seeded" : "requested", ...facts };
  }
  const gap = compilationGap(workTree, pkg.id, requestHash);
  return gap ? { phase: "compiling", reason: gap, ...facts } : { phase: "compiled", ...facts };
}

/** Fase do pacote derivada de fatos: execução (viva ou arquivada) prevalece sobre compilação. */
export function packagePhase(common, workTree, pkg) {
  return { id: pkg.id, ...(executionPhase(common, workTree, pkg.id) ?? compilationPhase(workTree, pkg)) };
}

function frontPhase(front, packages) {
  const pushed = front.workspace.pushed_sha;
  if (pushed) return pushed === front.head ? "delivered" : "unpublished";
  return packages.length ? "active" : "manual";
}

function packageNext(front, pkg) {
  const fromWorkItem = front.workspace.origin?.kind === "work-item";
  const steps = {
    empty: { skill: "awu-workspace", action: "registrar o pedido em request.md" },
    seeded: { skill: fromWorkItem ? "awu-from-user-story" : "awu-compiler" },
    requested: { skill: "awu-compiler" },
    compiling: { skill: "awu-compiler", action: "refinar" },
    compiled: { skill: "awu-package-executor", explicit_request: true },
    executing: { skill: "awu-package-executor", action: "retomar" },
    "awaiting-delivery": { skill: "awu-workspace", action: "finish", explicit_request: true },
  };
  return { ...steps[pkg.phase], package: pkg.id };
}

function nextStep(front, packages, phase) {
  const open = packages.find((pkg) => pkg.phase !== "closed");
  if (open) return packageNext(front, open);
  if (phase === "delivered") return { skill: "awu-workspace", action: "cleanup", explicit_request: true };
  return { skill: "awu-workspace", action: "finish", explicit_request: true };
}

/**
 * Estado da frente e de seus pacotes, sempre recalculado: nenhuma skill declara fase.
 * Uso: describeFront(ctx, front) → { workspace_id, phase, packages, next, ... }.
 */
export function describeFront(ctx, front) {
  const packages = front.workspace.packages.map((pkg) => packagePhase(ctx.common, front.work_tree, pkg));
  const phase = frontPhase(front, packages);
  return {
    workspace_id: front.workspace.workspace_id,
    work_tree: front.work_tree,
    branch: front.branch,
    phase,
    head: front.head,
    pushed_sha: front.workspace.pushed_sha,
    pull_request: front.workspace.pull_request,
    packages,
    next: nextStep(front, packages, phase),
  };
}
