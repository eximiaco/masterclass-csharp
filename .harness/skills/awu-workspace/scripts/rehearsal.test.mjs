// Ensaio ponta a ponta: frentes paralelas, executor real em linked worktree, entrega e limpeza.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { sandbox, cli, write, openFront, commitChange, compilePackage, hash, Executor, PackagesDir } from "./test-fixture.mjs";

const ok = (result) => {
  assert.equal(result.code, 0, JSON.stringify(result));
  return result;
};

function executor(front, ...args) {
  const outcome = spawnSync(process.execPath, [Executor, ...args], { cwd: front.work_tree, encoding: "utf8" });
  return ok({ code: outcome.status, ...JSON.parse(outcome.stdout) });
}

/** Executa o pacote de uma unidade como o executor faria: commit pelo workspace, prova na raiz comum, close. */
function runPackage(fixture, front, id, source, bytes) {
  const state = executor(front, "begin", "--manifest", compilePackage(front.work_tree, id)).result.state;
  const event = (name, value) => {
    write(fixture.root, `.harness/workspace/${id}-${name}.json`, JSON.stringify({ schema_version: 1, ...value }));
    return executor(front, name === "closure" ? "close" : "record", "--state", state, "--event", `.harness/workspace/${id}-${name}.json`);
  };
  event("started", { type: "unit-started", unit_id: "a" });
  const committed = commitChange(front, source, bytes, `feat(${id}): implementa unidade`);
  const proofPath = `.harness/audits/${id}/proof.txt`;
  write(fixture.root, proofPath, `gates de ${id} passaram em ${committed.commit_sha}`);
  const proof = { path: proofPath, sha256: hash(fs.readFileSync(path.join(fixture.root, proofPath))) };
  const input = { path: source, sha256: hash(fs.readFileSync(path.join(front.work_tree, source))) };
  event("validated", { type: "unit-validated", unit_id: "a", result: "passed", source_revision: committed.commit_sha, inputs: [input], evidence: [proof], review: proof });
  event("completed", { type: "unit-completed", unit_id: "a" });
  event("learning", { type: "learning-evaluated", classification: "none", reason: "sem aprendizado reutilizável no ensaio" });
  event("delivery", { type: "delivery-recorded", mode: "local", evidence: [proof] });
  const check = { result: "passed", exit_code: 0, command: "conferência do ensaio", artifacts: [proof] };
  event("closure", { discovery: check, references: check, affected: check });
  return state;
}

const phases = (fixture) => ok(cli(fixture.root, "status")).fronts.map((front) => [front.workspace_id, front.phase, front.packages.map((pkg) => pkg.phase).join(",")]);

test("duas US em paralelo e uma frente manual vão do start ao cleanup sem interferência", (context) => {
  const fixture = sandbox(context);
  const first = openFront(fixture, "101");
  const second = openFront(fixture, "102");
  const manual = ok(cli(fixture.root, "start", "--description", "Ajuste manual de texto", "--no-package"));
  assert.deepEqual(phases(fixture), [
    ["ajuste-manual-de-texto", "manual", ""],
    ["us-101", "active", "seeded"],
    ["us-102", "active", "seeded"],
  ]);

  // As duas frentes executam seus pacotes intercaladas; cada commit cai na própria branch.
  const firstState = runPackage(fixture, first, "us-101", "src/app.mjs", "export const version = 101;\n");
  const secondState = runPackage(fixture, second, "us-102", "src/second.mjs", "export const second = 102;\n");
  assert.notEqual(firstState, secondState);
  assert.equal(first.git("log", "--format=%s", "-1"), "feat(us-101): implementa unidade");
  assert.equal(second.git("log", "--format=%s", "-1"), "feat(us-102): implementa unidade");
  assert.equal(fs.existsSync(path.join(second.work_tree, "src/app.mjs")), true);
  assert.equal(fs.readFileSync(path.join(second.work_tree, "src/app.mjs"), "utf8"), "export const version = 1;\n");
  for (const front of [first, second]) {
    const closed = ok(cli(front.work_tree, "status"));
    assert.deepEqual(closed.packages.map((pkg) => pkg.phase), ["closed"]);
    assert.deepEqual(closed.next, { skill: "awu-workspace", action: "finish", explicit_request: true });
    assert.equal(fs.existsSync(path.join(front.work_tree, PackagesDir, closed.workspace_id)), false);
  }

  // A primeira é entregue e mesclada; a segunda sincroniza quando quer e segue.
  ok(cli(first.work_tree, "finish"));
  fixture.squashMerge("feature/us-101");
  ok(cli(fixture.root, "cleanup", "--workspace", "us-101"));
  const synced = ok(cli(second.work_tree, "sync"));
  assert.deepEqual([synced.changed, synced.files.items], [true, ["src/app.mjs"]]);
  assert.equal(fs.readFileSync(path.join(second.work_tree, "src/app.mjs"), "utf8"), "export const version = 101;\n");
  ok(cli(second.work_tree, "finish"));
  fixture.squashMerge("feature/us-102");

  // Trabalho manual: commit e entrega pelos mesmos comandos, sem pacote.
  write(manual.work_tree, "README.md", "# Texto ajustado\n");
  ok(cli(manual.work_tree, "commit", "--message", "docs: ajusta texto", "--paths", "README.md"));
  ok(cli(manual.work_tree, "sync"));
  ok(cli(manual.work_tree, "finish"));
  fixture.squashMerge("feature/ajuste-manual-de-texto");
  ok(cli(fixture.root, "cleanup", "--workspace", "us-102"));
  ok(cli(fixture.root, "cleanup", "--workspace", "ajuste-manual-de-texto"));

  // Nada vazou: pasta principal limpa e atualizada, sem stash, sem frentes nem branches órfãs.
  assert.deepEqual(ok(cli(fixture.root, "status")), { code: 0, status: "ok", command: "status", fronts: [], common_root: fixture.root });
  assert.equal(fixture.git("status", "--porcelain"), "");
  assert.equal(fixture.git("stash", "list"), "");
  assert.equal(fixture.git("rev-parse", "HEAD"), fixture.git("rev-parse", "origin/main"));
  assert.equal(fixture.git("branch", "--format=%(refname:short)"), "main");
  assert.deepEqual(fs.readdirSync(fixture.base), []);
  for (const file of ["src/app.mjs", "src/second.mjs", "README.md"]) assert.equal(fs.existsSync(path.join(fixture.root, file)), true, file);
  assert.equal(fs.existsSync(path.join(fixture.root, ".harness/audits/package-executions/us-101")), true);
  assert.equal(fs.readdirSync(path.join(fixture.root, ".harness/audits/workspaces")).length, 3);
});
