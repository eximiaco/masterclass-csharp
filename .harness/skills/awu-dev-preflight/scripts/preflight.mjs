#!/usr/bin/env node
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fail, reportOk } from "./lib/report.mjs";
import {
  parseSimpleYaml,
  readProfile,
  resolveBranchingConfig,
  ensureBranchingDefaults
} from "./lib/profile.mjs";
import {
  aheadCount,
  branchExists,
  branchTip,
  checkRefFormat,
  currentBranch,
  headCommit,
  listStatus,
  mustGit,
  parseAzureDevOpsRemote,
  parseOriginSlug,
  remoteBranchExists,
  remoteInfo,
  repoRoot,
  runProgram,
  listWorktrees,
  commonRepoRoot,
  tryGit
} from "./lib/git.mjs";

const ALLOWED_TYPES = ["feat", "fix", "perf", "refactor", "docs", "test", "build", "ci", "chore", "revert"];
const WORKSPACE_PREFIX = ".harness/workspace/";
const STATE_FILE = ".harness/workspace/preflight-state.json";
const WORKTREE_STATE_DIR = ".harness/workspace/preflight-states";
const DEFAULT_PROFILE = join(".harness", "project-profile.yaml");
const MAX_CONTEXT_LENGTH = 64;
const MAX_BRANCH_LENGTH = 100;
const CONVENTIONAL_RE = /^(feat|fix|perf|refactor|docs|test|build|ci|chore|revert)(\([^)]+\))?!?: .+$/;

const USAGE = `Uso:
  node preflight.mjs start   --type <tipo> --context <contexto> [--repo <caminho>] [--profile <caminho>] [--dry-run]
  node preflight.mjs finish  --type <tipo> --context <contexto> --message "<commit>" [--pr-title <t>] [--pr-body <texto>]
                             [--repo <caminho>] [--profile <caminho>] [--dry-run] [--include-workspace]
                             [--remove-worktree] [--keep-worktree]

Tipos permitidos: ${ALLOWED_TYPES.join(", ")}. Contexto em kebab-case (ex.: user-authentication).`;

let currentPhase = null;
let currentStep = "startup";

function step(name) {
  currentStep = name;
}

const SUGGESTIONS = {
  "git-fetch": [
    "Verifique rede e credenciais do remote (git remote -v; git ls-remote origin).",
    "Se a rede estiver indisponivel, informe o usuario; nao use alternativas destrutivas."
  ],
  "pull": [
    "A branch local divergiu da origin: investigue com git log --oneline --graph HEAD...origin/<branch>.",
    "Enviar ou reconciliar commits locais e decisao do usuario; nunca force push nem descarte commits."
  ],
  "worktree-clean": [
    "Revise com o usuario as alteracoes listadas em repo_state.dirty_files antes de commitar ou arquivar.",
    "Nao descarte alteracoes locais: commitar ou arquivar (stash) e decisao do usuario."
  ],
  "work-branch-exists": [
    "Se a branch existente for a continuacao esperada, faca checkout manual dela e reexecute a fase.",
    "Se for residuo de outra execucao, o usuario decide o destino; nunca exclua a branch."
  ],
  "pr-gh-missing": [
    "Instale/autentique o GitHub CLI (gh auth login) e reexecute a fase.",
    "Alternativa segura: abrir o PR manualmente pela compare_url informada, ou trocar open_pr para false (decisao do usuario)."
  ],
  "pr-ado-pat": [
    "Defina a variavel de ambiente AZURE_DEVOPS_PAT (PAT com permissao Code Read & Write e criacao de pull request) e reexecute a fase.",
    "Alternativa segura: abrir o PR manualmente pela URL pullrequestcreate informada, ou trocar open_pr para false (decisao do usuario)."
  ],
  "pr-remote-provider": [
    "Confirme pr_provider no project profile (github ou azure-devops) conforme o remote origin.",
    "Corrigir o remote ou o profile e decisao segura; nunca altere historico ou faca force push."
  ],
  "merge-conflict": [
    "Resolva o conflito manualmente na branch de trabalho com o usuario; a skill nao rebasa nem descarta."
  ],
  "read-profile": [
    "Corrija o YAML do project profile; a correcao e segura e nao afeta o codigo.",
    "Sem profile valido, reexecute a skill generate-application-context ou solicite decisao ao usuario."
  ]
};

function baseSuggestions() {
  return [
    "Analise o JSON de erro (command, stdout, stderr) para identificar a causa raiz antes de qualquer acao.",
    "Tente no maximo 2 correcoes seguras e reexecute a fase; se persistir, interrompa e decida com o usuario."
  ];
}

function parseArgs(argv) {
  const [phase, ...rest] = argv;
  if (phase !== "start" && phase !== "finish") {
    fail({ phase: "cli", step: "usage", message: `fase invalida: ${JSON.stringify(phase ?? "")}`, usage: USAGE });
  }
  const opts = { phase, repo: process.cwd(), includeWorkspace: false, dryRun: false };
  let index = 0;
  while (index < rest.length) {
    const flag = rest[index];
    const value = () => {
      index += 1;
      if (index >= rest.length) fail({ phase: "cli", step: "usage", message: `flag ${flag} exige valor`, usage: USAGE });
      return rest[index];
    };
    switch (flag) {
      case "--repo": opts.repo = value(); break;
      case "--profile": opts.profile = value(); break;
      case "--type": opts.type = value(); break;
      case "--context": opts.context = value(); break;
      case "--message": opts.message = value(); break;
      case "--pr-title": opts.prTitle = value(); break;
      case "--pr-body": opts.prBody = value(); break;
      case "--dry-run": opts.dryRun = true; break;
      case "--include-workspace": opts.includeWorkspace = true; break;
      case "--remove-worktree": opts.removeWorktree = true; break;
      case "--keep-worktree": opts.keepWorktree = true; break;
      default:
        fail({ phase: "cli", step: "usage", message: `opcao desconhecida: ${flag}`, usage: USAGE });
    }
    index += 1;
  }
  if (opts.removeWorktree && opts.keepWorktree) {
    fail({ phase: "cli", step: "usage", message: "--remove-worktree e --keep-worktree sao excludentes", usage: USAGE });
  }
  return opts;
}

function requireType(opts) {
  const raw = (opts.type ?? "").trim().toLowerCase();
  if (!raw) fail({ phase: currentPhase, step: "arguments", message: "--type e obrigatorio", usage: USAGE });
  if (!ALLOWED_TYPES.includes(raw)) {
    fail({
      phase: currentPhase,
      step: "arguments",
      message: `tipo invalido: ${JSON.stringify(raw)}`,
      allowed_types: ALLOWED_TYPES,
      suggestions: [
        raw === "bugfix"
          ? "Conventional Commits usa fix; reexecute com --type fix."
          : "Reexecute com um dos tipos listados em allowed_types."
      ]
    });
  }
  return raw;
}

function requireContext(opts) {
  const raw = (opts.context ?? "").trim().toLowerCase();
  if (!raw) fail({ phase: currentPhase, step: "arguments", message: "--context e obrigatorio", usage: USAGE });
  if (raw.length > MAX_CONTEXT_LENGTH) {
    fail({ phase: currentPhase, step: "arguments", message: `contexto maior que ${MAX_CONTEXT_LENGTH} caracteres` });
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(raw)) {
    fail({
      phase: currentPhase,
      step: "arguments",
      message: `contexto deve ser kebab-case ([a-z0-9] com hifens); valor recebido: ${JSON.stringify(opts.context)}`,
      suggestions: ["Normalize o contexto (nome da feature ou do Agent Work Unit) para kebab-case e reexecute."]
    });
  }
  return raw;
}

function computeWorkBranch(template, type, context, base) {
  step("work-branch-name");
  const name = template.replaceAll("{type}", type).replaceAll("{context}", context);
  if (name.length > MAX_BRANCH_LENGTH) {
    fail({ phase: currentPhase, step: "work-branch-name", message: `nome de branch maior que ${MAX_BRANCH_LENGTH} caracteres: ${name}` });
  }
  if (!checkRefFormat(base, name)) {
    fail({
      phase: currentPhase,
      step: "work-branch-name",
      message: `nome de branch invalido para o git: ${JSON.stringify(name)}`,
      suggestions: ["Ajuste work_branch_template no project profile para produzir nomes validos (ex.: {type}/{context})."]
    });
  }
  return name;
}

