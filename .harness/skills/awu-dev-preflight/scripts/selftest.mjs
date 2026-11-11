#!/usr/bin/env node
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseSimpleYaml,
  ensureBranchingDefaults,
  resolveBranchingConfig
} from "./lib/profile.mjs";
import { parseAzureDevOpsRemote } from "./lib/git.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const preflightPath = join(scriptDir, "preflight.mjs");
const tempRoot = mkdtempSync(join(tmpdir(), "awu-preflight-selftest-"));

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label ?? "valor"} esperado ${e}, obtido ${a}`);
}

function sh(command, args, opts = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env ?? {}) }
  });
  if (result.status !== 0 && !opts.allowFailure) {
    throw new Error(`${command} ${args.join(" ")} falhou (${result.status}): ${result.stderr || result.stdout}`);
  }
  return result;
}

function git(args, opts = {}) {
  return sh("git", args, opts);
}

function trackedStatus(repoPath) {
  return git(["status", "--porcelain", "--untracked-files=no"], { cwd: repoPath }).stdout;
}

function newRepo({ branches = ["main"] } = {}) {
  const path = join(tempRoot, `repo-${tests.length}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dirname(path), { recursive: true });
  git(["init", "-b", "main", path]);
  for (const flag of ["user.email=awu@example.com", "user.name=AWU Test", "commit.gpgsign=false", "tag.gpgsign=false", "core.autocrlf=false"]) {
    git(["config", ...flag.split("=")], { cwd: path });
  }
  writeFileSync(join(path, "README.md"), "# demo\n\nlinha-base\n");
  git(["add", "README.md"], { cwd: path });
  git(["commit", "-m", "chore(setup): commit inicial"], { cwd: path });
  for (const branch of branches) {
    if (branch === "main") continue;
    git(["branch", branch], { cwd: path });
  }
  return path;
}

function newRemote(fromRepo, githubUrl = null) {
  const path = join(tempRoot, `remote-${tests.length}-${Math.random().toString(36).slice(2, 8)}.git`);
  sh("git", ["clone", "--bare", fromRepo, path]);
  git(["remote", "add", "origin", githubUrl ?? path], { cwd: fromRepo });
  if (githubUrl) {
    git(["config", `url.${path}.insteadOf`, githubUrl], { cwd: fromRepo });
  }
  return path;
}

function writeProfile(repoPath, content) {
  const profilePath = join(repoPath, ".harness", "project-profile.yaml");
  mkdirSync(dirname(profilePath), { recursive: true });
  writeFileSync(profilePath, content);
  return profilePath;
}

const TRUNK_PROFILE = `schema_version: 1

application:
  name: demo-app
  description: app de teste
  primary_language: Node.js

version_control:
  commits:
    style: conventional
    header_max_length: 72
`;

const OPEN_PR_FALSE_PROFILE = `schema_version: 1

version_control:
  commits:
    style: conventional
  branching:
    strategy: trunk-based
    open_pr: false
`;

function runCli(args, opts = {}) {
  // async: mantem o event loop livre para servidores fake (gh/ADO) durante o CLI
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [preflightPath, ...args], {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) }
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => resolveRun({ status: code ?? -1, stdout, stderr }));
  });
}

async function start(repoPath, extra = {}) {
  const args = ["start", "--repo", repoPath, "--type", extra.type ?? "feat", "--context", extra.context ?? "demo"];
  if (extra.dryRun) args.push("--dry-run");
  return await runCli(args, opts_of(extra));
}

async function finish(repoPath, extra = {}) {
  const args = ["finish", "--repo", repoPath];
  if (extra.message) args.push("--message", extra.message);
  if (extra.dryRun) args.push("--dry-run");
  if (extra.includeWorkspace) args.push("--include-workspace");
  if (extra.removeWorktree) args.push("--remove-worktree");
  if (extra.keepWorktree) args.push("--keep-worktree");
  if (extra.noTypeContext !== true) {
    args.push("--type", extra.type ?? "feat", "--context", extra.context ?? "demo");
  }
  return await runCli(args, opts_of(extra));
}

function opts_of(extra) {
  return extra.env ? { env: extra.env } : {};
}

function headHash(repoPath) {
  return git(["rev-parse", "HEAD"], { cwd: repoPath }).stdout.trim();
}

function currentBranch(repoPath) {
  return git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoPath }).stdout.trim();
}

