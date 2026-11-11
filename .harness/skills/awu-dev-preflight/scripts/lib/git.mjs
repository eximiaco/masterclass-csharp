import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";

export class CommandFailure extends Error {
  constructor(command, code, stdout, stderr) {
    super(`comando falhou (exit ${code}): ${command}`);
    this.name = "CommandFailure";
    this.command = command;
    this.code = code;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

export function runProgram(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, {
    cwd: options.cwd ?? process.cwd(),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: options.env ?? process.env
  });
  return {
    code: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    spawnError: result.error ? String(result.error.message ?? result.error) : null
  };
}

export function tryGit(args, options = {}) {
  return runProgram("git", args, options);
}

export function gitOk(args, options = {}) {
  return tryGit(args, options).code === 0;
}

export function mustGit(args, options = {}) {
  const result = tryGit(args, options);
  if (result.code !== 0) {
    throw new CommandFailure(`git ${args.join(" ")}`, result.code, result.stdout, result.stderr);
  }
  return result.stdout;
}

export function listWorktrees(base) {
  const result = tryGit(["worktree", "list", "--porcelain"], { cwd: base });
  if (result.code !== 0) return [];
  const worktrees = [];
  let current = null;
  for (const line of result.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length), head: null, branch: null };
      worktrees.push(current);
    } else if (line.startsWith("HEAD ") && current) {
      current.head = line.slice("HEAD ".length);
    } else if (line.startsWith("branch ") && current) {
      current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    }
  }
  return worktrees;
}

export function commonRepoRoot(base) {
  // Dentro de um linked worktree, --show-toplevel devolve o worktree e nao o
  // repositorio principal; --git-common-dir sempre aponta para o .git principal.
  const result = tryGit(["rev-parse", "--git-common-dir"], { cwd: base ?? process.cwd() });
  if (result.code !== 0) return null;
  const gitDir = result.stdout.trim();
  if (!gitDir) return null;
  return dirname(resolve(base ?? process.cwd(), gitDir));
}

export function repoRoot(base) {
  const result = tryGit(["rev-parse", "--show-toplevel"], { cwd: base ?? process.cwd() });
  if (result.code !== 0) return null;
  return result.stdout.trim();
}

export function currentBranch(base) {
  const result = tryGit(["symbolic-ref", "--short", "HEAD"], { cwd: base });
  if (result.code !== 0) return null;
  return result.stdout.trim();
}

export function headCommit(base) {
  const result = tryGit(["rev-parse", "HEAD"], { cwd: base });
  if (result.code !== 0) return null;
  return result.stdout.trim();
}

export function branchExists(base, branch) {
  return gitOk(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: base });
}

export function remoteBranchExists(base, branch) {
  return gitOk(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`], { cwd: base });
}

export function branchTip(base, branch) {
  const result = tryGit(["rev-parse", "--verify", `${branch}^{commit}`], { cwd: base });
  if (result.code !== 0) return null;
  return result.stdout.trim();
}

export function remoteInfo(base) {
  // le a URL crua do config: "git remote get-url" aplica url.<base>.insteadOf e
  // mascararia o repositorio real (que o gh precisa receber via --repo)
  const result = tryGit(["config", "--get", "remote.origin.url"], { cwd: base });
  if (result.code !== 0) return { present: false, url: null };
  return { present: true, url: result.stdout.trim() };
}

export function listStatus(base) {
  const result = tryGit(["status", "--porcelain", "-z", "--untracked-files=all"], { cwd: base });
  if (result.code !== 0) {
    throw new CommandFailure("git status --porcelain -z", result.code, result.stdout, result.stderr);
  }
  const entries = [];
  const parts = result.stdout.split("\0").filter((part) => part.length > 0);
  for (let index = 0; index < parts.length; index += 1) {
    const entry = parts[index];
    const x = entry.slice(0, 1);
    const y = entry.slice(1, 2);
    const path = entry.slice(3);
    entries.push({ x, y, path });
    if (x === "R" || x === "C") {
      index += 1; // o caminho de origem do rename ocupa a proxima entrada NUL
    }
  }
  return entries;
}

export function checkRefFormat(base, branch) {
  return tryGit(["check-ref-format", "--branch", branch], { cwd: base }).code === 0;
}

export function parseOriginSlug(url) {
  if (!url) return null;
  const match = url.match(/^(?:https?:\/\/[^/]+\/|git@[^:]+:|ssh:\/\/[^/]+\/)([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (!match) return null;
  return `${match[1]}/${match[2]}`;
}

export function parseAzureDevOpsRemote(url) {
  if (!url || typeof url !== "string") return null;
  const text = url.trim();

  // https(s)://[user@]host[:port]/{org}/{project}/_git/{repo}(.git)?
  const httpPath = text.match(
    /^(https?):\/\/(?:[^@/\s]+@)?([^/\s:]+)(?::(\d+))?\/([^/\s]+)\/([^/\s]+)\/_git\/([^/\s]+?)(?:\.git)?\/?$/
  );
  if (httpPath) {
    const [, scheme, host, port, org, project, repo] = httpPath;
    const webBase = `${scheme}://${host}${port ? `:${port}` : ""}`;
    return { scheme, host, org, project, repo, web_base: webBase, api_base: `${webBase}/${org}` };
  }

  // https://{org}.visualstudio.com/{project}/_git/{repo}(.git)? (formato legado)
  const vso = text.match(
    /^(https?):\/\/([^@/\s]+?)\.visualstudio\.com(?::(\d+))?\/([^/\s]+)\/_git\/([^/\s]+?)(?:\.git)?\/?$/
  );
  if (vso) {
    const [, scheme, org, port, project, repo] = vso;
    const webBase = `${scheme}://${org}.visualstudio.com${port ? `:${port}` : ""}`;
    return { scheme, host: `${org}.visualstudio.com`, org, project, repo, web_base: webBase, api_base: webBase };
  }

  // ssh://git@ssh.dev.azure.com/v3/{org}/{project}/{repo}(.git)?
  const sshScheme = text.match(
    /^ssh:\/\/[^@/\s]+@([^/\s:]+)(?::(\d+))?\/v3\/([^/\s]+)\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/
  );
  if (sshScheme) {
    const [, host, , org, project, repo] = sshScheme;
    const apiHost = host === "ssh.dev.azure.com" ? "dev.azure.com" : host;
    return { scheme: "https", host, org, project, repo, web_base: `https://${apiHost}`, api_base: `https://${apiHost}/${org}` };
  }

  // git@ssh.dev.azure.com:v3/{org}/{project}/{repo}(.git) (sintaxe scp)
  const sshScp = text.match(/^git@([^:/\s]+):v3\/([^/\s]+)\/([^/\s]+)\/([^/\s]+?)(?:\.git)?$/);
  if (sshScp) {
    const [, host, org, project, repo] = sshScp;
    const apiHost = host === "ssh.dev.azure.com" ? "dev.azure.com" : host;
    return { scheme: "https", host, org, project, repo, web_base: `https://${apiHost}`, api_base: `https://${apiHost}/${org}` };
  }

  return null;
}

export function aheadCount(base, fromRef, toRef) {
  const result = tryGit(["rev-list", "--count", `${fromRef}..${toRef}`], { cwd: base });
  if (result.code !== 0) return null;
  return Number(result.stdout.trim());
}