function repoSnapshot(base, extra = {}) {
  return { branch: currentBranch(base), head: headCommit(base), ...extra };
}

function statePath(base) {
  return join(base, STATE_FILE);
}

function loadState(base) {
  try {
    return JSON.parse(readFileSync(statePath(base), "utf8"));
  } catch {
    return null;
  }
}

function persistState(base, data) {
  const path = statePath(base);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}

function worktreeStatePath(base, type, context) {
  return join(base, WORKTREE_STATE_DIR, `${type}__${context}.json`);
}

function loadWorktreeState(base, type, context) {
  try {
    return JSON.parse(readFileSync(worktreeStatePath(base, type, context), "utf8"));
  } catch {
    return null;
  }
}

function persistWorktreeState(base, type, context, data) {
  const path = worktreeStatePath(base, type, context);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}

function worktreeDirFor(base, config, type, context) {
  return join(base, config.worktree.path, `${type}__${context}`);
}

function registeredWorktreeFor(base, workBranch, wtDir) {
  const normalizedWtDir = resolve(wtDir);
  return listWorktrees(base).find(
    (wt) => wt.branch === workBranch || resolve(wt.path) === normalizedWtDir
  );
}

// Worktrees vivem dentro da arvore principal; sem o ignore, o status do repositorio
// principal passa a exibir a copia inteira como nao rastreada. O ignore fica em
// .git/info/exclude: local, idempotente e sem exigir commit no repositorio consumidor.
function ensureWorktreeIgnore(base, worktreePathRel) {
  const excludePath = join(base, ".git", "info", "exclude");
  const line = `${worktreePathRel}/`;
  let content = "";
  try {
    content = readFileSync(excludePath, "utf8");
  } catch {
    content = "";
  }
  if (content.split(/\r?\n/).map((entry) => entry.trim()).includes(line)) return false;
  mkdirSync(dirname(excludePath), { recursive: true });
  const prefix = content === "" || content.endsWith("\n") ? "" : "\n";
  writeFileSync(excludePath, `${content}${prefix}${line}\n`, "utf8");
  return true;
}

function nonWorkspace(entries) {
  return entries.filter((entry) => !entry.path.startsWith(WORKSPACE_PREFIX));
}

function managedFile(profilePath, base) {
  const rel = relative(base, profilePath);
  return rel.startsWith("..") ? null : rel;
}

function blockersOutsideWorkspace(entries, profileRel) {
  return entries.filter(
    (entry) => !entry.path.startsWith(WORKSPACE_PREFIX) && entry.path !== profileRel
  );
}

function workspaceOnly(entries) {
  return entries.filter((entry) => entry.path.startsWith(WORKSPACE_PREFIX));
}

function statusList(entries) {
  return entries.map((entry) => `${entry.x}${entry.y} ${entry.path}`);
}

function resolveRepoAndProfile(opts, phase) {
  step("resolve-repo");
  const invocationRoot = repoRoot(opts.repo);
  if (!invocationRoot) {
    fail({
      phase,
      step: "resolve-repo",
      message: `o caminho informado nao e um repositorio git: ${JSON.stringify(resolve(opts.repo))}`
    });
  }
  const base = commonRepoRoot(invocationRoot) ?? invocationRoot;
  const profilePath = opts.profile ? resolve(opts.profile) : join(base, DEFAULT_PROFILE);
  step("read-profile");
  try {
    const resolved = resolveBranchingConfig(readProfile(profilePath));
    return { base, invocationRoot, profilePath, resolved };
  } catch (error) {
    fail({
      phase,
      step: "read-profile",
      message: `project profile invalido ou ilegivel: ${error.message}`,
      profile: profilePath,
      suggestions: SUGGESTIONS["read-profile"]
    });
  }
}

const WORKTREE_INVOCATION_SUGGESTIONS = [
  "Execute a fase a partir do repositorio principal (fora de .harness/worktrees) ou informe --repo com o caminho do repositorio principal.",
  "Execucoes em modo worktree podem invocar finish a partir da propria worktree da work unit."
];

function firstLine(text) {
  if (!text) return null;
  return text.split("\n", 1)[0].trim();
}

function compareUrl(url, baseBranch, headBranch) {
  const slug = parseOriginSlug(url);
  if (!slug) return null;
  return `https://github.com/${slug}/compare/${baseBranch}...${encodeURIComponent(headBranch)}?expand=1`;
}

function pullRequestCreateUrl(ado, devBranch, workBranch) {
  return `${ado.web_base}/${ado.project}/_git/${ado.repo}/pullrequestcreate?sourceRef=${encodeURIComponent(workBranch)}&targetRef=${encodeURIComponent(devBranch)}`;
}

function adoPullRequestUrl(ado, pr) {
  const link = pr?._links?.web?.href;
  if (link) return link;
  if (pr?.pullRequestId != null) {
    return `${ado.web_base}/${ado.project}/_git/${ado.repo}/pullrequest/${pr.pullRequestId}`;
  }
  return null;
}

