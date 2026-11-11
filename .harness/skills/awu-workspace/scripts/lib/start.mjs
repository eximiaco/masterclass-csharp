import fs from "node:fs";
import path from "node:path";
import {
  tryGit,
  gitOk,
  currentBranch,
  headCommit,
  branchExists,
  remoteBranchExists,
  checkRefFormat,
  revParse,
  firstLine,
} from "./git.mjs";
import { block } from "./outcome.mjs";
import { nameWorkspace, IdPattern } from "./naming.mjs";
import { findFronts } from "./context.mjs";
import { fetchOrigin } from "./sync.mjs";
import { describeFront, packageIdTaken } from "./phase.mjs";
import { createPackage, readWorkspace, writeWorkspace, updateWorkspace, PackagesDir, WorkspaceFile } from "./workspace-file.mjs";

function parseOrigin(opts) {
  if (opts["work-item"] !== undefined) {
    if (!/^[0-9]+$/.test(opts["work-item"])) block("arguments", `--work-item deve ser numérico: ${opts["work-item"]}`);
    if (!opts["work-item-type"]) block("arguments", "--work-item exige --work-item-type lido do ALM");
    const item = { id: Number(opts["work-item"]), type: opts["work-item-type"], title: opts.title ?? null };
    return { kind: "work-item", work_item: item, description: opts.description ?? null };
  }
  if (!opts.description?.trim()) block("arguments", "informe --work-item <n> --work-item-type <tipo> ou --description <texto>");
  return { kind: "description", work_item: null, description: opts.description.trim() };
}

/**
 * A pasta principal só é atualizada quando está limpa; trabalho em andamento nela
 * nunca é tocado (stash é proibido). O worktree nasce de origin, não dela.
 */
export function refreshMainTree(ctx) {
  const dev = ctx.config.development_branch;
  const tracked = tryGit(["status", "--porcelain", "--untracked-files=no"], { cwd: ctx.common }).stdout.trim();
  if (tracked) return { action: "untouched", reason: "alterações não commitadas", branch: currentBranch(ctx.common) };
  if (currentBranch(ctx.common) !== dev && !gitOk(["checkout", dev], { cwd: ctx.common })) {
    return { action: "untouched", reason: `checkout de ${dev} falhou`, branch: currentBranch(ctx.common) };
  }
  const merged = tryGit(["merge", "--ff-only", `origin/${dev}`], { cwd: ctx.common });
  if (merged.code !== 0) return { action: "untouched", reason: `${dev} local divergiu de origin/${dev}`, branch: dev };
  return { action: "updated", branch: dev, head: headCommit(ctx.common) };
}

/** Sem isso, workspace.json apareceria como não rastreado e a frente nunca estaria limpa. */
function ensureWorkspaceIgnored(common) {
  if (gitOk(["check-ignore", "-q", "--", WorkspaceFile], { cwd: common })) return false;
  const gitDir = path.resolve(common, tryGit(["rev-parse", "--git-common-dir"], { cwd: common }).stdout.trim());
  const exclude = path.join(gitDir, "info", "exclude");
  fs.mkdirSync(path.dirname(exclude), { recursive: true });
  const current = fs.existsSync(exclude) ? fs.readFileSync(exclude, "utf8") : "";
  fs.writeFileSync(exclude, `${current}${current === "" || current.endsWith("\n") ? "" : "\n"}/.harness/workspace/\n`);
  return true;
}

function createWorktree(ctx, name) {
  const dev = ctx.config.development_branch;
  const target = path.join(ctx.base, name.workspaceId);
  if (!checkRefFormat(ctx.common, name.branch)) block("naming", `nome de branch inválido para o git: ${name.branch}`);
  if (branchExists(ctx.common, name.branch)) block("branch-exists", `a branch ${name.branch} já existe localmente`, { branch: name.branch });
  if (remoteBranchExists(ctx.common, name.branch)) block("remote-branch-exists", `a branch ${name.branch} já existe em origin`, { branch: name.branch });
  if (fs.existsSync(target)) block("path-occupied", `a pasta do worktree já existe: ${target}`);
  if (!revParse(ctx.common, `refs/remotes/origin/${dev}`)) block("base-missing", `origin/${dev} não existe; confira development_branch no profile`);
  fs.mkdirSync(ctx.base, { recursive: true });
  const added = tryGit(["worktree", "add", "--no-track", "-b", name.branch, target, `origin/${dev}`], { cwd: ctx.common });
  if (added.code !== 0) block("worktree-add", `git worktree add falhou: ${firstLine(added.stderr)}`);
  return fs.realpathSync(target);
}

