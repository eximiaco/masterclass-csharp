import fs from "node:fs";
import path from "node:path";
import { commonRepoRoot, repoRoot, listWorktrees } from "./git.mjs";
import { ProfileError, readProfile, resolveWorkspaceConfig } from "./profile.mjs";
import { readWorkspace } from "./workspace-file.mjs";
import { block } from "./outcome.mjs";

const ProfilePath = ".harness/project-profile.yaml";
const isInside = (child, parent) => child === parent || child.startsWith(`${parent}${path.sep}`);
const real = (filename) => (fs.existsSync(filename) ? fs.realpathSync(filename) : path.resolve(filename));

function loadConfig(common) {
  try {
    return resolveWorkspaceConfig(readProfile(path.join(common, ProfilePath)), path.basename(common));
  } catch (error) {
    if (error instanceof ProfileError) block("profile", error.message);
    block("profile", `project profile ilegível: ${error.message}`);
  }
}

/**
 * Raiz comum, configuração e diretório base das frentes a partir de qualquer pasta
 * do repositório. O profile lido é o da pasta principal, para que todas as frentes
 * usem o mesmo diretório base. Uso: resolveContext({ repo: "/caminho" }).
 */
export function resolveContext(opts = {}) {
  const start = opts.repo ?? process.cwd();
  const toplevel = repoRoot(start);
  if (!toplevel) block("not-a-repo", `o caminho não é um repositório git: ${path.resolve(start)}`);
  const invocation = real(toplevel);
  const common = real(commonRepoRoot(invocation));
  const config = loadConfig(common);
  const base = path.resolve(common, config.worktree.path);
  if (isInside(base, common)) block("profile", `version_control.worktree.path deve ficar fora da pasta principal: ${base}`);
  return { invocation, common, config, base };
}

/** Frentes vivas, em ordem estável de id: worktrees dentro do diretório base que têm workspace.json. Uso: findFronts(ctx). */
export function findFronts(ctx) {
  const base = real(ctx.base);
  const fronts = listWorktrees(ctx.common).flatMap((entry) => {
    const workTree = real(entry.path);
    if (!isInside(workTree, base) || !fs.existsSync(workTree)) return [];
    const workspace = readWorkspace(workTree);
    return workspace ? [{ work_tree: workTree, branch: entry.branch, head: entry.head, workspace }] : [];
  });
  return fronts.sort((left, right) => left.workspace.workspace_id.localeCompare(right.workspace.workspace_id));
}

/**
 * Frente alvo: `--workspace <id>` ou a do diretório atual. Divergência entre os dois
 * é recusada para que uma operação nunca atinja a frente errada.
 * Uso: selectFront(ctx, opts) → frente | null.
 */
export function selectFront(ctx, opts = {}) {
  const fronts = findFronts(ctx);
  const here = fronts.find((front) => front.work_tree === ctx.invocation) ?? null;
  if (!opts.workspace) return here;
  const named = fronts.find((front) => front.workspace.workspace_id === opts.workspace);
  if (!named) block("workspace-not-found", `frente não encontrada: ${opts.workspace}`, { known: fronts.map((front) => front.workspace.workspace_id) });
  if (here && here !== named) {
    block("workspace-mismatch", `--workspace ${opts.workspace} difere da frente do diretório atual (${here.workspace.workspace_id})`);
  }
  return named;
}

/** Como selectFront, mas exige frente. Uso: requireFront(ctx, opts). */
export function requireFront(ctx, opts = {}) {
  const front = selectFront(ctx, opts);
  if (!front) block("workspace-required", "execute dentro do worktree da frente ou informe --workspace <id>");
  return front;
}
