// Fixtures locais com remoto bare e teardown; nenhum serviço ou remoto real.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const Cli = fileURLToPath(new URL("./workspace.mjs", import.meta.url));
export const Executor = fileURLToPath(new URL("../../awu-package-executor/scripts/package-state.mjs", import.meta.url));
export const PackagesDir = ".harness/workspace/awu-packages";
export const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

const Profile = `schema_version: 1

version_control:
  commits:
    style: conventional
  branching:
    strategy: trunk-based
    development_branch: main
    open_pr: true
    pr_provider: azure-devops
    work_branch_naming:
      user_story: "feature/us-{id}"
      bug: "fix/bug-{id}"
      technical_debt: "feature/td-{id}"
      descriptive: "feature/{slug}"
  worktree:
    path: "../fronts"
    bootstrap:
      copy: [".env.local", "missing.local"]
      ignore: []
`;
const Ignore = "/.harness/workspace/*\n/.harness/audits/*\n/.harness/reports/\n.env.local\n";

export const gitAt = (cwd) => (...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

export function write(directory, name, bytes) {
  const filename = path.join(directory, name);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, bytes);
}

function identify(git) {
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "commit.gpgsign", "false");
}

function seedRemote(parent, profile) {
  const seed = path.join(parent, "seed");
  fs.mkdirSync(seed);
  const git = gitAt(seed);
  git("init", "-q", "-b", "main");
  identify(git);
  write(seed, ".gitignore", Ignore);
  write(seed, ".harness/project-profile.yaml", profile);
  write(seed, "src/app.mjs", "export const version = 1;\n");
  git("add", "-A");
  git("commit", "-qm", "chore: baseline");
  const remote = path.join(parent, "remote.git");
  execFileSync("git", ["clone", "-q", "--bare", seed, remote]);
  return remote;
}

/** `remoteUrl` simula a URL do provedor; insteadOf mantém fetch/push no bare local. */
function clone(parent, remote, name, remoteUrl = null) {
  const directory = path.join(parent, name);
  execFileSync("git", ["clone", "-q", remote, directory]);
  const git = gitAt(directory);
  identify(git);
  if (remoteUrl) {
    git("remote", "set-url", "origin", remoteUrl);
    git("config", `url.${remote}.insteadOf`, remoteUrl);
  }
  return fs.realpathSync(directory);
}

function parseOutcome(code, stdout, stderr) {
  if (!stdout.trim()) throw new Error(`CLI sem saída JSON: ${stderr}`);
  return { code, ...JSON.parse(stdout) };
}

const quietEnv = (extra = {}) => ({ ...process.env, AZURE_DEVOPS_PAT: "", ...extra });

/** Executa o CLI em processo novo. Uso: cli(repo, "status", "--all"). */
export function cli(cwd, ...args) {
  const outcome = spawnSync(process.execPath, [Cli, ...args], { cwd, encoding: "utf8", env: quietEnv() });
  return parseOutcome(outcome.status, outcome.stdout, outcome.stderr);
}

/** Variante assíncrona para testes que servem uma API local ao CLI. Uso: await cliAsync(repo, ["finish"], env). */
export function cliAsync(cwd, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [Cli, ...args], { cwd, env: quietEnv(env) });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      try {
        resolve(parseOutcome(code, stdout, stderr));
      } catch (error) {
        reject(error);
      }
    });
  });
}

/**
 * Pasta principal (`root`), segundo clone (`other`) para simular merges de terceiros
 * e diretório base das frentes (`base`). Uso: const fixture = sandbox(t).
 */