function startCommand(opts) {
  const phase = "start";
  const { base, invocationRoot, profilePath, resolved } = resolveRepoAndProfile(opts, phase);
  const config = resolved.config;
  const type = requireType(opts);
  const context = requireContext(opts);
  const workBranch = computeWorkBranch(config.work_branch_template, type, context, base);

  if (config.worktree.enabled) {
    return startWorktree({ phase, base, invocationRoot, profilePath, config, type, context, workBranch, opts });
  }

  if (invocationRoot !== base) {
    fail({
      phase,
      step: "worktree-invocation",
      message: "o diretorio atual e um git worktree; a execucao legacy (version_control.worktree.enabled=false) opera apenas no repositorio principal",
      suggestions: WORKTREE_INVOCATION_SUGGESTIONS
    });
  }

  const remote = remoteInfo(base);
  const statusEntries = listStatus(base);
  const profileRel = managedFile(profilePath, base);
  const workspaceEntries = workspaceOnly(statusEntries);
  const managedEntries = profileRel ? statusEntries.filter((entry) => entry.path === profileRel) : [];
  const blocking = blockersOutsideWorkspace(statusEntries, profileRel);
  const current = currentBranch(base);

  if (current === workBranch) {
    const ensured = opts.dryRun
      ? { created: false, changed: false, added_keys: [] }
      : ensureBranchingDefaults(profilePath, config);
    if (!opts.dryRun) {
      persistState(base, {
        phase: "start",
        strategy: config.strategy,
        development_branch: config.development_branch,
        work_branch: workBranch,
        type,
        context,
        open_pr: config.open_pr,
        pr_provider: config.pr_provider,
        started_at: new Date().toISOString()
      });
    }
    reportOk({
      phase,
      repo_root: base,
      already_started: true,
      strategy: config.strategy,
      development_branch: config.development_branch,
      work_branch: workBranch,
      work_branch_action: "already-current",
      open_pr: config.open_pr,
      pr_provider: config.pr_provider,
      config,
      workspace_files_ignored: workspaceEntries.map((entry) => entry.path),
      managed_files_ignored: managedEntries.map((entry) => entry.path),
      profile: {
        path: profilePath,
        created: ensured.created,
        updated: ensured.changed,
        added_keys: ensured.added_keys
      },
      next_steps: [
        "Executar a implementacao das Agent Work Units sobre a branch de trabalho.",
        "Ao final, invocar a fase finish."
      ]
    });
  }

  if (blocking.length > 0) {
    fail({
      phase,
      step: "worktree-clean",
      message: "a arvore de trabalho possui alteracoes nao confirmadas fora do workspace efemero",
      repo_state: {
        ...repoSnapshot(base),
        dirty_files: blocking.map((entry) => `${entry.x}${entry.y} ${entry.path}`),
        workspace_files_ignored: workspaceEntries.map((entry) => entry.path),
        managed_files_ignored: managedEntries.map((entry) => entry.path)
      },
      suggestions: [...SUGGESTIONS["worktree-clean"], ...baseSuggestions()]
    });
  }

  if (opts.dryRun) {
    reportOk({
      phase,
      dry_run: true,
      repo_root: base,
      plan: [
        remote.present ? "git fetch origin" : "(fetch pulado: sem remote)",
        `git checkout ${config.development_branch}`,
        remote.present ? `git pull --ff-only origin ${config.development_branch}` : "(pull pulado: sem remote)",
        `git checkout -b ${workBranch} (a partir de ${config.development_branch})`,
        `garantir defaults de version_control.branching em ${profilePath}`
      ],
      config,
      work_branch: workBranch,
      development_branch: config.development_branch
    });
  }

  const steps = [];
  if (remote.present) {
    step("git-fetch");
    const result = tryGit(["fetch", "origin"], { cwd: base });
    steps.push({ step: "fetch", ok: result.code === 0 });
    if (result.code !== 0) {
      fail({
        phase,
        step: "git-fetch",
        message: "git fetch origin falhou",
        command: "git fetch origin",
        exit_code: result.code,
        stdout: result.stdout,
        stderr: result.stderr,
        repo_state: repoSnapshot(base),
        suggestions: [...SUGGESTIONS["git-fetch"], ...baseSuggestions()]
      });
    }
  }

  step("checkout-development");
  if (!branchExists(base, config.development_branch)) {
    if (remote.present && remoteBranchExists(base, config.development_branch)) {
      mustGit(["checkout", "--track", `origin/${config.development_branch}`], { cwd: base });
      steps.push({ step: "checkout-development", detail: `criada a partir de origin/${config.development_branch}` });
    } else {
      fail({
        phase,
        step: "checkout-development",
        message: `branch de desenvolvimento ${JSON.stringify(config.development_branch)} nao existe localmente nem em origin`,
        repo_state: {
          ...repoSnapshot(base),
          branches: tryGit(["branch", "--list"], { cwd: base }).stdout.trim().split("\n").filter(Boolean)
        },
        suggestions: [
          `Confirme development_branch no project profile (main para trunk-based, develop para git-flow).`,
          "Se o repositorio ainda nao tem essa branch, a criacao e decisao do usuario."
        ]
      });
    }
  }
  if (currentBranch(base) !== config.development_branch) {
    mustGit(["checkout", config.development_branch], { cwd: base });
    steps.push({ step: "checkout-development", detail: config.development_branch });
  }

  if (remote.present) {
    step("pull");
    const command = ["pull", "--ff-only", "origin", config.development_branch];
    const result = tryGit(command, { cwd: base });
    steps.push({ step: "pull", ok: result.code === 0 });
    if (result.code !== 0) {
      fail({
        phase,
        step: "pull",
        message: `git ${command.join(" ")} falhou`,
        command: `git ${command.join(" ")}`,
        exit_code: result.code,
        stdout: result.stdout,
        stderr: result.stderr,
        repo_state: repoSnapshot(base),
        suggestions: [...SUGGESTIONS["pull"], ...baseSuggestions()]
      });
    }
  }

  const devTip = branchTip(base, config.development_branch);
  step("work-branch");
  let workAction = "created";
  if (branchExists(base, workBranch)) {
    if (branchTip(base, workBranch) === devTip) {
      mustGit(["checkout", workBranch], { cwd: base });
      workAction = "reused";
      steps.push({ step: "work-branch", detail: `${workBranch} reaproveitada (sem commits) e sincronizada` });
    } else {
      fail({
        phase,
        step: "work-branch-exists",
        message: `a branch de trabalho ${JSON.stringify(workBranch)} ja existe e possui commits`,
        repo_state: {
          ...repoSnapshot(base),
          work_branch_tip: branchTip(base, workBranch),
          development_branch_tip: devTip
        },
        suggestions: [...SUGGESTIONS["work-branch-exists"], ...baseSuggestions()]
      });
    }
  } else {
    if (remote.present && remoteBranchExists(base, workBranch)) {
      fail({
        phase,
        step: "work-branch-exists",
        message: `a branch de trabalho ${JSON.stringify(workBranch)} ja existe em origin`,
        repo_state: repoSnapshot(base),
        suggestions: [...SUGGESTIONS["work-branch-exists"], ...baseSuggestions()]
      });
    }
    mustGit(["checkout", "-b", workBranch], { cwd: base });
    steps.push({ step: "work-branch", detail: `criada a partir de ${config.development_branch}` });
  }

  step("ensure-profile-defaults");
  const ensured = ensureBranchingDefaults(profilePath, config);
  steps.push({ step: "ensure-profile-defaults", changed: ensured.changed, added_keys: ensured.added_keys });

  persistState(base, {
    phase: "start",
    strategy: config.strategy,
    development_branch: config.development_branch,
    work_branch: workBranch,
    type,
    context,
    open_pr: config.open_pr,
    pr_provider: config.pr_provider,
    started_at: new Date().toISOString()
  });

  reportOk({
    phase,
    repo_root: base,
    strategy: config.strategy,
    development_branch: config.development_branch,
    work_branch: workBranch,
    work_branch_action: workAction,
    open_pr: config.open_pr,
    pr_provider: config.pr_provider,
    config,
    remote,
    steps,
    profile: {
      path: profilePath,
      created: ensured.created,
      updated: ensured.changed,
      added_keys: ensured.added_keys
    },
    next_steps: [
      "Executar a implementacao das Agent Work Units sobre a branch de trabalho.",
      "Nao alterar a branch de desenvolvimento manualmente durante a execucao.",
      "Ao final, invocar a fase finish."
    ]
  });
}

