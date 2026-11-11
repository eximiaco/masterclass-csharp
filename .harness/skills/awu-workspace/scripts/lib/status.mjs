import { tryGit, aheadCount, currentBranch } from "./git.mjs";
import { findFronts, selectFront } from "./context.mjs";
import { describeFront } from "./phase.mjs";

/**
 * Vazamento para fora dos worktrees: edição na pasta principal ou commit direto na
 * branch de desenvolvimento local. Só aparece na saída quando existe.
 */
function mainTreeAlerts(ctx) {
  const dev = ctx.config.development_branch;
  const changed = tryGit(["status", "--porcelain"], { cwd: ctx.common }).stdout.split("\n").filter(Boolean).length;
  const ahead = aheadCount(ctx.common, `origin/${dev}`, dev) ?? 0;
  if (!changed && !ahead) return {};
  return { main_tree: { branch: currentBranch(ctx.common), changed_files: changed, commits_ahead_of_origin: ahead } };
}

function baseAlert(ctx, front) {
  const behind = aheadCount(front.work_tree, front.workspace.synced_base_sha, `origin/${ctx.config.development_branch}`);
  return behind ? { base_behind: behind } : {};
}

function row(front) {
  return {
    workspace_id: front.workspace_id,
    branch: front.branch,
    phase: front.phase,
    packages: front.packages.map((pkg) => ({ id: pkg.id, phase: pkg.phase, ...(pkg.execution ? { execution: pkg.execution.status } : {}) })),
    next: front.next,
    pull_request: front.pull_request?.url ?? front.pull_request?.mode ?? null,
    work_tree: front.work_tree,
  };
}

/**
 * Frente do diretório atual (ou `--workspace`); fora de uma frente ou com `--all`,
 * uma linha por frente. Uso: status(ctx, { all: true }).
 */
export function status(ctx, opts) {
  const front = opts.all ? null : selectFront(ctx, opts);
  const shared = { common_root: ctx.common, ...mainTreeAlerts(ctx) };
  if (front) return { ...describeFront(ctx, front), origin: front.workspace.origin, ...baseAlert(ctx, front), ...shared };
  return { fronts: findFronts(ctx).map((item) => row(describeFront(ctx, item))), ...shared };
}