export function sandbox(context, { profile = Profile, remoteUrl = null } = {}) {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "awu-workspace-")));
  context.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const remote = seedRemote(parent, profile);
  const root = clone(parent, remote, "repo", remoteUrl);
  const other = clone(parent, remote, "other");
  const otherGit = gitAt(other);
  write(root, ".env.local", "LOCAL_ONLY=1\n");
  const landOnMain = (files, message = "chore: mudança de terceiro") => {
    otherGit("checkout", "-q", "main");
    otherGit("pull", "-q", "--ff-only", "origin", "main");
    for (const [name, bytes] of Object.entries(files)) write(other, name, bytes);
    otherGit("add", "-A");
    otherGit("commit", "-qm", message);
    otherGit("push", "-q", "origin", "main");
    return otherGit("rev-parse", "HEAD");
  };
  const squashMerge = (branch) => {
    otherGit("checkout", "-q", "main");
    otherGit("pull", "-q", "--ff-only", "origin", "main");
    otherGit("fetch", "-q", "origin");
    otherGit("merge", "-q", "--squash", `origin/${branch}`);
    otherGit("commit", "-qm", `feat: squash de ${branch}`);
    otherGit("push", "-q", "origin", "main");
    otherGit("push", "-q", "origin", "--delete", branch);
  };
  return { parent, remote, root, other, base: path.join(parent, "fronts"), git: gitAt(root), otherGit, landOnMain, squashMerge };
}

/** Abre uma frente de User Story e devolve caminho e git do worktree. Uso: openFront(fixture, "101"). */
export function openFront(fixture, workItem = "101", extra = []) {
  const started = cli(fixture.root, "start", "--work-item", workItem, "--work-item-type", "User Story", "--title", "Exportar CSV", ...extra);
  if (started.code !== 0) throw new Error(JSON.stringify(started));
  return { ...started, git: gitAt(started.work_tree) };
}

/** Altera um arquivo e commita pelo CLI da frente. Uso: commitChange(front, "src/app.mjs", "…"). */
export function commitChange(front, name, bytes, message = "feat(app): altera fonte") {
  write(front.work_tree, name, bytes);
  const committed = cli(front.work_tree, "commit", "--message", message, "--paths", name);
  if (committed.code !== 0) throw new Error(JSON.stringify(committed));
  return committed;
}

const Manifest = (id, requestHash) => `id: ${id}
title: Fixture
package_inputs:
  - path: "request.md"
    sha256: "${requestHash}"
units:
  - id: a
    spec: ./a.md
    work_type: development
    depends_on: []
commit_policy:
  execution_state: .harness/workspace/commit-checkpoints/${id}.json
  final_gate: all checks
commit_checkpoints: []
`;

/** Emite um pacote compilado mínimo, como o compiler faria. Uso: compilePackage(front.work_tree, "us-101"). */
export function compilePackage(workTree, id) {
  const directory = `${PackagesDir}/${id}`;
  const requestHash = hash(fs.readFileSync(path.join(workTree, directory, "request.md")));
  write(workTree, `${directory}/execution-manifest.yaml`, Manifest(id, requestHash));
  write(workTree, `${directory}/a.md`, "# A\nImplementar e validar.");
  write(workTree, `${directory}/test-strategy.yaml`, "schema_version: 1\nstatus: ready\nreason: null\n");
  write(workTree, `${directory}/review-manifest.md`, "# Review\nUnidade A.");
  return `${directory}/execution-manifest.yaml`;
}

/**
 * API mínima de pull requests do Azure DevOps em localhost, para exercitar o CLI
 * sem provedor real. Uso: const api = await adoServer(t); sandbox(t, { remoteUrl: api.remoteUrl }).
 */
export async function adoServer(context) {
  const http = await import("node:http");
  const api = { requests: [], pulls: [], nextId: 7 };
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      api.requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization });
      const single = /\/pullrequests\/(\d+)\?/.exec(request.url);
      let payload = { value: api.pulls.filter((pull) => pull.status === "active") };
      if (single) payload = api.pulls.find((pull) => pull.pullRequestId === Number(single[1])) ?? {};
      if (request.method === "POST") {
        payload = { pullRequestId: api.nextId++, status: "active", ...JSON.parse(body) };
        api.pulls.push(payload);
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(payload));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  api.remoteUrl = `http://127.0.0.1:${server.address().port}/org/Follow%20the%20Code/_git/repo`;
  return api;
}