function startWorktree({ phase, base, invocationRoot, profilePath, config, type, context, workBranch, opts }) {
  const wtConfig = config.worktree;
  const dev = config.development_branch;
  const wtDir = worktreeDirFor(base, config, type, context);
  const wtDirRel = `${wtConfig.path}/${type}__${context}`;
  const remote = remoteInfo(base);
  const state = loadWorktreeState(base, type, context);
  const registered = listWorktrees(base);
  const existingByBranch = registered.find((wt) => wt.branch === workBranch);
  const existingByDir = registered.find((wt) => resolve(wt.path) === resolve(wtDir));

  if (state?.phase === "start" && existingByBranch) {
    return reportOk({
      phase,
      repo_root: base,
      work_tree: existingByBranch.path,
      already_started: true,
      strategy: config.strategy,
      development_branch: dev,
      work_branch: workBranch,
      work_branch_action: "reused",
      worktree_action: "reused",
      open_pr: config.open_pr,
      pr_provider: config.pr_provider,
      config,
      remote,
      next_steps: [
        "Continuar a execucao das Agent Work Units dentro do worktree informado em work_tree.",
        "Ao final, invocar a fase finish (pode ser a partir do worktree)."
      ]
    });
  }

  if (invocationRoot !== base) {
    fail({
      phase,
      step: "worktree-invocation",
      message: "start em modo worktree deve ser executado a partir do repositorio principal",
      suggestions: WORKTREE_INVOCATION_SUGGESTIONS
    });
  }

  if (currentBranch(base) === workBranch) {
    fail({
      phase,
      step: "worktree-main-conflict",
      message: `a arvore principal esta na branch de trabalho ${JSON.stringify(workBranch)}; o git nao permite a mesma branch em duas arvores de trabalho`,
      repo_state: repoSnapshot(base),
      suggestions: [
        `Com decisao do usuario, mova a arvore principal para ${dev} (git checkout ${dev}) e reexecute a fase start.`,
        "Nao descarte alteracoes nao confirmadas: confirmar ou arquivar e decisao do usuario."
      ]
    });
  }

  if (opts.dryRun) {
    reportOk({
      phase,
      dry_run: true,
      repo_root: base,
      work_tree: wtDir,
      worktree: { path: wtConfig.path, dir: wtDir },
      plan: [
        remote.present ? "git fetch origin" : "(fetch pulado: sem remote)",
        `garantir ${dev} local (criada de origin/${dev} se ausente; fast-forward ${dev}:${dev} quando a branch nao estiver checked out)`,
        branchExists(base, workBranch)
          ? `git worktree add ${wtDirRel} ${workBranch} (branch existente reutilizada no worktree)`
          : `git worktree add -b ${workBranch} ${wtDirRel} ${dev}`,
        `registrar ${wtDirRel}/ em .git/info/exclude`,
        `garantir defaults de version_control.branching em ${profilePath}`
      ],
      config,
      work_branch: workBranch,
      development_branch: dev,
      next_steps: ["Reexecute sem --dry-run para criar o worktree."]
    });
  }

  const steps = [];
  if (remote.present) {
    step("git-fetch");
    const result = tryGit(["fetch", "origin"], { cwd: base });
    steps.push({ step: "fetch", ok: result.code === 0 });
    if (result.code !== 0) {
      fail({
        phase,
        step: "git-fetch",
        message: "git fetch origin falhou",
        command: "git fetch origin",
        exit_code: result.code,
        stdout: result.stdout,
        stderr: result.stderr,
        repo_state: repoSnapshot(base),
        suggestions: [...SUGGESTIONS["git-fetch"], ...baseSuggestions()]
      });
    }
  }

  step("development-branch");
  if (!branchExists(base, dev)) {
    if (remote.present && remoteBranchExists(base, dev)) {
      mustGit(["branch", dev, `origin/${dev}`], { cwd: base });
      steps.push({ step: "development-branch", detail: `criada a partir de origin/${dev} sem checkout` });
    } else {
      fail({
        phase,
        step: "development-branch",
        message: `branch de desenvolvimento ${JSON.stringify(dev)} nao existe localmente nem em origin`,
        repo_state: {
          ...repoSnapshot(base),
          branches: tryGit(["branch", "--list"], { cwd: base }).stdout.trim().split("\n").filter(Boolean)
        },
        suggestions: [
          `Confirme development_branch no project profile (main para trunk-based, develop para git-flow).`,
          "Se o repositorio ainda nao tem essa branch, a criacao e decisao do usuario."
        ]
      });
    }
  }
  if (remote.present) {
    // Fast-forward da branch de desenvolvimento sem checkout: so atualiza o ref
    // quando a branch nao esta checked out em nenhuma arvore de trabalho.
    const ff = tryGit(["fetch", "origin", `${dev}:${dev}`], { cwd: base });
    if (ff.code === 0) {
      steps.push({ step: "development-branch-sync", detail: `${dev} atualizada por fast-forward para origin/${dev}` });
    } else {
      steps.push({
        step: "development-branch-sync",
        detail: `${dev} mantida no tip local (checked out em outra arvore de trabalho); o finish reconciliara com origin antes da entrega`
      });
    }
  }
  const devTip = branchTip(base, dev);

  step("work-branch");
  let workAction = "created";
  if (branchExists(base, workBranch)) {
    if (branchTip(base, workBranch) === devTip) {
      workAction = "reused";
    } else if (state?.phase === "start") {
      workAction = "restored";
    } else {
      fail({
        phase,
        step: "work-branch-exists",
        message: `a branch de trabalho ${JSON.stringify(workBranch)} ja existe e possui commits`,
        repo_state: {
          ...repoSnapshot(base),
          work_branch_tip: branchTip(base, workBranch),
          development_branch_tip: devTip
        },
        suggestions: [...SUGGESTIONS["work-branch-exists"], ...baseSuggestions()]
      });
    }
  } else if (remote.present && remoteBranchExists(base, workBranch)) {
    fail({
      phase,
      step: "work-branch-exists",
      message: `a branch de trabalho ${JSON.stringify(workBranch)} ja existe em origin`,
      repo_state: repoSnapshot(base),
      suggestions: [...SUGGESTIONS["work-branch-exists"], ...baseSuggestions()]
    });
  }

  step("worktree-add");
  if (existingByBranch) {
    fail({
      phase,
      step: "worktree-add",
      message: `a branch de trabalho ${JSON.stringify(workBranch)} ja esta em uso no worktree ${existingByBranch.path}`,
      repo_state: { ...repoSnapshot(base), worktree_path: existingByBranch.path },
      suggestions: [
        "Se o worktree pertence a esta work unit, finalize ou retome a execucao nele.",
        "Se for residuo de outra execucao, o destino do worktree e decisao do usuario; nunca exclua a branch."
      ]
    });
  }
  if (existingByDir) {
    fail({
      phase,
      step: "worktree-path-exists",
      message: `o caminho ${JSON.stringify(wtDirRel)} esta em uso pelo worktree da branch ${JSON.stringify(existingByDir.branch ?? "(detached)")}`,
      repo_state: { ...repoSnapshot(base), worktree_path: existingByDir.path },
      suggestions: [
        "Cada work unit usa um worktree proprio em version_control.worktree.path; libere o caminho com decisao do usuario.",
        "Se o worktree e residuo solto (diretorio sem registro git), a remocao manual e decisao do usuario."
      ]
    });
  }
  const worktreeArgs = branchExists(base, workBranch)
    ? ["worktree", "add", wtDir, workBranch]
    : ["worktree", "add", "-b", workBranch, wtDir, dev];
  const addResult = tryGit(worktreeArgs, { cwd: base });
  if (addResult.code !== 0) {
    fail({
      phase,
      step: "worktree-add",
      message: "git worktree add falhou",
      command: `git ${worktreeArgs.join(" ")}`,
      exit_code: addResult.code,
      stdout: addResult.stdout,
      stderr: addResult.stderr,
      repo_state: repoSnapshot(base),
      suggestions: [
        "Inspecione git worktree list para conflitos de branch ou caminho.",
        "Se a correcao envolver descartar dados, interrompa e decida com o usuario."
      ]
    });
  }
  steps.push({
    step: "worktree-add",
    detail:
      workAction === "created"
        ? `${wtDirRel} criado a partir de ${dev}`
        : `${wtDirRel} ${workAction === "restored" ? "recriado para execucao retomada" : "criado para branch existente"} (${workBranch})`
  });

  step("worktree-ignore");
  if (ensureWorktreeIgnore(base, wtConfig.path)) {
    steps.push({ step: "worktree-ignore", detail: `${wtConfig.path}/ registrado em .git/info/exclude` });
  }

  step("ensure-profile-defaults");
  const ensured = ensureBranchingDefaults(profilePath, config);
  steps.push({ step: "ensure-profile-defaults", changed: ensured.changed, added_keys: ensured.added_keys });

  persistWorktreeState(base, type, context, {
    phase: "start",
    strategy: config.strategy,
    development_branch: dev,
    work_branch: workBranch,
    worktree_path: wtDirRel,
    type,
    context,
    open_pr: config.open_pr,
    pr_provider: config.pr_provider,
    started_at: new Date().toISOString()
  });

  reportOk({
    phase,
    repo_root: base,
    work_tree: wtDir,
    strategy: config.strategy,
    development_branch: dev,
    work_branch: workBranch,
    work_branch_action: workAction,
    worktree: { path: wtConfig.path, dir: wtDir, action: workAction },
    open_pr: config.open_pr,
    pr_provider: config.pr_provider,
    config,
    remote,
    steps,
    profile: {
      path: profilePath,
      created: ensured.created,
      updated: ensured.changed,
      added_keys: ensured.added_keys
    },
    next_steps: [
      `Executar a implementacao das Agent Work Units dentro do worktree (cd ${wtDir}).`,
      "A arvore principal permanece na branch de desenvolvimento e pode executar outras work units em paralelo.",
      "Ao final, invocar a fase finish informando --type e --context."
    ]
  });
}

function validateCommitMessage(message, profile, phase) {
  step("validate-commit-message");
  const header = firstLine(message) ?? "";
  if (!header) {
    fail({ phase, step: "commit-message", message: "a primeira linha da mensagem de commit e obrigatoria" });
  }
  let style = null;
  let maxLength = null;
  try {
    const data = parseSimpleYaml(profile.text ?? "");
    style = data?.version_control?.commits?.style ?? null;
    maxLength = data?.version_control?.commits?.header_max_length ?? null;
  } catch {
    // secoes de commit ausentes usam o padrao
  }
  if (style === "conventional" && !CONVENTIONAL_RE.test(header)) {
    fail({
      phase,
      step: "commit-message",
      message: `a mensagem de commit nao segue Conventional Commits: ${JSON.stringify(header)}`,
      suggestions: ["Reexecute com --message no formato <tipo>(<contexto>): descricao."]
    });
  }
  if (Number.isInteger(maxLength) && header.length > maxLength) {
    fail({
      phase,
      step: "commit-message",
      message: `o cabecalho do commit excede header_max_length=${maxLength} (${header.length} caracteres)`,
      suggestions: ["Encurte o cabecalho e mova detalhes para o corpo da mensagem."]
    });
  }
}

