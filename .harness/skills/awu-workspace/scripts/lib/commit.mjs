import fs from "node:fs";
import path from "node:path";
import { mustGit, tryGit, currentBranch, headCommit, listStatus, firstLine } from "./git.mjs";
import { block, capped } from "./outcome.mjs";

const ConventionalHeader = /^(feat|fix|perf|refactor|docs|test|build|ci|chore|revert)(\([^)]+\))?!?: .+$/;
const WorkspacePrefix = ".harness/workspace/";

/** Linha mais informativa de uma falha do git. Uso: gitFailure(tryGit([...])). */
export function gitFailure(result) {
  const lines = `${result.stderr}\n${result.stdout}`.split("\n").map((line) => line.trim()).filter(Boolean);
  return lines.find((line) => /fatal|error|rejected|conflict/i.test(line)) ?? firstLine(result.stderr) ?? `exit ${result.code}`;
}

/** Toda operação que altera a frente exige a branch dela em checkout, nunca a de desenvolvimento. */
export function assertFrontBranch(ctx, front) {
  const branch = currentBranch(front.work_tree);
  if (branch !== front.workspace.branch || branch === ctx.config.development_branch) {
    block("branch", `o worktree deve estar na branch da frente (${front.workspace.branch}); atual: ${branch ?? "HEAD destacado"}`);
  }
}

function readMessage(opts) {
  if (opts.message && opts["message-file"]) block("arguments", "--message e --message-file são excludentes");
  const message = opts["message-file"] ? fs.readFileSync(opts["message-file"], "utf8") : opts.message;
  if (!message?.trim()) block("commit-message", "mensagem de commit obrigatória: --message ou --message-file");
  return message.trim();
}

function validateMessage(message, commits) {
  const header = message.split("\n", 1)[0];
  if (commits.style === "conventional" && !ConventionalHeader.test(header)) {
    block("commit-message", `cabeçalho fora de Conventional Commits (<tipo>(<escopo>): descrição): ${JSON.stringify(header)}`);
  }
  if (Number.isInteger(commits.header_max_length) && header.length > commits.header_max_length) {
    block("commit-message", `cabeçalho com ${header.length} caracteres excede header_max_length=${commits.header_max_length}`);
  }
}

function selectPaths(workTree, requested) {
  if (!requested?.length) block("arguments", "--paths exige ao menos um caminho exato alterado");
  const changed = new Set(listStatus(workTree).map((entry) => entry.path));
  for (const item of requested) {
    if (path.isAbsolute(item) || item.split("/").includes("..") || item.startsWith(WorkspacePrefix)) {
      block("commit-path", `caminho não permitido para commit: ${item}`);
    }
    if (!changed.has(item)) block("commit-path", `caminho sem alteração no worktree: ${item}`, { changed: capped([...changed].sort()) });
  }
  return [...new Set(requested)];
}

/**
 * Commit local com paths exatos na branch da frente. Não faz pull, stash nem push,
 * nunca usa staging amplo e preserva o que já estava em staging para outros paths.
 * Devolve os fatos que a evidência de checkpoint do executor exige.
 * Uso: commit(ctx, front, { message: "feat(x): y", paths: ["src/a.mjs"] }).
 */
export function commit(ctx, front, opts) {
  assertFrontBranch(ctx, front);
  const message = readMessage(opts);
  validateMessage(message, ctx.config.commits);
  const cwd = front.work_tree;
  const paths = selectPaths(cwd, opts.paths);
  const parent = headCommit(cwd);
  mustGit(["--literal-pathspecs", "add", "-A", "--", ...paths], { cwd });
  const committed = tryGit(["--literal-pathspecs", "commit", "--only", "-m", message, "--", ...paths], { cwd });
  if (committed.code !== 0) block("commit", `git commit falhou: ${gitFailure(committed)}`);
  const sha = headCommit(cwd);
  const changed = mustGit(["diff-tree", "--no-commit-id", "--name-only", "-r", sha], { cwd }).split("\n").filter(Boolean).sort();
  return { commit_sha: sha, parent_sha: parent, branch: front.workspace.branch, worktree: cwd, changed_paths: changed };
}
