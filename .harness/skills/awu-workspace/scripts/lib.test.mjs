// Unidades puras das libs: parser do profile, configuração, nomes e remotes.
import test from "node:test";
import assert from "node:assert/strict";
import { parseSimpleYaml, resolveWorkspaceConfig, ProfileError } from "./lib/profile.mjs";
import { parseAzureDevOpsRemote, parseOriginSlug } from "./lib/git.mjs";
import { slugify, normalizeType, nameWorkspace } from "./lib/naming.mjs";
import { Blocked } from "./lib/outcome.mjs";
import { sandbox, cli } from "./test-fixture.mjs";

const config = (yaml) => resolveWorkspaceConfig({ data: parseSimpleYaml(yaml) }, "demo");
const branching = (body) => `version_control:\n  branching:\n${body}`;

test("parser lê comentários, listas inline, aspas e blocos aninhados; recusa YAML fora do subconjunto", () => {
  const data = parseSimpleYaml(`# comentário
schema_version: 1

application:
  name: "demo-app"
  description: 'app de demo'   # comentário inline
  capabilities: ["api", "cli"]

conventions:
  - name: nomenclatura
    applies_to:
      - new
      - modified
`);
  assert.equal(data.schema_version, 1);
  assert.equal(data.application.name, "demo-app");
  assert.equal(data.application.description, "app de demo");
  assert.deepEqual(data.application.capabilities, ["api", "cli"]);
  assert.deepEqual(data.conventions[0].applies_to, ["new", "modified"]);
  assert.throws(() => parseSimpleYaml("texto: |\n  multilinha\n"));
  assert.throws(() => parseSimpleYaml("base: &ancora valor\n"));
  assert.throws(() => parseSimpleYaml("chave:\n\tvalor: 1\n"));
});

test("configuração usa defaults em memória quando o profile omite as seções", () => {
  const resolved = resolveWorkspaceConfig({ data: null }, "demo");
  assert.deepEqual(resolved, {
    development_branch: "main",
    pr_provider: "github",
    naming: { user_story: "feature/us-{id}", descriptive: "feature/{slug}" },
    worktree: { path: "../demo.wt", bootstrap: { copy: [], ignore: [] } },
    commits: { style: null, header_max_length: null },
  });
  assert.equal(config(branching("    strategy: git-flow\n")).development_branch, "develop");
});

test("configuração recusa merge direto, provedor, templates e caminhos inválidos com o valor ofensor", () => {
  const rejects = (yaml, pattern) => assert.throws(() => config(yaml), (error) => error instanceof ProfileError && pattern.test(error.message));
  rejects(branching("    open_pr: false\n"), /merge direto/);
  rejects(branching("    pr_provider: gitea\n"), /gitea.*azure-devops/);
  rejects(branching("    strategy: caos\n"), /caos/);
  rejects(branching('    work_branch_naming:\n      user_story: "feature/us"\n'), /user_story.*\{id\}/);
  rejects(branching('    work_branch_naming:\n      descriptive: "feature/{id}"\n'), /descriptive.*\{slug\}/);
  rejects('version_control:\n  worktree:\n    path: "/abs/fronts"\n', /worktree\.path/);
  rejects('version_control:\n  worktree:\n    bootstrap:\n      copy: ["../fora"]\n', /bootstrap\.copy/);
  rejects("version_control: texto\n", /version_control/);
});

test("nomes: slug sem acentos, tipo normalizado e id derivado do último segmento da branch", () => {
  assert.equal(slugify("Ajuste de configuração das Flags!"), "ajuste-de-configuracao-das-flags");
  assert.equal(slugify("x".repeat(80)).length, 50);
  assert.equal(slugify("um texto muito longo que passa de cinquenta caract-eres"), "um-texto-muito-longo-que-passa-de-cinquenta-caract");
  assert.equal(normalizeType("Technical Debt"), "technical_debt");
  const naming = { user_story: "feature/us-{id}", bug: "fix/bug-{id}", descriptive: "feature/{slug}" };
  const item = (type, title) => ({ kind: "work-item", work_item: { id: 7, type, title } });
  assert.deepEqual(nameWorkspace(naming, item("User Story")), { branch: "feature/us-7", workspaceId: "us-7" });
  assert.deepEqual(nameWorkspace(naming, item("Bug")), { branch: "fix/bug-7", workspaceId: "bug-7" });
  assert.deepEqual(nameWorkspace(naming, item("Task", "Ação Rápida")), { branch: "feature/acao-rapida", workspaceId: "acao-rapida" });
  assert.throws(() => nameWorkspace(naming, item("Task", null)), Blocked);
  assert.throws(() => nameWorkspace(naming, { kind: "description", description: "!!!" }), Blocked);
});

test("remotes: Azure DevOps em https, legado e ssh; GitHub por slug; outros hosts não casam", () => {
  assert.equal(parseAzureDevOpsRemote("https://org@dev.azure.com/org/proj/_git/repo").api_base, "https://dev.azure.com/org");
  const local = parseAzureDevOpsRemote("http://127.0.0.1:3999/adoorg/Follow%20the%20Code/_git/adorepo");
  assert.deepEqual([local.api_base, local.web_base, local.project], ["http://127.0.0.1:3999/adoorg", "http://127.0.0.1:3999", "Follow%20the%20Code"]);
  assert.equal(parseAzureDevOpsRemote("https://org.visualstudio.com/proj/_git/repo").api_base, "https://org.visualstudio.com");
  assert.equal(parseAzureDevOpsRemote("git@ssh.dev.azure.com:v3/org/proj/repo").api_base, "https://dev.azure.com/org");
  assert.equal(parseAzureDevOpsRemote("https://github.com/acme/demo-app.git"), null);
  assert.equal(parseOriginSlug("git@github.com:acme/demo-app.git"), "acme/demo-app");
});

test("CLI bloqueia profile inválido e diretório base dentro da pasta principal, sem criar nada", (context) => {
  const invalid = sandbox(context, { profile: "version_control:\n  branching:\n    open_pr: false\n" });
  const refused = cli(invalid.root, "start", "--description", "qualquer coisa");
  assert.deepEqual([refused.code, refused.step], [1, "profile"]);
  assert.match(refused.message, /merge direto/);
  const inside = sandbox(context, { profile: 'version_control:\n  worktree:\n    path: ".harness/worktrees"\n' });
  const nested = cli(inside.root, "status");
  assert.deepEqual([nested.code, nested.step], [1, "profile"]);
  assert.match(nested.message, /fora da pasta principal/);
  assert.equal(invalid.git("worktree", "list", "--porcelain").split("\n").filter((line) => line.startsWith("worktree ")).length, 1);
});
