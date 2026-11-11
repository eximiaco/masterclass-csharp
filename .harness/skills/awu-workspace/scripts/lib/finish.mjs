import fs from "node:fs";
import { tryGit, mustGit, headCommit, revParse, diffNames, mergeInProgress, listStatus, aheadCount, remoteInfo } from "./git.mjs";
import { block, capped } from "./outcome.mjs";
import { updateWorkspace } from "./workspace-file.mjs";
import { packagePhase } from "./phase.mjs";
import { assertFrontBranch, gitFailure } from "./commit.mjs";
import { fetchOrigin } from "./sync.mjs";
import { ensurePullRequest } from "./pull-request.mjs";

const WorkspacePrefix = ".harness/workspace/";

function assertDeliverable(ctx, front) {
  const cwd = front.work_tree;
  const dirty = listStatus(cwd).filter((entry) => !entry.path.startsWith(WorkspacePrefix));
  if (dirty.length) block("dirty-tree", "há alterações não commitadas; a entrega só faz push e PR", { files: capped(dirty.map((entry) => entry.path)) });
  if (mergeInProgress(cwd)) block("merge-open", "há um merge aberto; concluir com sync --conclude antes de entregar");
  const pending = front.workspace.packages.map((pkg) => packagePhase(ctx.common, cwd, pkg)).filter((pkg) => pkg.phase === "executing");
  if (pending.length) {
    block("package-pending", "pacote em execução com gates pendentes; concluir no executor antes de entregar", {
      packages: pending.map((pkg) => ({ id: pkg.id, execution: pkg.execution.status })),
    });
  }
}

/**
 * O que foi validado é a branch mesclada com a base da última sincronização. Se a
 * base de origin avançou em arquivos que a branch também alterou, o push publicaria
 * uma combinação não testada; arquivos disjuntos seguem e o build do PR cobre o merge.
 */
function assertBaseCompatible(front, target) {
  const cwd = front.work_tree;
  const synced = front.workspace.synced_base_sha;
  const tip = revParse(cwd, `refs/remotes/${target}`);
  if (synced === tip) return;
  const own = new Set(diffNames(cwd, `${target}...HEAD`));
  const overlap = diffNames(cwd, `${synced}..${tip}`).filter((file) => own.has(file));
  if (overlap.length) {
    block("base-moved", `${target} alterou arquivos desta branch depois da última sincronização; executar sync e revalidar`, {
      overlap: capped(overlap),
    });
  }
}

function publish(cwd, branch, head) {
  if (revParse(cwd, `refs/remotes/origin/${branch}`) === head) return false;
  const pushed = tryGit(["push", "-u", "origin", branch], { cwd });
  if (pushed.code !== 0) block("push", `git push falhou: ${gitFailure(pushed)}`);
  return true;
}

function originLabel(origin) {
  if (origin.kind !== "work-item") return origin.description.split("\n", 1)[0];
  const item = origin.work_item;
  return `${item.type} ${item.id}${item.title ? `: ${item.title}` : ""}`;
}

function pullRequestBody(front, target, opts) {
  if (opts["pr-body-file"]) return fs.readFileSync(opts["pr-body-file"], "utf8");
  const commits = mustGit(["log", "--no-merges", "--max-count=30", "--format=- %s", `${target}..HEAD`], { cwd: front.work_tree }).trim();
  return [originLabel(front.workspace.origin), "", "Commits:", commits, ...(opts["pr-footer"] ? ["", opts["pr-footer"]] : [])].join("\n");
}

function pullRequestRequest(ctx, front, target, opts) {
  return {
    provider: ctx.config.pr_provider,
    remoteUrl: remoteInfo(front.work_tree).url,
    source: front.workspace.branch,
    target: ctx.config.development_branch,
    title: opts["pr-title"] ?? originLabel(front.workspace.origin).slice(0, 200),
    body: pullRequestBody(front, target, opts),
  };
}

/**
 * Entrega da frente: push da branch e pull request. Não commita, não força push e não
 * remove o worktree, que segue disponível para ajustes de review até o merge.
 * Reexecutar após novos commits republica no mesmo PR.
 * Uso: await finish(ctx, front, { "pr-title": "…" }).
 */
export async function finish(ctx, front, opts = {}) {
  assertFrontBranch(ctx, front);
  assertDeliverable(ctx, front);
  const cwd = front.work_tree;
  const target = `origin/${ctx.config.development_branch}`;
  fetchOrigin(cwd);
  if (!aheadCount(cwd, target, "HEAD")) block("nothing-to-deliver", `a branch não tem commits além de ${target}`);
  assertBaseCompatible(front, target);
  const head = headCommit(cwd);
  const pushed = publish(cwd, front.workspace.branch, head);
  const pullRequest = await ensurePullRequest(pullRequestRequest(ctx, front, target, opts));
  updateWorkspace(cwd, { pushed_sha: head, pull_request: pullRequest });
  return { workspace_id: front.workspace.workspace_id, branch: front.workspace.branch, pushed_sha: head, pushed, pull_request: pullRequest };
}
