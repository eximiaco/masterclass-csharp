import fs from "node:fs";
import path from "node:path";
import { tryGit, mustGit, revParse, branchTip, listStatus, remoteInfo } from "./git.mjs";
import { block, capped } from "./outcome.mjs";
import { sha256 } from "./workspace-file.mjs";
import { activeExecutions } from "./phase.mjs";
import { gitFailure } from "./commit.mjs";
import { fetchOrigin } from "./sync.mjs";
import { refreshMainTree } from "./start.mjs";
import { pullRequestMerged } from "./pull-request.mjs";

const WorkspacePrefix = ".harness/workspace/";
const EvidenceDirs = [".harness/audits", ".harness/reports"];
const LifecycleBase = ".harness/workspace/test-lifecycle";
const RecordBase = ".harness/audits/workspaces";
const isEvidence = (relative) => EvidenceDirs.some((directory) => relative.startsWith(`${directory}/`));

/**
 * Squash merge não deixa os commits da branch na base, então ancestralidade não
 * prova nada. Se mesclar a branch em origin não altera a árvore de origin, todo o
 * conteúdo já está lá e nada se perde ao apagar a branch.
 */
function contentMerged(common, target, branch) {
  const merged = tryGit(["merge-tree", "--write-tree", target, branch], { cwd: common });
  if (merged.code !== 0) return false;
  return merged.stdout.split("\n", 1)[0].trim() === revParse(common, `${target}^{tree}`);
}

async function mergeProof(ctx, front, target, opts) {
  const branch = front.workspace.branch;
  if (contentMerged(ctx.common, target, branch)) return "content";
  const tip = branchTip(ctx.common, branch);
  const request = { provider: ctx.config.pr_provider, remoteUrl: remoteInfo(ctx.common).url, number: front.workspace.pull_request?.number, tip };
  if (tip === front.workspace.pushed_sha && (await pullRequestMerged(request))) return "pull-request";
  return opts.confirm && opts.confirm === tip ? "confirmed" : null;
}

function activeLifecycles(common, workTree) {
  const base = path.join(common, LifecycleBase);
  if (!fs.existsSync(base)) return [];
  return fs
    .readdirSync(base)
    .map((id) => path.join(base, id, "temporary-tests.json"))
    .filter((filename) => fs.existsSync(filename))
    .map((filename) => JSON.parse(fs.readFileSync(filename, "utf8")))
    .filter((registry) => registry.root === workTree && registry.status !== "closed")
    .map((registry) => ({ execution_id: registry.execution_id, status: registry.status }));
}

function localEvidence(workTree) {
  const listed = mustGit(["ls-files", "--others", "-z", "--", ...EvidenceDirs], { cwd: workTree });
  return listed.split("\0").filter(Boolean);
}

/** Destino igual é reaproveitado; destino diferente bloqueia, porque sobrescrever perderia prova. */
function evidencePlan(common, workTree) {
  return localEvidence(workTree).map((relative) => {
    const target = path.join(common, relative);
    if (!fs.existsSync(target)) return { relative, action: "move" };
    const same = sha256(fs.readFileSync(target)) === sha256(fs.readFileSync(path.join(workTree, relative)));
    return { relative, action: same ? "drop" : "conflict" };
  });
}

function unmergedCommits(common, target, branch) {
  return mustGit(["log", "--oneline", "--max-count=50", `${target}..${branch}`], { cwd: common }).split("\n").filter(Boolean);
}

async function assess(ctx, front, opts) {
  const { common } = ctx;
  const target = `origin/${ctx.config.development_branch}`;
  const branch = front.workspace.branch;
  const plan = evidencePlan(common, front.work_tree);
  const dirty = listStatus(front.work_tree).map((entry) => entry.path).filter((file) => !file.startsWith(WorkspacePrefix) && !isEvidence(file));
  const proof = await mergeProof(ctx, front, target, opts);
  const blockers = [];
  if (!proof) {
    blockers.push({ kind: "not-merged", unmerged_commits: capped(unmergedCommits(common, target, branch)), confirm_with: branchTip(common, branch) });
  }
  if (dirty.length) blockers.push({ kind: "dirty-tree", files: capped(dirty) });
  // Estado operacional ainda presente, mesmo concluído, depende do worktree até a retirada pelo executor.
  const executions = activeExecutions(common, front.work_tree);
  if (executions.length) blockers.push({ kind: "active-execution", executions });
  const lifecycles = activeLifecycles(common, front.work_tree);
  if (lifecycles.length) blockers.push({ kind: "active-lifecycle", lifecycles });
  const conflicts = plan.filter((item) => item.action === "conflict").map((item) => item.relative);
  if (conflicts.length) blockers.push({ kind: "evidence-conflict", files: capped(conflicts) });
  return { proof, plan, blockers };
}

function migrateEvidence(common, workTree, plan) {
  for (const item of plan) {
    const source = path.join(workTree, item.relative);
    if (item.action === "move") {
      const target = path.join(common, item.relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
    }
    fs.unlinkSync(source);
  }
  return plan.filter((item) => item.action === "move").length;
}

function recordFinalFacts(common, front, facts) {
  const name = `${front.workspace.workspace_id}-${facts.tip.slice(0, 12)}.json`;
  const filename = path.join(common, RecordBase, name);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, `${JSON.stringify({ schema_version: 1, workspace: front.workspace, ...facts }, null, 2)}\n`);
  return `${RecordBase}/${name}`;
}

function removeFront(ctx, front) {
  const removed = tryGit(["worktree", "remove", front.work_tree], { cwd: ctx.common });
  if (removed.code !== 0) block("worktree-remove", `git worktree remove falhou: ${gitFailure(removed)}`);
  mustGit(["branch", "-D", front.workspace.branch], { cwd: ctx.common });
  tryGit(["fetch", "--prune", "origin"], { cwd: ctx.common });
}

/**
 * Remove a frente depois do merge: worktree e branch local. Só age com o conteúdo
 * comprovadamente na base (ou confirmação explícita do tip), árvore limpa e nenhuma
 * execução ou lifecycle ativo; evidências locais vão antes para a pasta principal.
 * Uso: await cleanup(ctx, front, { "dry-run": true }).
 */
export async function cleanup(ctx, front, opts = {}) {
  const here = fs.realpathSync(process.cwd());
  if (here === front.work_tree || here.startsWith(`${front.work_tree}${path.sep}`)) {
    block("inside-worktree", "executar a limpeza a partir da pasta principal: o worktree atual será removido");
  }
  fetchOrigin(ctx.common);
  const { proof, plan, blockers } = await assess(ctx, front, opts);
  const summary = { workspace_id: front.workspace.workspace_id, work_tree: front.work_tree, branch: front.workspace.branch, proof };
  if (opts["dry-run"]) return { ...summary, dry_run: true, removable: blockers.length === 0, blockers, evidence_to_move: plan.length };
  if (blockers.length) block("cleanup-blocked", "a frente não pode ser removida com segurança", { ...summary, blockers });
  const tip = branchTip(ctx.common, front.workspace.branch);
  const moved = migrateEvidence(ctx.common, front.work_tree, plan);
  const record = recordFinalFacts(ctx.common, front, { tip, proof, evidence_moved: moved, cleaned_at: new Date().toISOString() });
  removeFront(ctx, front);
  return { ...summary, removed: true, evidence_moved: moved, record, main_tree: refreshMainTree(ctx) };
}
