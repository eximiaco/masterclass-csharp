import { tryGit, mustGit, gitOk, headCommit, revParse, diffNames, mergeInProgress } from "./git.mjs";
import { block, capped } from "./outcome.mjs";
import { updateWorkspace } from "./workspace-file.mjs";
import { assertFrontBranch, gitFailure } from "./commit.mjs";

const unmerged = (cwd) => mustGit(["diff", "--name-only", "--diff-filter=U"], { cwd }).split("\n").filter(Boolean);

/** Atualiza as referências de origin; falha de rede bloqueia em vez de decidir com dado velho. */
export function fetchOrigin(cwd) {
  const fetched = tryGit(["fetch", "origin"], { cwd });
  if (fetched.code !== 0) block("fetch", `git fetch origin falhou: ${gitFailure(fetched)}`);
}

function settle(front, tip, outcome) {
  if (front.workspace.synced_base_sha !== tip) updateWorkspace(front.work_tree, { synced_base_sha: tip });
  return { ...outcome, synced_base_sha: tip, head: headCommit(front.work_tree) };
}

function conclude(front) {
  const cwd = front.work_tree;
  if (!mergeInProgress(cwd)) block("merge-not-open", "não há merge aberto para concluir");
  const pending = unmerged(cwd);
  if (pending.length) block("sync-conflict", "ainda há arquivos em conflito", { conflicts: capped(pending), merge_open: true });
  const markers = tryGit(["diff", "--cached", "--check"], { cwd }).stdout.split("\n").filter((line) => line.includes("conflict marker"));
  if (markers.length) block("sync-conflict", "há marcadores de conflito em arquivos resolvidos", { conflicts: capped(markers), merge_open: true });
  const tip = revParse(cwd, "MERGE_HEAD");
  const committed = tryGit(["commit", "--no-edit"], { cwd });
  if (committed.code !== 0) block("merge", `conclusão do merge falhou: ${gitFailure(committed)}`);
  return settle(front, tip, { changed: true, concluded: true });
}

function failMerge(cwd, merged, target, keep) {
  const conflicts = unmerged(cwd);
  if (!conflicts.length) block("merge", `merge de ${target} falhou: ${gitFailure(merged)}`);
  if (!keep) mustGit(["merge", "--abort"], { cwd });
  const message = keep
    ? `merge de ${target} aberto com conflitos; resolver, adicionar os arquivos e usar sync --conclude`
    : `conflito ao mesclar ${target}; merge abortado e árvore restaurada`;
  block("sync-conflict", message, { conflicts: capped(conflicts), merge_open: Boolean(keep) });
}

/**
 * Traz a branch de desenvolvimento de origin para a frente por merge, sem stash nem
 * rebase. Sem novidade não faz merge, e o chamador não precisa revalidar nada.
 * Uso: sync(ctx, front, {}) → { changed, files?, synced_base_sha, head }.
 */
export function sync(ctx, front, opts = {}) {
  assertFrontBranch(ctx, front);
  if (opts.conclude) return conclude(front);
  const cwd = front.work_tree;
  const target = `origin/${ctx.config.development_branch}`;
  if (mergeInProgress(cwd)) block("merge-open", "há um merge aberto; resolver os conflitos e usar sync --conclude");
  fetchOrigin(cwd);
  const tip = revParse(cwd, `refs/remotes/${target}`);
  if (!tip) block("base-missing", `${target} não existe`);
  if (gitOk(["merge-base", "--is-ancestor", tip, "HEAD"], { cwd })) return settle(front, tip, { changed: false });
  const dirty = tryGit(["status", "--porcelain", "--untracked-files=no"], { cwd }).stdout.trim();
  if (dirty) block("dirty-tree", "há alterações não commitadas; commitar antes de sincronizar", { files: capped(dirty.split("\n")) });
  const before = headCommit(cwd);
  const merged = tryGit(["merge", "--no-edit", target], { cwd });
  if (merged.code !== 0) failMerge(cwd, merged, target, opts["keep-conflict"]);
  return settle(front, tip, { changed: true, files: capped(diffNames(cwd, `${before}..HEAD`)) });
}