function writeFileIn(repoPath, filePath, content) {
  const absolute = join(repoPath, filePath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

function commitOnBranch(repoPath, filePath, content, message) {
  const absolute = join(repoPath, filePath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
  git(["add", "--", filePath], { cwd: repoPath });
  git(["commit", "-m", message], { cwd: repoPath });
}

function fakeGhBin(stateFile) {
  const binDir = join(tempRoot, `gh-bin-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(binDir, { recursive: true });
  const script = [
    "#!/bin/bash",
    `state="${stateFile}"`,
    'case "$1" in',
    '  --version) echo "gh version 2.63.2-fake"; exit 0;;',
    "  pr)",
    "    shift",
    '    case "$1" in',
    "      list)",
    '        if [ -f "$state" ]; then printf "[%s]" "$(cat "$state")"; else echo "[]"; fi',
    "        exit 0;;",
    "      create)",
    "        echo '{\"number\":7,\"url\":\"https://github.com/acme/demo-app/pull/7\",\"title\":\"t\"}' > \"$state\"",
    '        echo "https://github.com/acme/demo-app/pull/7"',
    "        exit 0;;",
    "    esac",
    "    exit 1;;",
    "esac",
    "exit 1"
  ].join("\n");
  const ghPath = join(binDir, "gh");
  writeFileSync(ghPath, script, { mode: 0o755 });
  return binDir;
}

test("parser: le YAML do template (comentarios, listas, aspas e blocos aninhados)", async () => {
  const text = `# comentario
schema_version: 1

application:
  name: "demo-app"
  description: 'app de demo'   # comentario inline
  capabilities: ["api", "cli"]

version_control:
  commits:
    style: conventional
    header_max_length: 72

conventions:
  - name: nomenclatura
    applies_to:
      - new
      - modified
    rules:
      - arquivos em kebab-case
`;
  const data = parseSimpleYaml(text);
  assertEqual(data.schema_version, 1, "schema_version");
  assertEqual(data.application.name, "demo-app", "application.name");
  assertEqual(data.application.description, "app de demo", "application.description");
  assertEqual(data.application.capabilities, ["api", "cli"], "capabilities");
  assertEqual(data.version_control.commits.header_max_length, 72, "header_max_length");
  assertEqual(data.conventions[0].applies_to, ["new", "modified"], "applies_to");
  assertEqual(data.conventions[0].rules, ["arquivos em kebab-case"], "rules");
});

test("defaults: profile sem branching recebe os 5 defaults", async () => {
  const resolved = resolveBranchingConfig({ exists: true, data: { version_control: { commits: { style: "conventional" } } } });
  assertEqual(resolved.missing_keys, ["strategy", "development_branch", "open_pr", "work_branch_template", "pr_provider"], "missing_keys");
  assertEqual(resolved.config.strategy, "trunk-based", "strategy default");
  assertEqual(resolved.config.development_branch, "main", "dev default");
  assertEqual(resolved.config.open_pr, true, "open_pr default");
  assertEqual(resolved.config.work_branch_template, "{type}({context})", "template default");
  assertEqual(resolved.config.pr_provider, "github", "provider default");
});

test("profile: template sem placeholders ou strategy desconhecida sao rejeitados", async () => {
  let failed = null;
  try {
    resolveBranchingConfig({ exists: true, data: { version_control: { branching: { work_branch_template: "{type}-{ctx}" } } } });
  } catch (error) {
    failed = error;
  }
  assert(failed && failed.message.includes("{type}"), "deve exigir placeholders");
  failed = null;
  try {
    resolveBranchingConfig({ exists: true, data: { version_control: { branching: { strategy: "gitflow" } } } });
  } catch (error) {
    failed = error;
  }
  assert(failed && failed.message.includes("gitflow"), "deve rejeitar strategy desconhecida");
  failed = null;
  try {
    resolveBranchingConfig({ exists: true, data: { version_control: { branching: { pr_provider: "gitea" } } } });
  } catch (error) {
    failed = error;
  }
  assert(failed && failed.message.includes("gitea"), "deve rejeitar pr_provider desconhecido");
});

test("ensureBranchingDefaults: cria profile minimo quando ausente e preenche parcial", async () => {
  const caseDir = join(tempRoot, "defaults-case");
  mkdirSync(join(caseDir, ".harness"), { recursive: true });
  const absent = join(caseDir, ".harness", "project-profile.yaml");
  let result = ensureBranchingDefaults(absent, {
    strategy: "trunk-based",
    development_branch: "main",
    open_pr: true,
    work_branch_template: "{type}({context})",
    pr_provider: "github"
  });
  assertEqual(result.created, true, "created");
  assertEqual(result.added_keys.length, 5, "5 chaves");
  const created = readFileSync(absent, "utf8");
  assert(created.startsWith("schema_version: 1"), "profile minimo comeca com schema_version");
  assert(created.includes('work_branch_template: "{type}({context})"'), "template entre aspas");
  assert(created.includes('pr_provider: "github"'), "provider entre aspas");

  const partial = join(caseDir, ".harness", "partial.yaml");
  writeFileSync(partial, "version_control:\n  commits:\n    style: conventional\n  branching:\n    strategy: git-flow\n");
  result = ensureBranchingDefaults(partial, {
    strategy: "git-flow",
    development_branch: "develop",
    open_pr: true,
    work_branch_template: "{type}({context})",
    pr_provider: "azure-devops"
  });
  assertEqual(result.added_keys, ["development_branch", "open_pr", "work_branch_template", "pr_provider"], "parcial");
  const parsed = parseSimpleYaml(readFileSync(partial, "utf8"));
  assertEqual(parsed.version_control.commits.style, "conventional", "conteudo preservado");
  assertEqual(parsed.version_control.branching.development_branch, "develop", "chave inserida");
  assertEqual(parsed.version_control.branching.pr_provider, "azure-devops", "provider inserido");
});

test("start trunk-based: cria work branch, injeta defaults no profile e grava state", async () => {
  const repo = newRepo();
  const profilePath = writeProfile(repo, TRUNK_PROFILE);
  const result = await start(repo);
  assertEqual(result.status, 0, "exit code");
  const report = JSON.parse(result.stdout);
  assertEqual(report.status, "ok", "status");
  assertEqual(report.work_branch, "feat(demo)", "work branch");
  assertEqual(report.work_branch_action, "created", "action");
  assertEqual(currentBranch(repo), "feat(demo)", "branch atual");
  assertEqual(report.profile.updated, true, "profile atualizado");
  assertEqual(report.profile.added_keys.length, 5, "5 chaves adicionadas");
  const after = resolveBranchingConfig({ exists: true, data: parseSimpleYaml(readFileSync(profilePath, "utf8")) });
  assertEqual(after.missing_keys, [], "profile completo apos ensure");
  assert(existsSync(join(repo, ".harness", "workspace", "preflight-state.json")), "state file");
});

test("start: rejeita arvore suja fora do workspace", async () => {
  const repo = newRepo();
  writeProfile(repo, TRUNK_PROFILE);
  writeFileSync(join(repo, "README.md"), "# demo\n\nalterado\n");
  const result = await start(repo);
  assertEqual(result.status, 1, "exit code");
  const report = JSON.parse(result.stdout);
  assertEqual(report.status, "error", "status");
  assertEqual(report.step, "worktree-clean", "step");
  assert(report.repo_state.dirty_files.some((line) => line.includes("README.md")), "dirty_files");
  assertEqual(currentBranch(repo), "main", "branch nao mudou");
});

test("start: ignora arquivos do workspace efemero e prossegue", async () => {
  const repo = newRepo();
  writeProfile(repo, TRUNK_PROFILE);
  mkdirSync(join(repo, ".harness", "workspace"), { recursive: true });
  writeFileSync(join(repo, ".harness", "workspace", "rascunho.txt"), "rascunho");
  const result = await start(repo);
  assertEqual(result.status, 0, "exit code");
  assertEqual(JSON.parse(result.stdout).work_branch_action, "created", "action");
});

test("start: reaproveita work branch sem commits e falha quando ela tem commits", async () => {
  const repo = newRepo();
  writeProfile(repo, TRUNK_PROFILE);
  await start(repo);
  git(["checkout", "main"], { cwd: repo });
  let result = await start(repo);
  assertEqual(JSON.parse(result.stdout).work_branch_action, "reused", "reuso");

  git(["checkout", "feat(demo)"], { cwd: repo });
  commitOnBranch(repo, "src/novo.txt", "conteudo\n", "feat(demo): primeiro commit");
  git(["checkout", "main"], { cwd: repo });
  result = await start(repo);
  assertEqual(result.status, 1, "exit code com commits");
  const report = JSON.parse(result.stdout);
  assertEqual(report.step, "work-branch-exists", "step");
  assert(Array.isArray(report.suggestions) && report.suggestions.length > 0, "sugestoes");
  assert(Array.isArray(report.forbidden_actions) && report.forbidden_actions.length > 0, "forbidden_actions");
});

test("start git-flow: usa develop e template customizado", async () => {
  const repo = newRepo({ branches: ["develop"] });
  writeProfile(repo, "version_control:\n  branching:\n    strategy: git-flow\n    work_branch_template: \"{type}/{context}\"\n");
  const result = await start(repo, { type: "fix", context: "memory-leak" });
  assertEqual(result.status, 0, "exit code");
  const report = JSON.parse(result.stdout);
  assertEqual(report.development_branch, "develop", "dev branch");
  assertEqual(report.work_branch, "fix/memory-leak", "work branch");
  assertEqual(currentBranch(repo), "fix/memory-leak", "branch atual");
  assertEqual(report.profile.added_keys, ["development_branch", "open_pr", "pr_provider"], "chaves adicionadas");
});

test("start: pull divergiu da origin produz erro estruturado", async () => {
  const repo = newRepo();
  writeProfile(repo, TRUNK_PROFILE);
  const bare = newRemote(repo);
  git(["push", "origin", "main"], { cwd: repo });
  const other = join(tempRoot, "clone-divergente");
  sh("git", ["clone", bare, other]);
  sh("git", ["config", "user.email", "awu@example.com"], { cwd: other });
  sh("git", ["config", "user.name", "AWU Test"], { cwd: other });
  writeFileSync(join(other, "outro.txt"), "commit remoto\n");
  sh("git", ["add", "outro.txt"], { cwd: other });
  sh("git", ["commit", "-m", "feat(outro): commit no remoto"], { cwd: other });
  sh("git", ["push", "origin", "main"], { cwd: other });
  commitOnBranch(repo, "local.txt", "commit local\n", "feat(local): commit divergente");
  const result = await start(repo);
  assertEqual(result.status, 1, "exit code");
  const report = JSON.parse(result.stdout);
  assertEqual(report.step, "pull", "step");
  assert(Number.isInteger(report.exit_code), "exit_code do git");
  assert(String(report.command).includes("pull"), "command do git");
  assert(report.forbidden_actions.includes("sobrescrever historico: git push --force, git push --force-with-lease, git rebase destrutivo"), "forbidden force push");
});

test("start --dry-run: planeja sem mutar o repositorio", async () => {
  const repo = newRepo();
  writeProfile(repo, TRUNK_PROFILE);
  const before = headHash(repo);
  const result = await start(repo, { dryRun: true });
  assertEqual(result.status, 0, "exit code");
  const report = JSON.parse(result.stdout);
  assertEqual(report.dry_run, true, "dry_run");
  assert(report.plan.some((line) => line.includes("git checkout -b feat(demo)")), "plan checkout");
  assert(!existsSync(join(repo, ".harness", "workspace", "preflight-state.json")), "state nao criado");
  assertEqual(currentBranch(repo), "main", "branch atual");
  assertEqual(headHash(repo), before, "HEAD inalterado");
  const parsed = parseSimpleYaml(readFileSync(join(repo, ".harness", "project-profile.yaml"), "utf8"));
  assert(parsed.version_control.branching === undefined, "profile inalterado");
});

test("start: valida argumentos de tipo e contexto", async () => {
  const repo = newRepo();
  writeProfile(repo, TRUNK_PROFILE);
  let result = await runCli(["start", "--repo", repo, "--type", "bugfix", "--context", "demo"]);
  assertEqual(result.status, 1, "bugfix rejeitado");
  let report = JSON.parse(result.stdout);
  assertEqual(report.step, "arguments", "step bugfix");
  assert(report.suggestions.join(" ").includes("fix"), "sugestao fix");
  result = await runCli(["start", "--repo", repo, "--type", "feat", "--context", "User Auth"]);
  assertEqual(result.status, 1, "contexto invalido");
  report = JSON.parse(result.stdout);
  assertEqual(report.step, "arguments", "step contexto");
});

test("finish open_pr=false: commit, merge --no-ff; workspace fica fora do commit", async () => {
  const repo = newRepo();
  writeProfile(repo, OPEN_PR_FALSE_PROFILE);
  await start(repo);
  writeFileIn(repo, "src/app.txt", "nova implementacao\n");
  const result = await finish(repo, { message: "feat(demo): implementa app" });
  assertEqual(result.status, 0, "exit code");
  const report = JSON.parse(result.stdout);
  assertEqual(report.status, "ok", "status");
  assertEqual(report.delivered_via, "direct-merge", "entrega");
  assert(report.workspace_files_excluded.join(" ").includes("preflight-state.json"), "workspace excluido");
  assertEqual(currentBranch(repo), "main", "pos-merge em main");
  const parents = git(["rev-list", "--parents", "-n", "1", "HEAD"], { cwd: repo }).stdout.trim().split(" ");
  assertEqual(parents.length, 3, "merge commit tem 2 pais");
  assert(git(["rev-parse", "--verify", "refs/heads/feat(demo)"], { cwd: repo, allowFailure: true }).status === 0, "work branch preservada");
  const committed = git(["show", "--name-only", "--format=", "HEAD^2"], { cwd: repo }).stdout.trim().split("\n").sort();
  assertEqual(committed, [".harness/project-profile.yaml", "src/app.txt"], "commit da work branch");
  assert(!git(["show", "--name-only", "--format=", "HEAD"], { cwd: repo }).stdout.includes("preflight-state.json"), "merge nao traz state");
});

test("finish open_pr=true: cria PR via gh fake e segunda execucao e idempotente", async () => {
  const repo = newRepo();
  const stateFile = join(tempRoot, "gh-state.json");
  const binDir = fakeGhBin(stateFile);
  writeProfile(repo, TRUNK_PROFILE);
  newRemote(repo, "https://github.com/acme/demo-app.git");
  git(["push", "origin", "main"], { cwd: repo });
  await start(repo);
  writeFileIn(repo, "src/pr.txt", "via PR\n");
  const env = { PATH: `${binDir}:${process.env.PATH}` };
  let result = await finish(repo, { message: "feat(demo): entrega via PR", env });
  assertEqual(result.status, 0, "exit code");
  let report = JSON.parse(result.stdout);
  assertEqual(report.delivered_via, "pull-request", "entrega");
  assertEqual(report.pull_request.provider, "github", "provider");
  assertEqual(report.pull_request.created, true, "PR criado");
  assertEqual(report.pull_request.url, "https://github.com/acme/demo-app/pull/7", "URL");
  assert(git(["ls-remote", "--heads", "origin", "feat(demo)"], { cwd: repo }).stdout.includes("feat(demo)"), "work branch no remote");

  result = await finish(repo, { env, noTypeContext: true });
  assertEqual(result.status, 0, "segunda execucao");
  report = JSON.parse(result.stdout);
  assertEqual(report.pull_request.created, false, "PR reutilizado");
  assertEqual(report.commit, null, "sem novo commit");
});

test("finish: conflito de merge aborta e preserva o estado", async () => {
  const repo = newRepo();
  writeProfile(repo, OPEN_PR_FALSE_PROFILE);
  await start(repo);
  writeFileSync(join(repo, "README.md"), "# demo\n\nalterado-na-work\n");
  git(["add", "README.md"], { cwd: repo });
  git(["commit", "-m", "feat(demo): altera readme"], { cwd: repo });
  git(["checkout", "main"], { cwd: repo });
  writeFileSync(join(repo, "README.md"), "# demo\n\nalterado-na-dev\n");
  git(["add", "README.md"], { cwd: repo });
  git(["commit", "-m", "chore(readme): altera mesma linha"], { cwd: repo });
  const devHead = headHash(repo);
  const result = await finish(repo, { message: "feat(demo): x", noTypeContext: true });
  assertEqual(result.status, 1, "exit code");
  const report = JSON.parse(result.stdout);
  assertEqual(report.status, "error", "status");
  assertEqual(report.step, "merge-conflict", "step");
  assert(report.conflicted_files.includes("README.md"), "arquivos em conflito");
  assertEqual(headHash(repo), devHead, "HEAD da dev restaurado");
  assertEqual(currentBranch(repo), "main", "de volta em main");
  assertEqual(trackedStatus(repo), "", "arvore limpa apos abort");
  assert(git(["rev-parse", "--verify", "refs/heads/feat(demo)"], { cwd: repo, allowFailure: true }).status === 0, "work branch intacta");
});

test("finish: nada a entregar produz erro claro", async () => {
  const repo = newRepo();
  writeProfile(repo, `version_control:\n  branching:\n    strategy: trunk-based\n    development_branch: main\n    open_pr: false\n    work_branch_template: "{type}({context})"\n    pr_provider: "github"\n`);
  git(["add", "--", ".harness/project-profile.yaml"], { cwd: repo });
  git(["commit", "-m", "chore(profile): baseline"], { cwd: repo });
  await start(repo);
  const result = await finish(repo, { message: "feat(demo): nada" });
  assertEqual(result.status, 1, "exit code");
  assertEqual(JSON.parse(result.stdout).step, "nothing-to-deliver", "step");
});

test("finish: mensagem fora do padrao conventional falha antes do staging", async () => {
  const repo = newRepo();
  writeProfile(repo, OPEN_PR_FALSE_PROFILE);
  await start(repo);
  writeFileIn(repo, "src/x.txt", "conteudo\n");
  const result = await finish(repo, { message: "atualiza arquivos" });
  assertEqual(result.status, 1, "exit code");
  const report = JSON.parse(result.stdout);
  assertEqual(report.step, "commit-message", "step");
  assert(git(["status", "--porcelain"], { cwd: repo }).stdout.includes("src/"), "nada commitado");
  assertEqual(currentBranch(repo), "feat(demo)", "ainda na work branch");
});

test("finish sem state e sem --type/--context falha com orientacao", async () => {
  const repo = newRepo();
  writeProfile(repo, OPEN_PR_FALSE_PROFILE);
  const result = await finish(repo, { noTypeContext: true });
  assertEqual(result.status, 1, "exit code");
  const report = JSON.parse(result.stdout);
  assertEqual(report.step, "work-branch-name", "step");
  assert(report.message.includes("fase start"), "mensagem orienta start");
});

test("finish --dry-run: lista plano sem alterar o repositorio", async () => {
  const repo = newRepo();
  writeProfile(repo, OPEN_PR_FALSE_PROFILE);
  await start(repo);
  writeFileIn(repo, "src/dry.txt", "dry\n");
  const before = headHash(repo);
  const result = await finish(repo, { message: "feat(demo): dry", dryRun: true });
  assertEqual(result.status, 0, "exit code");
  const report = JSON.parse(result.stdout);
  assertEqual(report.dry_run, true, "dry_run");
  assertEqual(report.files_to_commit.sort(), [".harness/project-profile.yaml", "src/dry.txt"], "arquivos");
  assertEqual(headHash(repo), before, "HEAD inalterado");
  assert(git(["status", "--porcelain"], { cwd: repo }).stdout.includes("src/"), "arquivo ainda unstaged");
});

async function fakeAdoServer() {
  const prs = [];
  const expectedAuth = `Basic ${Buffer.from(":ado-pat-teste").toString("base64")}`;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const respond = (status, body) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      };
      const path = new URL(req.url, "http://localhost").pathname;
      if (!path.endsWith("/_apis/git/repositories/adorepo/pullrequests")) {
        respond(404, { message: "nao encontrado" });
        return;
      }
      if ((req.headers.authorization ?? "") !== expectedAuth) {
        respond(401, { message: "credencial recusada" });
        return;
      }
      if (req.method === "GET") {
        respond(200, { count: prs.length, value: prs });
        return;
      }
      if (req.method === "POST") {
        const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
        const pr = {
          pullRequestId: 42,
          sourceRefName: body.sourceRefName,
          targetRefName: body.targetRefName,
          _links: { web: { href: `http://${req.headers.host}/adoorg/adoproj/_git/adorepo/pullrequest/42` } }
        };
        prs.push(pr);
        respond(201, pr);
        return;
      }
      respond(405, { message: "metodo nao suportado" });
    });
  });
  return new Promise((resolveServer) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolveServer({ port, prs, close: () => new Promise((done) => server.close(done)) });
    });
  });
}