async function finishCommand(opts) {
  const phase = "finish";
  const { base, invocationRoot, profilePath, resolved } = resolveRepoAndProfile(opts, phase);
  const config = resolved.config;

  if (config.worktree.enabled) {
    return finishWorktree({ phase, base, invocationRoot, profilePath, config, opts });
  }

  if (invocationRoot !== base) {
    fail({
      phase,
      step: "worktree-invocation",
      message: "o diretorio atual e um git worktree; a execucao legacy (version_control.worktree.enabled=false) opera apenas no repositorio principal",
      suggestions: WORKTREE_INVOCATION_SUGGESTIONS
    });
  }

  const profile = readProfile(profilePath);
  const state = loadState(base);
  const type = opts.type ? requireType(opts) : state?.type ?? null;
  const context = opts.context ? requireContext(opts) : state?.context ?? null;
  let workBranch = null;
  if (type && context) {
    workBranch = computeWorkBranch(config.work_branch_template, type, context, base);
  } else if (state?.work_branch) {
    workBranch = state.work_branch;
  } else {
    fail({
      phase,
      step: "work-branch-name",
      message: "branch de trabalho desconhecida: informe --type e --context ou execute a fase start antes",
      usage: USAGE
    });
  }

  const dev = config.development_branch;
  const remote = remoteInfo(base);
  const current = currentBranch(base);

  if (current !== workBranch) {
    const profileRel = managedFile(profilePath, base);
    const statusBefore = listStatus(base);
    const blocking = blockersOutsideWorkspace(statusBefore, profileRel);
    if (blocking.length > 0) {
      fail({
        phase,
        step: "work-branch-checkout",
        message: `a entrega deve ocorrer na branch de trabalho ${JSON.stringify(workBranch)}, mas a arvore tem alteracoes nao confirmadas`,
        repo_state: {
          ...repoSnapshot(base),
          dirty_files: blocking.map((entry) => `${entry.x}${entry.y} ${entry.path}`),
          managed_files_ignored: profileRel ? statusBefore.filter((entry) => entry.path === profileRel).map((entry) => entry.path) : []
        },
        suggestions: [
          `Com decisao do usuario, confirme ou arquive as alteracoes e faca checkout manual em ${workBranch}.`
        ]
      });
    }
    if (!branchExists(base, workBranch)) {
      fail({
        phase,
        step: "work-branch-checkout",
        message: `a branch de trabalho ${JSON.stringify(workBranch)} nao existe; execute a fase start antes da finish`,
        repo_state: repoSnapshot(base)
      });
    }
    step("checkout-work-branch");
    if (!opts.dryRun) mustGit(["checkout", workBranch], { cwd: base });
  }

  if (opts.message) validateCommitMessage(opts.message, profile, phase);

  step("stage");
  const statusEntries = listStatus(base);
  const deliverable = opts.includeWorkspace ? statusEntries : nonWorkspace(statusEntries);
  const stagedPaths = deliverable.map((entry) => entry.path);

  if (opts.dryRun) {
    reportOk({
      phase,
      dry_run: true,
      repo_root: base,
      work_branch: workBranch,
      development_branch: dev,
      open_pr: config.open_pr,
      files_to_commit: stagedPaths,
      plan: [
        stagedPaths.length ? "git add -- <arquivos listados> && git commit -m <message>" : "(nada a commitar; seguindo para entrega)",
        remote.present ? `git push -u origin ${workBranch}` : "(push pulado: sem remote)",
        config.open_pr
          ? config.pr_provider === "azure-devops"
            ? `criar pull request na API do Azure DevOps (${dev} <- ${workBranch}; PAT via AZURE_DEVOPS_PAT)`
            : `gh pr create --base ${dev} --head ${workBranch}`
          : `git merge --no-ff ${workBranch} em ${dev} + git push origin ${dev}`
      ],
      next_steps: ["Reexecute sem --dry-run para entregar."]
    });
  }

  if (stagedPaths.length > 0 && !opts.message) {
    fail({
      phase,
      step: "commit-message",
      message: "--message e obrigatorio quando existem alteracoes a commitar",
      repo_state: { ...repoSnapshot(base), files_to_commit: stagedPaths }
    });
  }

  const steps = [];
  if (stagedPaths.length > 0) {
    step("git-add");
    mustGit(["add", "--", ...stagedPaths], { cwd: base });
    step("git-commit");
    mustGit(["commit", "-m", opts.message], { cwd: base });
    steps.push({ step: "commit", detail: firstLine(opts.message), hash: headCommit(base) });
  }

  const ahead = aheadCount(base, dev, workBranch);
  if (stagedPaths.length === 0 && (ahead === null || ahead === 0)) {
    fail({
      phase,
      step: "nothing-to-deliver",
      message: "nada a entregar: a branch de trabalho nao tem commits alem da branch de desenvolvimento",
      repo_state: repoSnapshot(base),
      suggestions: ["Execute a implementacao das Agent Work Units antes de invocar a fase finish."]
    });
  }

  const commitHash = headCommit(base);

  if (remote.present) {
    step("push-work-branch");
    const command = ["push", "-u", "origin", workBranch];
    const result = tryGit(command, { cwd: base });
    steps.push({ step: "push-work-branch", ok: result.code === 0 });
    if (result.code !== 0) {
      fail({
        phase,
        step: "push-work-branch",
        message: `git ${command.join(" ")} falhou`,
        command: `git ${command.join(" ")}`,
        exit_code: result.code,
        stdout: result.stdout,
        stderr: result.stderr,
        repo_state: { ...repoSnapshot(base), commit: commitHash },
        suggestions: [
          "Verifique credenciais do remote (gh auth status para GitHub; AZURE_DEVOPS_PAT para Azure DevOps; git remote -v).",
          "Se origin ja tiver a branch com historico divergente, a reconciliacao e decisao do usuario; nunca use force push.",
          ...baseSuggestions()
        ]
      });
    }
  }

  const delivery = config.open_pr
    ? await deliverByPullRequest(base, config, workBranch, remote, opts, commitHash, phase)
    : deliverByMerge(base, config, workBranch, remote, phase);

  persistState(base, {
    ...(state ?? {}),
    phase: "finish",
    strategy: config.strategy,
    development_branch: dev,
    work_branch: workBranch,
    type,
    context,
    open_pr: config.open_pr,
    pr_provider: config.pr_provider,
    delivered_via: delivery.delivered_via,
    delivered_at: new Date().toISOString(),
    ...(delivery.pull_request ? { pull_request: delivery.pull_request } : {}),
    ...(delivery.merge ? { merge: delivery.merge } : {})
  });

  reportOk({
    phase,
    repo_root: base,
    work_branch: workBranch,
    development_branch: dev,
    delivered_via: delivery.delivered_via,
    commit: stagedPaths.length > 0 ? { hash: commitHash, message: opts.message } : null,
    files_committed: stagedPaths,
    workspace_files_excluded: opts.includeWorkspace ? [] : workspaceOnly(statusEntries).map((entry) => entry.path),
    remote,
    pull_request: delivery.pull_request ?? null,
    merge: delivery.merge ?? null,
    work_branch_removed: false,
    steps,
    next_steps: delivery.next_steps
  });
}

function cleanupUnitWorktree(base, wtPath, opts) {
  if (opts.keepWorktree) {
    return { removed: false, reason: "--keep-worktree solicitado" };
  }
  const entries = listStatus(wtPath);
  const outsideWorkspace = entries.filter((entry) => !entry.path.startsWith(WORKSPACE_PREFIX));
  if (outsideWorkspace.length > 0) {
    return {
      removed: false,
      reason: "alteracoes nao confirmadas fora do workspace; a remocao manual e decisao do usuario"
    };
  }
  if (entries.length > 0 && !opts.removeWorktree) {
    return {
      removed: false,
      reason: "workspace efemero nao entregue; use --remove-worktree para descarta-lo ou --include-workspace para entrega-lo"
    };
  }
  const args = entries.length > 0 ? ["worktree", "remove", "--force", wtPath] : ["worktree", "remove", wtPath];
  const result = tryGit(args, { cwd: base });
  if (result.code !== 0) {
    return { removed: false, reason: `git worktree remove falhou: ${firstLine(result.stderr) ?? "saida vazia"}` };
  }
  return { removed: true };
}

