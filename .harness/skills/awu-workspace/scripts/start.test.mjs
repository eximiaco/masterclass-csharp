// Integração real do CLI em Git local; sem rede nem provedor.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { sandbox, cli, write, gitAt, openFront, PackagesDir } from "./test-fixture.mjs";

const ok = (result) => {
  assert.equal(result.code, 0, JSON.stringify(result));
  return result;
};
const blocked = (result, step) => {
  assert.equal(result.code, 1, JSON.stringify(result));
  assert.equal(result.step, step, JSON.stringify(result));
  return result;
};
const story = (id, ...extra) => ["start", "--work-item", id, "--work-item-type", "User Story", "--title", "Exportar CSV", ...extra];

test("start nasce de origin com main local defasada e não toca pasta principal suja", (context) => {
  const fixture = sandbox(context);
  const landed = fixture.landOnMain({ "src/other.mjs": "export const other = 1;\n" });
  const localMain = fixture.git("rev-parse", "HEAD");
  write(fixture.root, "src/app.mjs", "trabalho manual em andamento\n");
  const started = ok(cli(fixture.root, ...story("5346")));
  assert.equal(started.branch, "feature/us-5346");
  assert.equal(started.work_tree, path.join(fixture.base, "us-5346"));
  assert.equal(gitAt(started.work_tree)("rev-parse", "HEAD"), landed);
  assert.equal(started.base_sha, landed);
  assert.equal(started.main_tree.action, "untouched");
  assert.equal(fixture.git("rev-parse", "HEAD"), localMain);
  assert.equal(fs.readFileSync(path.join(fixture.root, "src/app.mjs"), "utf8"), "trabalho manual em andamento\n");
  assert.throws(() => gitAt(started.work_tree)("rev-parse", "--abbrev-ref", "@{u}"));
});

test("start atualiza pasta principal limpa, copia bootstrap declarado e é idempotente", (context) => {
  const fixture = sandbox(context);
  const landed = fixture.landOnMain({ "src/other.mjs": "export const other = 1;\n" });
  fixture.git("checkout", "-qb", "scratch");
  const started = ok(cli(fixture.root, ...story("5346")));
  assert.deepEqual(started.main_tree, { action: "updated", branch: "main", head: landed });
  assert.equal(fixture.git("branch", "--show-current"), "main");
  assert.deepEqual(started.bootstrap, { copied: [".env.local"], missing: ["missing.local"], skipped: [] });
  assert.equal(fs.readFileSync(path.join(started.work_tree, ".env.local"), "utf8"), "LOCAL_ONLY=1\n");
  assert.deepEqual(started.packages.map((pkg) => [pkg.id, pkg.phase]), [["us-5346", "seeded"]]);
  assert.deepEqual(started.next, { skill: "awu-from-user-story", package: "us-5346" });
  const request = fs.readFileSync(path.join(started.work_tree, PackagesDir, "us-5346/request.md"), "utf8");
  assert.match(request, /User Story 5346 — Exportar CSV/);
  const again = ok(cli(started.work_tree, ...story("5346")));
  assert.equal(again.already_started, true);
  assert.equal(again.work_tree, started.work_tree);
  assert.equal(gitAt(started.work_tree)("status", "--porcelain"), "");
});

test("branch segue o tipo do work item; sem tipo mapeado ou sem work item usa slug", (context) => {
  const fixture = sandbox(context);
  const type = (id, kind, title) => ok(cli(fixture.root, "start", "--work-item", id, "--work-item-type", kind, "--title", title)).branch;
  assert.equal(type("812", "Bug", "Corrigir filtro"), "fix/bug-812");
  assert.equal(type("5073", "Technical Debt", "Remover legado"), "feature/td-5073");
  assert.equal(type("77", "Task", "Ajustar relatório"), "feature/ajustar-relatorio");
  const described = ok(cli(fixture.root, "start", "--description", "Ajuste de configuração das Flags!"));
  assert.equal(described.branch, "feature/ajuste-de-configuracao-das-flags");
  assert.deepEqual(described.next, { skill: "awu-compiler", package: "ajuste-de-configuracao-das-flags" });
  blocked(cli(fixture.root, "start", "--description", " --- "), "naming");
  blocked(cli(fixture.root, "start", "--work-item", "abc", "--work-item-type", "Bug"), "arguments");
  blocked(cli(fixture.root, "start", "--work-item", "9"), "arguments");
});

test("start recusa branch local, branch remota e pasta ocupada sem criar nada", (context) => {
  const fixture = sandbox(context);
  fixture.git("branch", "feature/us-1");
  blocked(cli(fixture.root, ...story("1")), "branch-exists");
  fixture.otherGit("push", "-q", "origin", "main:feature/us-2");
  blocked(cli(fixture.root, ...story("2")), "remote-branch-exists");
  fs.mkdirSync(path.join(fixture.base, "us-3"), { recursive: true });
  blocked(cli(fixture.root, ...story("3")), "path-occupied");
  assert.equal(fixture.git("worktree", "list", "--porcelain").includes(fixture.base), false);
  assert.equal(fixture.git("branch", "--list", "feature/us-3"), "");
});

test("--no-package abre frente manual; package new exige prefixo e id nunca usado", (context) => {
  const fixture = sandbox(context);
  const manual = ok(cli(fixture.root, ...story("10", "--no-package")));
  assert.deepEqual(manual.packages, []);
  assert.equal(ok(cli(manual.work_tree, "status")).phase, "manual");
  const front = openFront(fixture, "11");
  const created = ok(cli(front.work_tree, "package", "new", "--id", "us-11-review", "--description", "Filtro por período"));
  assert.deepEqual(created.packages.map((pkg) => pkg.id), ["us-11", "us-11-review"]);
  blocked(cli(front.work_tree, "package", "new", "--id", "us-11-review"), "package-exists");
  blocked(cli(front.work_tree, "package", "new", "--id", "outra-coisa"), "package-id");
  write(fixture.root, ".harness/audits/package-executions/us-11-antigo/abc/execution.json", "{}");
  blocked(cli(front.work_tree, "package", "new", "--id", "us-11-antigo"), "package-id-taken");
  blocked(cli(fixture.root, "package", "new", "--id", "us-11-x"), "workspace-required");
});

test("id já usado por execução arquivada abre a frente sem pacote e orienta o próximo id", (context) => {
  const fixture = sandbox(context);
  write(fixture.root, ".harness/audits/package-executions/us-20/abc/execution.json", "{}");
  const started = ok(cli(fixture.root, ...story("20")));
  assert.deepEqual(started.packages, []);
  assert.match(started.package_skipped, /us-20-<sufixo>/);
});