const ADO_PROFILE = `schema_version: 1

version_control:
  commits:
    style: conventional
  branching:
    strategy: trunk-based
    pr_provider: azure-devops
`;

test("parseAzureDevOpsRemote: https, legado visualstudio e ssh v3; URL de outro host retorna null", async () => {
  const https = parseAzureDevOpsRemote("https://org@dev.azure.com/org/proj/_git/repo");
  assertEqual(https.api_base, "https://dev.azure.com/org", "api https");
  assertEqual(https.project, "proj", "project https");
  const local = parseAzureDevOpsRemote("http://127.0.0.1:3999/adoorg/adoproj/_git/adorepo");
  assertEqual(local.api_base, "http://127.0.0.1:3999/adoorg", "api com porta");
  assertEqual(local.web_base, "http://127.0.0.1:3999", "web com porta");
  const vso = parseAzureDevOpsRemote("https://org.visualstudio.com/proj/_git/repo");
  assertEqual(vso.api_base, "https://org.visualstudio.com", "api legada");
  const ssh = parseAzureDevOpsRemote("git@ssh.dev.azure.com:v3/org/proj/repo");
  assertEqual(ssh.api_base, "https://dev.azure.com/org", "api a partir de ssh");
  assertEqual(parseAzureDevOpsRemote("https://github.com/acme/demo-app.git"), null, "URL nao-ADO");
});