async function finishWorktree({ phase, base, profilePath, config, opts }) {
  const type = opts.type ? requireType(opts) : null;
  const context = opts.context ? requireContext(opts) : null;
  if (!type || !context) {
    fail({
      phase,
      step: "arguments",
      message: "no modo worktree, --type e --context sao obrigatorios na fase finish (cada work unit tem estado proprio)",
      usage: USAGE
    });
  }
  const dev = config.development_branch;
  const workBranch = computeWorkBranch(config.work_branch_template, type, context, base);
  const state = loadWorktreeState(base, type, context);

  if (state?.phase === "finish") {
    const worktreeStillThere = state.worktree_path ? existsSync(join(base, state.worktree_path)) : false;
    return reportOk({
      phase,
      repo_root: base,
      work_tree: state.worktree_path ? join(base, state.worktree_path) : null,
      already_delivered: true,
      work_branch: state.work_branch ?? workBranch,
      development_branch: state.development_branch ?? dev,
      delivered_via: state.delivered_via ?? null,
      delivered_at: state.delivered_at ?? null,
      worktree_removed: !worktreeStillThere,
      pull_request: state.pull_request ?? null,
      merge: state.merge ?? null,
      next_steps: ["Esta work unit ja foi entregue; a repeticao da fase finish e inofensiva."]
    });
  }

  if (!state || state.phase !== "start") {
    fail({
      phase,
      step: "state-missing",
      message: `nenhuma execucao worktree ativa para ${type}/${JSON.stringify(context)}: execute a fase start antes`,
      suggestions: [
        "Execute a fase start no repositorio principal para criar o worktree da work unit.",
        "Se a execucao anterior foi legacy (worktree desabilitado), finalize-a com version_control.worktree.enabled=false ou removendo a secao worktree do profile."
      ]
    });
  }

  const wtPath = join(base, state.worktree_path ?? `${config.worktree.path}/${type}__${context}`);
  const registered = listWorktrees(base);
  const wt = registered.find((entry) => resolve(entry.path) === resolve(wtPath));
  if (!wt) {
    fail({
      phase,
      step: "worktree-missing",
      message: `o worktree ${JSON.stringify(state.worktree_path)} desta work unit nao esta mais registrado no git`,
      repo_state: { ...repoSnapshot(base), worktrees: registered.map((entry) => entry.path) },
      suggestions: [
        "Reexecute a fase start para recriar o worktree da mesma work unit: a branch e os commits ja feitos sao preservados.",
        "Se o diretorio foi removido manualmente, o destino do conteudo nao entregue e decisao do usuario."
      ]
    });
  }
  if (wt.branch !== workBranch) {
    fail({
      phase,
      step: "worktree-branch-mismatch",
      message: `o worktree ${JSON.stringify(state.worktree_path)} esta na branch ${JSON.stringify(wt.branch ?? "(detached)")}, mas a work unit espera ${JSON.stringify(workBranch)}`,
      repo_state: { ...repoSnapshot(base), worktree_path: wt.path, worktree_branch: wt.branch },
      suggestions: [
        "Nao troque a branch dentro do worktree da work unit; reexecute a fase start para um estado consistente.",
        "Se a mudanca de branch foi intencional, decida com o usuario antes de prosseguir."
      ]
    });
  }

  const profile = readProfile(profilePath);
  if (opts.message) validateCommitMessage(opts.message, profile, phase);

  const remote = remoteInfo(base);
  const statusEntries = listStatus(wtPath);
  const profileRel = managedFile(profilePath, base);
  const deliverable = opts.includeWorkspace ? statusEntries : nonWorkspace(statusEntries);
  const stagedPaths = deliverable.map((entry) => entry.path);

  if (opts.dryRun) {
    reportOk({
      phase,
      dry_run: true,
      repo_root: base,
      work_tree: wtPath,
      work_branch: workBranch,
      development_branch: dev,
      open_pr: config.open_pr,
      files_to_commit: stagedPaths,
      plan: [
        stagedPaths.length ? "git add -- <arquivos listados> && git commit -m <message> (dentro do worktree)" : "(nada a commitar; seguindo para entrega)",
        remote.present ? `git push -u origin ${workBranch}` : "(push pulado: sem remote)",
        config.open_pr
          ? config.pr_provider === "azure-devops"
            ? `criar pull request na API do Azure DevOps (${dev} <- ${workBranch}; PAT via AZURE_DEVOPS_PAT)`
            : `gh pr create --base ${dev} --head ${workBranch}`
          : `merge --no-ff ${workBranch} em ${dev} em worktree temporario (ou na arvore principal, se ela ja estiver em ${dev} e limpa)`,
        "remover o worktree da work unit quando estiver limpo (workspace efemero nao entregue preserva o worktree)"
      ],
      next_steps: ["Reexecute sem --dry-run para entregar."]
    });
  }

  if (stagedPaths.length > 0 && !opts.message) {
    fail({
      phase,
      step: "commit-message",
      message: "--message e obrigatorio quando existem alteracoes a commitar",
      repo_state: { ...repoSnapshot(wtPath), files_to_commit: stagedPaths }
    });
  }

  const steps = [];
  if (stagedPaths.length > 0) {
    step("git-add");
    mustGit(["add", "--", ...stagedPaths], { cwd: wtPath });
    step("git-commit");
    mustGit(["commit", "-m", opts.message], { cwd: wtPath });
    steps.push({ step: "commit", detail: firstLine(opts.message), hash: headCommit(wtPath) });
  }

  const ahead = aheadCount(wtPath, dev, workBranch);
  if (stagedPaths.length === 0 && (ahead === null || ahead === 0)) {
    fail({
      phase,
      step: "nothing-to-deliver",
      message: "nada a entregar: a branch de trabalho nao tem commits alem da branch de desenvolvimento",
      repo_state: repoSnapshot(wtPath),
      suggestions: ["Execute a implementacao das Agent Work Units antes de invocar a fase finish."]
    });
  }

  const commitHash = headCommit(wtPath);

  if (remote.present) {
    step("push-work-branch");
    const command = ["push", "-u", "origin", workBranch];
    const result = tryGit(command, { cwd: wtPath });
    steps.push({ step: "push-work-branch", ok: result.code === 0 });
    if (result.code !== 0) {
      fail({
        phase,
        step: "push-work-branch",
        message: `git ${command.join(" ")} falhou`,
        command: `git ${command.join(" ")}`,
        exit_code: result.code,
        stdout: result.stdout,
        stderr: result.stderr,
        repo_state: { ...repoSnapshot(wtPath), commit: commitHash },
        suggestions: [
          "Verifique credenciais do remote (gh auth status para GitHub; AZURE_DEVOPS_PAT para Azure DevOps; git remote -v).",
          "Se origin ja tiver a branch com historico divergente, a reconciliacao e decisao do usuario; nunca use force push.",
          ...baseSuggestions()
        ]
      });
    }
  }

  const delivery = config.open_pr
    ? await deliverByPullRequest(wtPath, config, workBranch, remote, opts, commitHash, phase)
    : deliverByMergeWorktree({ phase, base, profilePath, config, workBranch, remote });

  step("worktree-cleanup");
  const cleanup = cleanupUnitWorktree(base, wtPath, opts);
  steps.push({ step: "worktree-cleanup", removed: cleanup.removed, ...(cleanup.reason ? { detail: cleanup.reason } : {}) });

  persistWorktreeState(base, type, context, {
    ...(state ?? {}),
    phase: "finish",
    strategy: config.strategy,
    development_branch: dev,
    work_branch: workBranch,
    worktree_path: state.worktree_path,
    type,
    context,
    open_pr: config.open_pr,
    pr_provider: config.pr_provider,
    delivered_via: delivery.delivered_via,
    delivered_at: new Date().toISOString(),
    worktree_removed: cleanup.removed,
    ...(delivery.pull_request ? { pull_request: delivery.pull_request } : {}),
    ...(delivery.merge ? { merge: delivery.merge } : {})
  });

  reportOk({
    phase,
    repo_root: base,
    work_tree: wtPath,
    work_branch: workBranch,
    development_branch: dev,
    delivered_via: delivery.delivered_via,
    commit: stagedPaths.length > 0 ? { hash: commitHash, message: opts.message } : null,
    files_committed: stagedPaths,
    workspace_files_excluded: opts.includeWorkspace ? [] : workspaceOnly(statusEntries).map((entry) => entry.path),
    remote,
    pull_request: delivery.pull_request ?? null,
    merge: delivery.merge ?? null,
    worktree_removed: cleanup.removed,
    worktree_keep_reason: cleanup.reason ?? null,
    work_branch_removed: false,
    steps,
    next_steps: cleanup.removed
      ? delivery.next_steps
      : [...delivery.next_steps, `Worktree preservado em ${wtPath}: ${cleanup.reason}.`]
  });
}