function copyLocalFile(common, workTree, relative) {
  const source = path.join(common, relative);
  const target = path.join(workTree, relative);
  if (!fs.existsSync(source)) return "missing";
  if (!fs.lstatSync(source).isFile()) return "skipped";
  if (fs.existsSync(target)) return "skipped";
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(target, fs.statSync(source).mode);
  return "copied";
}

/** Copia byte a byte os arquivos locais declarados; nunca lê, imprime ou sobrescreve conteúdo. */
function applyBootstrap(ctx, workTree) {
  const result = { copied: [], missing: [], skipped: [] };
  for (const relative of ctx.config.worktree.bootstrap.copy) result[copyLocalFile(ctx.common, workTree, relative)].push(relative);
  return result;
}

function seedWorkspace(ctx, workTree, name, origin, opts) {
  const head = headCommit(workTree);
  const workspace = {
    schema_version: 1,
    workspace_id: name.workspaceId,
    origin,
    branch: name.branch,
    base_ref: `origin/${ctx.config.development_branch}`,
    base_sha: head,
    synced_base_sha: head,
    pushed_sha: null,
    pull_request: null,
    packages: [],
    created_at: new Date().toISOString(),
  };
  const reusable = !opts["no-package"] && !packageIdTaken(ctx.common, name.workspaceId);
  if (reusable) workspace.packages.push(createPackage(workTree, name.workspaceId, origin, origin.description));
  writeWorkspace(workTree, workspace);
  return { workspace, package_skipped: !opts["no-package"] && !reusable };
}

function describeStart(ctx, workTree, extra) {
  const front = findFronts(ctx).find((item) => item.work_tree === workTree);
  const { workspace_id, work_tree, branch, packages, next } = describeFront(ctx, front);
  return { workspace_id, work_tree, branch, base_sha: front.workspace.base_sha, packages, next, ...extra };
}

/**
 * Cria a frente: worktree a partir de origin, branch nomeada pelo profile e pasta do
 * primeiro pacote com o pedido inicial. Reexecutar devolve a mesma frente.
 * Uso: start(ctx, { "work-item": "5346", "work-item-type": "User Story", title: "…" }).
 */
export function start(ctx, opts) {
  const origin = parseOrigin(opts);
  const name = nameWorkspace(ctx.config.naming, origin);
  const existing = findFronts(ctx).find((front) => front.workspace.workspace_id === name.workspaceId);
  if (existing) return describeStart(ctx, existing.work_tree, { already_started: true });
  fetchOrigin(ctx.common);
  const mainTree = refreshMainTree(ctx);
  const ignoreAdded = ensureWorkspaceIgnored(ctx.common);
  const workTree = createWorktree(ctx, name);
  const bootstrap = applyBootstrap(ctx, workTree);
  const seeded = seedWorkspace(ctx, workTree, name, origin, opts);
  return describeStart(ctx, workTree, {
    main_tree: mainTree,
    bootstrap,
    ...(ignoreAdded ? { ignore_added: "/.harness/workspace/ em .git/info/exclude" } : {}),
    ...(seeded.package_skipped ? { package_skipped: `id ${name.workspaceId} já usado por execução anterior; usar package new --id ${name.workspaceId}-<sufixo>` } : {}),
  });
}

/**
 * Pacote adicional na mesma frente, somente a pedido. Id com prefixo da frente e
 * nunca reutilizado, porque o executor recusa identidade já arquivada.
 * Uso: newPackage(ctx, front, { id: "us-5346-review", description: "…" }).
 */
export function newPackage(ctx, front, opts) {
  const id = opts.id ?? "";
  const prefix = `${front.workspace.workspace_id}-`;
  const first = id === front.workspace.workspace_id && front.workspace.packages.length === 0;
  if (!IdPattern.test(id) || !(first || id.startsWith(prefix))) block("package-id", `--id deve ser ${prefix}<sufixo> em kebab-case; recebido: ${JSON.stringify(id)}`);
  if (front.workspace.packages.some((pkg) => pkg.id === id) || fs.existsSync(path.join(front.work_tree, PackagesDir, id))) {
    block("package-exists", `pacote já existe nesta frente: ${id}`);
  }
  if (packageIdTaken(ctx.common, id)) block("package-id-taken", `id já usado por execução viva ou arquivada: ${id}`);
  const created = createPackage(front.work_tree, id, front.workspace.origin, opts.description);
  updateWorkspace(front.work_tree, { packages: [...readWorkspace(front.work_tree).packages, created] });
  return describeStart(ctx, front.work_tree, { package_created: id });
}