test("start: pr_provider desconhecido falha apontando os valores aceitos", async () => {
  const repo = newRepo();
  writeProfile(repo, `version_control:\n  branching:\n    strategy: trunk-based\n    pr_provider: gitea\n`);
  const result = await start(repo);
  assertEqual(result.status, 1, "exit code");
  const report = JSON.parse(result.stdout);
  assertEqual(report.step, "read-profile", "step");
  assert(report.message.includes("pr_provider"), "mensagem menciona pr_provider");
  assert(report.message.includes("azure-devops"), "mensagem lista valores aceitos");
});

test("finish open_pr=true + pr_provider=azure-devops: cria PR via REST e segunda execucao e idempotente", async () => {
  const fake = await fakeAdoServer();
  try {
    const repo = newRepo();
    const adoUrl = `http://127.0.0.1:${fake.port}/adoorg/adoproj/_git/adorepo`;
    writeProfile(repo, ADO_PROFILE);
    newRemote(repo, adoUrl);
    git(["push", "origin", "main"], { cwd: repo });
    await start(repo);
    writeFileIn(repo, "src/ado.txt", "via Azure DevOps\n");
    const env = { AZURE_DEVOPS_PAT: "ado-pat-teste" };
    let result = await finish(repo, { message: "feat(demo): entrega via PR no ADO", env });
    assertEqual(result.status, 0, "exit code");
    let report = JSON.parse(result.stdout);
    assertEqual(report.delivered_via, "pull-request", "entrega");
    assertEqual(report.pull_request.provider, "azure-devops", "provider");
    assertEqual(report.pull_request.created, true, "PR criado");
    assertEqual(report.pull_request.number, 42, "numero do PR");
    assert(String(report.pull_request.url).includes("pullrequest/42"), "URL do PR");
    assertEqual(fake.prs.length, 1, "um PR criado no servidor");
    assertEqual(fake.prs[0].sourceRefName, "refs/heads/feat(demo)", "sourceRefName");
    assertEqual(fake.prs[0].targetRefName, "refs/heads/main", "targetRefName");

    result = await finish(repo, { env, noTypeContext: true });
    assertEqual(result.status, 0, "segunda execucao");
    report = JSON.parse(result.stdout);
    assertEqual(report.pull_request.created, false, "PR reutilizado");
    assertEqual(report.commit, null, "sem novo commit");
    assertEqual(fake.prs.length, 1, "nenhum PR duplicado");
  } finally {
    await fake.close();
  }
});