function deliverByMergeWorktree({ phase, base, profilePath, config, workBranch, remote }) {
  const dev = config.development_branch;
  const devChecked = listWorktrees(base).find((wt) => wt.branch === dev);

  if (devChecked && resolve(devChecked.path) === resolve(base)) {
    const profileRel = managedFile(profilePath, base);
    const blocking = blockersOutsideWorkspace(listStatus(base), profileRel);
    if (blocking.length > 0) {
      fail({
        phase,
        step: "merge-main-dirty",
        message: `a entrega por merge direto usa a branch ${JSON.stringify(dev)}, que esta checked out na arvore principal com alteracoes nao confirmadas`,
        repo_state: {
          ...repoSnapshot(base),
          dirty_files: blocking.map((entry) => `${entry.x}${entry.y} ${entry.path}`)
        },
        suggestions: [
          "Com decisao do usuario, confirme ou arquive as alteracoes da arvore principal e reexecute a fase finish.",
          "Alternativa segura: use open_pr=true no project profile para entregar por pull request sem tocar a arvore principal."
        ]
      });
    }
    const result = mergeIntoDevelopment(base, config, workBranch, remote, phase);
    return { ...result, merge: { ...result.merge, via: "main-tree" } };
  }

  if (devChecked) {
    fail({
      phase,
      step: "merge-dev-worktree",
      message: `a branch ${JSON.stringify(dev)} esta checked out no worktree ${devChecked.path}; o merge direto exige uma arvore livre para ela`,
      repo_state: repoSnapshot(base),
      suggestions: [
        "Finalize ou libere o worktree que segura a branch de desenvolvimento (decisao do usuario).",
        "Alternativa segura: use open_pr=true no project profile para entregar por pull request."
      ]
    });
  }

  const tmpName = `.tmp-merge-${Math.random().toString(36).slice(2, 8)}`;
  const tmpDir = join(base, config.worktree.path, tmpName);
  const addResult = tryGit(["worktree", "add", tmpDir, dev], { cwd: base });
  if (addResult.code !== 0) {
    fail({
      phase,
      step: "merge-worktree-add",
      message: `nao foi possivel criar o worktree temporario de ${JSON.stringify(dev)} para o merge direto`,
      command: `git worktree add ${tmpName} ${dev}`,
      exit_code: addResult.code,
      stdout: addResult.stdout,
      stderr: addResult.stderr,
      repo_state: repoSnapshot(base),
      suggestions: [...baseSuggestions()]
    });
  }
  const removeTmp = () => {
    // Worktree temporario criado pela skill: conteudo vem do ref dev e o merge
    // ja foi concluido ou abortado; remocao forçada nao descarta dados do usuario.
    tryGit(["worktree", "remove", "--force", tmpDir], { cwd: base });
  };
  const result = mergeIntoDevelopment(tmpDir, config, workBranch, remote, phase, { onFail: removeTmp });
  removeTmp();
  return { ...result, merge: { ...result.merge, via: "temporary-worktree" } };
}

async function deliverByPullRequest(base, config, workBranch, remote, opts, commitHash, phase) {
  step("pull-request");
  if (config.pr_provider === "azure-devops") {
    return deliverByPullRequestAzureDevOps(base, config, workBranch, remote, opts, commitHash, phase);
  }
  if (config.pr_provider !== "github") {
    fail({
      phase,
      step: "pr-remote-provider",
      message: `pr_provider nao suportado: ${JSON.stringify(config.pr_provider)}; valores aceitos: github, azure-devops`,
      repo_state: repoSnapshot(base),
      suggestions: [...SUGGESTIONS["pr-remote-provider"], ...baseSuggestions()]
    });
  }
  const ghCheck = runProgram("gh", ["--version"]);
  if (ghCheck.code !== 0) {
    fail({
      phase,
      step: "pr-gh-missing",
      message: "o GitHub CLI (gh) e necessario para abrir o pull request e nao esta disponivel",
      repo_state: { ...repoSnapshot(base), commit: commitHash },
      suggestions: [...SUGGESTIONS["pr-gh-missing"], ...baseSuggestions()],
      compare_url: compareUrl(remote.url, config.development_branch, workBranch)
    });
  }
  const slug = parseOriginSlug(remote.url);
  if (!slug) {
    fail({
      phase,
      step: "pull-request",
      message: `pr_provider e "github" mas o remote origin nao e um repositorio GitHub: ${JSON.stringify(remote.url)}`,
      suggestions: [
        ...SUGGESTIONS["pr-remote-provider"],
        "Abra o PR manualmente no provedor de hospedagem ou troque open_pr para false (decisao do usuario)."
      ]
    });
  }
  const env = { ...process.env, GH_PAGER: "cat", PAGER: "cat" };
  const listResult = runProgram(
    "gh",
    ["pr", "list", "--repo", slug, "--head", workBranch, "--state", "open", "--json", "number,url,title", "--limit", "20"],
    { env }
  );
  if (listResult.code === 0) {
    try {
      const existing = JSON.parse(listResult.stdout || "[]");
      if (Array.isArray(existing) && existing.length > 0) {
        return {
          delivered_via: "pull-request",
          pull_request: { created: false, provider: "github", ...existing[0] },
          next_steps: [`PR existente aguardando revisao: ${existing[0].url}`]
        };
      }
    } catch {
      // segue para criacao
    }
  }
  const title = opts.prTitle ?? firstLine(opts.message) ?? `Entrega de ${workBranch}`;
  const body = opts.prBody ?? defaultPrBody(opts, base);
  const tempDir = mkdtempSync(join(tmpdir(), "awu-preflight-pr-"));
  const bodyFile = join(tempDir, "body.md");
  writeFileSync(bodyFile, body, "utf8");
  const createResult = runProgram(
    "gh",
    [
      "pr", "create",
      "--repo", slug,
      "--base", config.development_branch,
      "--head", workBranch,
      "--title", title,
      "--body-file", bodyFile
    ],
    { env }
  );
  rmSync(tempDir, { recursive: true, force: true });
  if (createResult.code !== 0) {
    fail({
      phase,
      step: "pull-request",
      message: "gh pr create falhou",
      command: "gh pr create",
      exit_code: createResult.code,
      stdout: createResult.stdout,
      stderr: createResult.stderr,
      repo_state: { ...repoSnapshot(base), commit: commitHash },
      suggestions: [
        "Verifique autenticacao (gh auth status) e permissao de criacao de PR no repositorio.",
        `Alternativa segura: abrir o PR manualmente em ${compareUrl(remote.url, config.development_branch, workBranch) ?? "o provedor remoto"}.`,
        ...baseSuggestions()
      ]
    });
  }
  const urlMatch = createResult.stdout.match(/https:\/\/[^)\s]+/);
  const numberMatch = createResult.stdout.match(/\/pull\/(\d+)/);
  return {
    delivered_via: "pull-request",
    pull_request: {
      created: true,
      provider: "github",
      number: numberMatch ? Number(numberMatch[1]) : null,
      url: urlMatch ? urlMatch[0] : null,
      base: config.development_branch,
      head: workBranch
    },
    next_steps: ["A PR passa por revisao humana; o merge e responsabilidade do revisor."]
  };
}

async function deliverByPullRequestAzureDevOps(base, config, workBranch, remote, opts, commitHash, phase) {
  const ado = parseAzureDevOpsRemote(remote.url);
  if (!ado) {
    fail({
      phase,
      step: "pr-remote-provider",
      message: `pr_provider e ${JSON.stringify(config.pr_provider)} mas o remote origin nao e um repositorio Azure DevOps reconhecido: ${JSON.stringify(remote.url)}`,
      repo_state: repoSnapshot(base),
      suggestions: [...SUGGESTIONS["pr-remote-provider"], ...baseSuggestions()]
    });
  }
  const pat = process.env.AZURE_DEVOPS_PAT;
  if (!pat || pat.trim() === "") {
    fail({
      phase,
      step: "pr-ado-pat",
      message: "AZURE_DEVOPS_PAT nao definida: a API do Azure DevOps exige uma PAT para criar pull requests",
      repo_state: { ...repoSnapshot(base), commit: commitHash },
      suggestions: [...SUGGESTIONS["pr-ado-pat"], ...baseSuggestions()],
      pull_request_create_url: pullRequestCreateUrl(ado, config.development_branch, workBranch)
    });
  }
  const createUrl = pullRequestCreateUrl(ado, config.development_branch, workBranch);
  const search = new URLSearchParams({
    "searchCriteria.sourceRefName": `refs/heads/${workBranch}`,
    "searchCriteria.targetRefName": `refs/heads/${config.development_branch}`,
    "searchCriteria.status": "active",
    "api-version": "7.1"
  }).toString();
  const list = await adoRequest(ado, { method: "GET", query: `?${search}`, pat, phase, base, commitHash, createUrl });
  const existing = Array.isArray(list?.value) ? list.value : [];
  if (existing.length > 0) {
    const pr = existing[0];
    return {
      delivered_via: "pull-request",
      pull_request: {
        created: false,
        provider: "azure-devops",
        number: pr.pullRequestId ?? null,
        url: adoPullRequestUrl(ado, pr),
        base: config.development_branch,
        head: workBranch
      },
      next_steps: [`PR existente aguardando revisao: ${adoPullRequestUrl(ado, pr) ?? "(URL indisponivel)"}`]
    };
  }
  const title = opts.prTitle ?? firstLine(opts.message) ?? `Entrega de ${workBranch}`;
  const description = opts.prBody ?? defaultPrBody(opts, base);
  const created = await adoRequest(ado, {
    method: "POST",
    query: "?api-version=7.1",
    pat,
    payload: {
      sourceRefName: `refs/heads/${workBranch}`,
      targetRefName: `refs/heads/${config.development_branch}`,
      title,
      description
    },
    phase,
    base,
    commitHash,
    createUrl
  });
  return {
    delivered_via: "pull-request",
    pull_request: {
      created: true,
      provider: "azure-devops",
      number: created.pullRequestId ?? null,
      url: adoPullRequestUrl(ado, created),
      base: config.development_branch,
      head: workBranch
    },
    next_steps: ["A PR passa por revisao humana; o merge e responsabilidade do revisor."]
  };
}

async function adoRequest(ado, { method, query, pat, payload, phase, base, commitHash, createUrl }) {
  const resourcePath = `pullrequests${query ?? ""}`;
  const url = `${ado.api_base}/${encodeURIComponent(ado.project)}/_apis/git/repositories/${encodeURIComponent(ado.repo)}/${resourcePath}`;
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        Authorization: `Basic ${Buffer.from(`:${pat}`, "utf8").toString("base64")}`,
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
      signal: AbortSignal.timeout(15000)
    });
  } catch (error) {
    const cause = error?.name === "TimeoutError" ? "timeout de 15s" : (error?.cause?.code ?? error?.message ?? "erro de rede");
    fail({
      phase,
      step: "pull-request",
      message: `acesso a API do Azure DevOps falhou (${method}): ${cause}`,
      command: `${method} ${url}`,
      exit_code: null,
      stdout: "",
      stderr: String(cause),
      repo_state: { ...repoSnapshot(base), commit: commitHash },
      suggestions: [
        "Verifique rede e se o host do remote origin responde; faca no maximo 2 tentativas seguras.",
        "Sem conectividade, informe o usuario; nunca use acoes destrutivas.",
        ...baseSuggestions()
      ],
      pull_request_create_url: createUrl
    });
  }
  const raw = await response.text();
  if (!response.ok) {
    fail({
      phase,
      step: "pull-request",
      message: `a API do Azure DevOps respondeu ${response.status} em ${method} ${resourcePath}`,
      command: `${method} ${url}`,
      exit_code: response.status,
      stdout: raw.slice(0, 2000),
      stderr: "",
      repo_state: { ...repoSnapshot(base), commit: commitHash },
      suggestions: [
        "Verifique a PAT (AZURE_DEVOPS_PAT) e a permissao de criacao de pull requests no repositorio.",
        "Credenciais invalidas (401/403) exigem nova PAT: gerar e trocar e decisao do usuario.",
        ...baseSuggestions()
      ],
      pull_request_create_url: createUrl
    });
  }
  try {
    return JSON.parse(raw || "{}");
  } catch {
    fail({
      phase,
      step: "pull-request",
      message: `resposta da API do Azure DevOps nao e JSON valido (${method})`,
      command: `${method} ${url}`,
      exit_code: response.status,
      stdout: raw.slice(0, 2000),
      stderr: "",
      repo_state: { ...repoSnapshot(base), commit: commitHash },
      suggestions: [...baseSuggestions()],
      pull_request_create_url: createUrl
    });
  }
}

function deliverByMerge(base, config, workBranch, remote, phase) {
  step("checkout-development");
  mustGit(["checkout", config.development_branch], { cwd: base });
  return mergeIntoDevelopment(base, config, workBranch, remote, phase);
}

function mergeIntoDevelopment(base, config, workBranch, remote, phase, { onFail } = {}) {
  const failAfter = (info) => {
    if (onFail) onFail();
    fail(info);
  };
  if (remote.present) {
    step("pull-development");
    const command = ["pull", "--ff-only", "origin", config.development_branch];
    const result = tryGit(command, { cwd: base });
    if (result.code !== 0) {
      failAfter({
        phase,
        step: "pull-development",
        message: `git ${command.join(" ")} falhou antes do merge`,
        command: `git ${command.join(" ")}`,
        exit_code: result.code,
        stdout: result.stdout,
        stderr: result.stderr,
        repo_state: repoSnapshot(base),
        suggestions: [...SUGGESTIONS["pull"], ...baseSuggestions()]
      });
    }
  }
  step("merge");
  const mergeResult = tryGit(["merge", "--no-ff", workBranch], { cwd: base });
  if (mergeResult.code !== 0) {
    const conflicted = tryGit(["diff", "--name-only", "--diff-filter=U"], { cwd: base })
      .stdout.trim().split("\n").filter(Boolean);
    const mergeInProgress = tryGit(["rev-parse", "-q", "--verify", "MERGE_HEAD"], { cwd: base }).code === 0;
    if (mergeInProgress) tryGit(["merge", "--abort"], { cwd: base });
    failAfter({
      phase,
      step: "merge-conflict",
      message: `o merge de ${workBranch} em ${config.development_branch} conflitou; o merge foi abortado e o estado anterior restaurado`,
      conflicted_files: conflicted,
      repo_state: repoSnapshot(base),
      suggestions: [...SUGGESTIONS["merge-conflict"], ...baseSuggestions()]
    });
  }
  if (remote.present) {
    step("push-development");
    const command = ["push", "origin", config.development_branch];
    const result = tryGit(command, { cwd: base });
    if (result.code !== 0) {
      failAfter({
        phase,
        step: "push-development",
        message: `git ${command.join(" ")} falhou apos o merge`,
        command: `git ${command.join(" ")}`,
        exit_code: result.code,
        stdout: result.stdout,
        stderr: result.stderr,
        repo_state: { ...repoSnapshot(base), merge_commit: headCommit(base) },
        suggestions: [
          "A branch pode estar protegida: o push manual e decisao do usuario, ou troque open_pr para true.",
          "O merge local foi concluido; nenhum dado foi perdido.",
          ...baseSuggestions()
        ]
      });
    }
  }
  return {
    delivered_via: "direct-merge",
    merge: { into: config.development_branch, merge_commit: headCommit(base) },
    next_steps: [
      `A branch ${workBranch} permanece local (e remota, quando existir remote); a exclusao e decisao do usuario.`
    ]
  };
}

function defaultPrBody(opts, base) {
  const files = listStatus(base).map((entry) => `- ${entry.path}`).slice(0, 50);
  return `${opts.message ?? ""}\n\n## Arquivos alterados\n${files.join("\n")}\n\n_Gerado por awu-dev-preflight._\n`;
}

try {
  const argv = process.argv.slice(2);
  currentPhase = argv[0] ?? null;
  const opts = parseArgs(argv);
  if (opts.phase === "start") startCommand(opts);
  else await finishCommand(opts);
} catch (error) {
  fail({
    phase: currentPhase,
    step: currentStep,
    message: error.message,
    ...(error.command
      ? { command: error.command, exit_code: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "" }
      : {}),
    suggestions: [
      "Reexecute a fase apos correcao segura; o JSON traz command, stdout e stderr para diagnostico.",
      "Se a correcao exigir qualquer acao da lista forbidden_actions, interrompa e decida com o usuario."
    ]
  });
}