test("finish azure-devops sem AZURE_DEVOPS_PAT falha com URL de criacao manual", async () => {
  const fake = await fakeAdoServer();
  try {
    const repo = newRepo();
    writeProfile(repo, ADO_PROFILE);
    newRemote(repo, `http://127.0.0.1:${fake.port}/adoorg/adoproj/_git/adorepo`);
    git(["push", "origin", "main"], { cwd: repo });
    await start(repo);
    writeFileIn(repo, "src/sem-pat.txt", "conteudo\n");
    const result = await finish(repo, { message: "feat(demo): sem PAT", env: { AZURE_DEVOPS_PAT: "" } });
    assertEqual(result.status, 1, "exit code");
    const report = JSON.parse(result.stdout);
    assertEqual(report.step, "pr-ado-pat", "step");
    assert(report.message.includes("AZURE_DEVOPS_PAT"), "mensagem cita a variavel");
    assert(String(report.pull_request_create_url).includes("pullrequestcreate"), "URL manual informada");
    assertEqual(fake.prs.length, 0, "nenhum PR criado");
    assertEqual(currentBranch(repo), "feat(demo)", "ainda na work branch");
  } finally {
    await fake.close();
  }
});

test("finish pr_provider=azure-devops com open_pr=false: merge direto sem PAT", async () => {
  const repo = newRepo();
  writeProfile(repo, `version_control:\n  branching:\n    strategy: trunk-based\n    open_pr: false\n    pr_provider: azure-devops\n`);
  await start(repo);
  writeFileIn(repo, "src/merge-ado.txt", "conteudo\n");
  const result = await finish(repo, { message: "feat(demo): merge direto" });
  assertEqual(result.status, 0, "exit code");
  const report = JSON.parse(result.stdout);
  assertEqual(report.delivered_via, "direct-merge", "entrega");
  assertEqual(currentBranch(repo), "main", "pos-merge");
});

const WORKTREE_PROFILE = `schema_version: 1

version_control:
  commits:
    style: conventional
  branching:
    strategy: trunk-based
    open_pr: false
  worktree:
    enabled: true
`;

function worktreePaths(repoPath) {
  return git(["worktree", "list", "--porcelain"], { cwd: repoPath }).stdout
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
}

function writeIn(dirPath, relPath, content) {
  const target = join(dirPath, relPath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
  return target;
}

test("start worktree: cria worktree isolado sem tocar a arvore principal", async () => {
  const repo = newRepo();
  writeProfile(repo, WORKTREE_PROFILE);
  const result = await start(repo);
  assertEqual(result.status, 0, "exit code");
  const report = JSON.parse(result.stdout);
  assertEqual(report.status, "ok", "status");
  assertEqual(report.work_branch, "feat(demo)", "work branch");
  assertEqual(report.work_branch_action, "created", "action");
  assert(currentBranch(repo) === "main", "arvore principal permanece no development branch");
  assert(existsSync(report.work_tree), "worktree existe");
  assert(worktreePaths(repo).includes(report.work_tree), "worktree registrado no git");
  assert(existsSync(join(repo, ".harness", "workspace", "preflight-states", "feat__demo.json")), "state por work unit");
  const exclude = readFileSync(join(repo, ".git", "info", "exclude"), "utf8");
  assert(exclude.includes(".harness/worktrees/"), "worktrees ignorados via .git/info/exclude");
  const dirty = git(["status", "--porcelain"], { cwd: repo }).stdout;
  assert(!dirty.includes("worktrees"), "status principal nao exibe worktrees");
  assertEqual(report.worktree.path, ".harness/worktrees", "caminho configurado");
});

test("start worktree: arvore principal suja nao bloqueia a execucao", async () => {
  const repo = newRepo();
  writeProfile(repo, WORKTREE_PROFILE);
  writeIn(repo, "rascunho.txt", "edicao local do usuario\n");
  const result = await start(repo);
  assertEqual(result.status, 0, "exit code");
  const report = JSON.parse(result.stdout);
  assert(existsSync(report.work_tree), "worktree criado mesmo com arvore principal suja");
});

test("start worktree: repeticao e idempotente e devolve o mesmo work_tree", async () => {
  const repo = newRepo();
  writeProfile(repo, WORKTREE_PROFILE);
  const first = JSON.parse((await start(repo)).stdout);
  const second = JSON.parse((await start(repo)).stdout);
  assertEqual(second.status, "ok", "status");
  assertEqual(second.already_started, true, "already_started");
  assertEqual(second.work_tree, first.work_tree, "mesmo worktree");
});

test("start worktree: execucao retomada recria o worktree com os commits da unidade", async () => {
  const repo = newRepo();
  writeProfile(repo, WORKTREE_PROFILE);
  const report = JSON.parse((await start(repo)).stdout);
  writeIn(report.work_tree, "src/parcial.txt", "trabalho em progresso\n");
  git(["add", "src/parcial.txt"], { cwd: report.work_tree });
  git(["commit", "-m", "feat(demo): trabalho parcial"], { cwd: report.work_tree });
  rmSync(report.work_tree, { recursive: true, force: true });
  git(["worktree", "prune"], { cwd: repo });
  const again = JSON.parse((await start(repo)).stdout);
  assertEqual(again.status, "ok", "status");
  assertEqual(again.work_branch_action, "restored", "action");
  assertEqual(again.work_tree, report.work_tree, "mesmo caminho");
  assert(headHash(again.work_tree) !== headHash(repo), "commits da unidade preservados");
});

test("start worktree: work branch com commits e sem state falha com orientacao", async () => {
  const repo = newRepo();
  writeProfile(repo, WORKTREE_PROFILE);
  git(["checkout", "-b", "feat(demo)"], { cwd: repo });
  writeIn(repo, "outro.txt", "x\n");
  git(["add", "outro.txt"], { cwd: repo });
  git(["commit", "-m", "feat(demo): commit orfao"], { cwd: repo });
  git(["checkout", "main"], { cwd: repo });
  const result = await start(repo);
  assertEqual(result.status, 1, "exit code");
  const report = JSON.parse(result.stdout);
  assertEqual(report.step, "work-branch-exists", "step");
});

test("start worktree: arvore principal na work branch falha antes de criar worktree", async () => {
  const repo = newRepo();
  writeProfile(repo, WORKTREE_PROFILE);
  git(["checkout", "-b", "feat(demo)"], { cwd: repo });
  const result = await start(repo);
  assertEqual(result.status, 1, "exit code");
  const report = JSON.parse(result.stdout);
  assertEqual(report.step, "worktree-main-conflict", "step");
});

test("start worktree: worktree.path com .. e rejeitado no profile", async () => {
  const repo = newRepo();
  writeProfile(repo, `${WORKTREE_PROFILE}    path: ../fora\n`);
  const result = await start(repo);
  assertEqual(result.status, 1, "exit code");
  const report = JSON.parse(result.stdout);
  assertEqual(report.step, "read-profile", "step");
});

test("start worktree --dry-run: planeja sem mutar o repositorio", async () => {
  const repo = newRepo();
  writeProfile(repo, WORKTREE_PROFILE);
  const result = await start(repo, { dryRun: true });
  assertEqual(result.status, 0, "exit code");
  const report = JSON.parse(result.stdout);
  assertEqual(report.dry_run, true, "dry_run");
  assertEqual(worktreePaths(repo).length, 1, "apenas a arvore principal");
  assert(!existsSync(join(repo, ".harness", "workspace", "preflight-states", "feat__demo.json")), "state nao gravado");
});

test("finish worktree open_pr=false: merge em worktree temporario e worktree da unidade removido", async () => {
  const repo = newRepo();
  writeProfile(repo, WORKTREE_PROFILE);
  const report = JSON.parse((await start(repo)).stdout);
  writeIn(report.work_tree, "src/app.txt", "implementacao\n");
  // desloca a arvore principal para outra branch: o merge precisa do worktree temporario
  git(["checkout", "-b", "paralelo"], { cwd: repo });
  const result = await finish(repo, { message: "feat(demo): entrega worktree" });
  assertEqual(result.status, 0, "exit code");
  const delivered = JSON.parse(result.stdout);
  assertEqual(delivered.delivered_via, "direct-merge", "entrega");
  assertEqual(delivered.merge.via, "temporary-worktree", "merge via worktree temporario");
  assertEqual(delivered.worktree_removed, true, "worktree da unidade removido");
  assert(!existsSync(delivered.work_tree), "diretorio do worktree removido");
  const mainReal = realpathSync(repo);
  assert(!worktreePaths(repo).some((p) => p !== mainReal), "nenhum worktree residual");
  assert(git(["log", "--oneline", "main"], { cwd: repo }).stdout.includes("entrega worktree"), "merge no development branch");
  const state = JSON.parse(readFileSync(join(repo, ".harness", "workspace", "preflight-states", "feat__demo.json"), "utf8"));
  assertEqual(state.phase, "finish", "state final");
  const again = JSON.parse((await finish(repo, { message: "feat(demo): entrega worktree" })).stdout);
  assertEqual(again.already_delivered, true, "finish repetido idempotente");
});

test("finish worktree: merge na arvore principal quando ela ja esta no dev e esta limpa", async () => {
  const repo = newRepo();
  writeProfile(repo, WORKTREE_PROFILE);
  const report = JSON.parse((await start(repo)).stdout);
  writeIn(report.work_tree, "src/app.txt", "implementacao\n");
  const result = await finish(repo, { message: "feat(demo): merge na principal" });
  assertEqual(result.status, 0, "exit code");
  const delivered = JSON.parse(result.stdout);
  assertEqual(delivered.merge.via, "main-tree", "merge via arvore principal");
  assertEqual(delivered.worktree_removed, true, "worktree removido");
  assert(currentBranch(repo) === "main", "arvore principal no dev");
});

test("finish worktree: arvore principal suja bloqueia o merge direto e preserva o worktree", async () => {
  const repo = newRepo();
  writeProfile(repo, WORKTREE_PROFILE);
  const report = JSON.parse((await start(repo)).stdout);
  writeIn(report.work_tree, "src/app.txt", "implementacao\n");
  writeIn(repo, "rascunho.txt", "edicao local do usuario\n");
  const result = await finish(repo, { message: "feat(demo): merge bloqueado" });
  assertEqual(result.status, 1, "exit code");
  const report2 = JSON.parse(result.stdout);
  assertEqual(report2.step, "merge-main-dirty", "step");
  assert(worktreePaths(repo).length > 1, "worktree da unidade preservado apos falha");
});

test("finish worktree: workspace efemero preserva o worktree; --remove-worktree descarta", async () => {
  const repo = newRepo();
  writeProfile(repo, WORKTREE_PROFILE);
  const report = JSON.parse((await start(repo)).stdout);
  writeIn(report.work_tree, "src/app.txt", "implementacao\n");
  writeIn(report.work_tree, ".harness/workspace/plano.md", "plano efemero\n");
  const kept = JSON.parse((await finish(repo, { message: "feat(demo): mantem worktree" })).stdout);
  assertEqual(kept.worktree_removed, false, "worktree preservado");
  assert(kept.worktree_keep_reason.includes("workspace"), "motivo do worktree preservado");
  assert(existsSync(kept.work_tree), "diretorio preservado");
  const state = JSON.parse(readFileSync(join(repo, ".harness", "workspace", "preflight-states", "feat__demo.json"), "utf8"));
  assertEqual(state.worktree_removed, false, "state registra preservacao");
  assertEqual(JSON.parse((await finish(repo, { message: "feat(demo): repetida" })).stdout).already_delivered, true, "idempotente mesmo com worktree preservado");

  const repo2 = newRepo();
  writeProfile(repo2, WORKTREE_PROFILE);
  const report2 = JSON.parse((await start(repo2)).stdout);
  writeIn(report2.work_tree, "src/app.txt", "implementacao\n");
  writeIn(report2.work_tree, ".harness/workspace/plano.md", "plano efemero\n");
  const removed = JSON.parse((await finish(repo2, { message: "feat(demo): descarta worktree", removeWorktree: true })).stdout);
  assertEqual(removed.worktree_removed, true, "worktree removido com --remove-worktree");
  assert(!existsSync(removed.work_tree), "diretorio removido");
});

test("finish worktree: --include-workspace entrega o workspace e permite a remocao limpa", async () => {
  const repo = newRepo();
  writeProfile(repo, WORKTREE_PROFILE);
  const report = JSON.parse((await start(repo)).stdout);
  writeIn(report.work_tree, "src/app.txt", "implementacao\n");
  writeIn(report.work_tree, ".harness/workspace/plano.md", "plano efemero\n");
  const delivered = JSON.parse((await finish(repo, { message: "feat(demo): com workspace", includeWorkspace: true })).stdout);
  assertEqual(delivered.worktree_removed, true, "worktree removido");
  const files = git(["show", "--name-only", "--format=", `${headHash(repo)}^2`], { cwd: repo }).stdout;
  assert(files.includes(".harness/workspace/plano.md"), "workspace entregue no commit");
});

test("finish worktree: sem state falha com orientacao", async () => {
  const repo = newRepo();
  writeProfile(repo, WORKTREE_PROFILE);
  const result = await finish(repo, { message: "feat(demo): sem start" });
  assertEqual(result.status, 1, "exit code");
  const report = JSON.parse(result.stdout);
  assertEqual(report.step, "state-missing", "step");
});

test("finish worktree: worktree removido manualmente produz worktree-missing", async () => {
  const repo = newRepo();
  writeProfile(repo, WORKTREE_PROFILE);
  const report = JSON.parse((await start(repo)).stdout);
  rmSync(report.work_tree, { recursive: true, force: true });
  git(["worktree", "prune"], { cwd: repo });
  const result = await finish(repo, { message: "feat(demo): worktree sumiu" });
  assertEqual(result.status, 1, "exit code");
  const report2 = JSON.parse(result.stdout);
  assertEqual(report2.step, "worktree-missing", "step");
});

test("finish worktree: invocacao a partir do proprio worktree funciona", async () => {
  const repo = newRepo();
  writeProfile(repo, WORKTREE_PROFILE);
  const report = JSON.parse((await start(repo)).stdout);
  writeIn(report.work_tree, "src/app.txt", "implementacao\n");
  const args = ["finish", "--type", "feat", "--context", "demo", "--message", "feat(demo): dentro do worktree"];
  const result = await runCli(args, { cwd: report.work_tree });
  assertEqual(result.status, 0, "exit code");
  const delivered = JSON.parse(result.stdout);
  assertEqual(delivered.delivered_via, "direct-merge", "entrega");
  assertEqual(delivered.merge.via, "main-tree", "arvore principal limpa e no dev");
});

test("start worktree com remote: sync do dev por fast-forward e entrega com push", async () => {
  const repo = newRepo();
  const remote = newRemote(repo);
  git(["fetch", "origin"], { cwd: repo });
  git(["branch", "--set-upstream-to=origin/main", "main"], { cwd: repo });
  writeProfile(repo, WORKTREE_PROFILE);
  const report = JSON.parse((await start(repo)).stdout);
  assert(worktreePaths(repo).some((p) => p === report.work_tree), "worktree registrado");
  writeIn(report.work_tree, "src/app.txt", "implementacao\n");
  git(["checkout", "-b", "paralelo"], { cwd: repo });
  const result = await finish(repo, { message: "feat(demo): push no merge" });
  assertEqual(result.status, 0, "exit code");
  const delivered = JSON.parse(result.stdout);
  assertEqual(delivered.merge.via, "temporary-worktree", "merge via worktree temporario");
  git(["fetch", "origin"], { cwd: repo });
  assert(git(["rev-parse", "origin/main"], { cwd: repo }).stdout.trim() === git(["rev-parse", "main"], { cwd: repo }).stdout.trim(), "origin/main avancou com o merge");
});

let passed = 0;
const failures = [];
(async () => {
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed += 1;
      console.log(`ok    ${name}`);
    } catch (error) {
      failures.push({ name, error });
      console.error(`FALHA ${name}: ${error.message}`);
    }
  }
  console.log(`\n${passed}/${tests.length} testes passaram`);
  console.log(`artefatos temporarios: ${tempRoot}`);
  if (failures.length > 0) {
    for (const { name } of failures) console.error(`- ${name}`);
    process.exit(1);
  }
})();
