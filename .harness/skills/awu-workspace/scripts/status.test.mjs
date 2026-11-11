// Fase derivada de fatos reais: arquivos do pacote, estado do executor e Git.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { sandbox, cli, write, openFront, compilePackage, Executor, PackagesDir } from "./test-fixture.mjs";

const ok = (result) => {
  assert.equal(result.code, 0, JSON.stringify(result));
  return result;
};
const phaseOf = (front, id = "us-101") => ok(cli(front.work_tree, "status")).packages.find((pkg) => pkg.id === id);

function executor(front, ...args) {
  const outcome = spawnSync(process.execPath, [Executor, ...args], { cwd: front.work_tree, encoding: "utf8" });
  return { code: outcome.status, ...JSON.parse(outcome.stdout) };
}

test("pacote avança de seeded a compiled por fatos; pedido alterado volta a compiling", (context) => {
  const fixture = sandbox(context);
  const front = openFront(fixture);
  const request = path.join(front.work_tree, PackagesDir, "us-101/request.md");
  assert.equal(phaseOf(front).phase, "seeded");
  fs.writeFileSync(request, "# Pedido\nExportar throughput em CSV com filtro.\n");
  const requested = ok(cli(front.work_tree, "status"));
  assert.equal(requested.packages[0].phase, "requested");
  assert.deepEqual(requested.next, { skill: "awu-compiler", package: "us-101" });
  const manifest = compilePackage(front.work_tree, "us-101");
  const compiled = ok(cli(front.work_tree, "status"));
  assert.equal(compiled.packages[0].phase, "compiled");
  assert.deepEqual(compiled.next, { skill: "awu-package-executor", explicit_request: true, package: "us-101" });
  fs.rmSync(path.join(front.work_tree, PackagesDir, "us-101/review-manifest.md"));
  assert.match(phaseOf(front).reason, /review-manifest/);
  write(front.work_tree, `${PackagesDir}/us-101/review-manifest.md`, "# Review");
  fs.appendFileSync(request, "Novo requisito.\n");
  const stale = phaseOf(front);
  assert.equal(stale.phase, "compiling");
  assert.match(stale.reason, /mudou depois da compilação/);
  // O executor é a autoridade: pedido alterado também o bloqueia.
  assert.equal(executor(front, "begin", "--manifest", manifest).code, 1);
});

test("executor aceita o pacote com request.md declarado e workspace.json fora da pasta", (context) => {
  const fixture = sandbox(context);
  const front = openFront(fixture);
  const manifest = compilePackage(front.work_tree, "us-101");
  const begun = executor(front, "begin", "--manifest", manifest);
  assert.equal(begun.code, 0, JSON.stringify(begun));
  const running = ok(cli(front.work_tree, "status"));
  assert.equal(running.packages[0].phase, "executing");
  assert.deepEqual(running.packages[0].execution, { status: "planned", reason: null, units: "0/1", state: begun.result.state });
  assert.deepEqual(running.next, { skill: "awu-package-executor", action: "retomar", package: "us-101" });
  assert.equal(fs.existsSync(path.join(fixture.root, begun.result.state)), true);
});

test("entrega publicada pendente vira awaiting-delivery; arquivo final vira closed", (context) => {
  const fixture = sandbox(context);
  const front = openFront(fixture);
  const state = {
    schema_version: 1,
    package_id: "us-101",
    worktree: front.work_tree,
    status: "running",
    units: { a: { status: "completed" } },
    obligations: { learning: null, delivery: null },
    manifest: { commit_policy: { required_delivery: "published" } },
  };
  write(fixture.root, ".harness/workspace/package-executions/us-101/exec/state.json", JSON.stringify(state));
  const awaiting = ok(cli(front.work_tree, "status"));
  assert.equal(awaiting.packages[0].phase, "awaiting-delivery");
  assert.deepEqual(awaiting.next, { skill: "awu-workspace", action: "finish", explicit_request: true, package: "us-101" });
  fs.rmSync(path.join(fixture.root, ".harness/workspace/package-executions"), { recursive: true });
  write(fixture.root, ".harness/audits/package-executions/us-101/exec/execution.json", JSON.stringify({ status: "retired", state }));
  const closed = ok(cli(front.work_tree, "status"));
  assert.equal(closed.packages[0].phase, "closed");
  assert.deepEqual(closed.next, { skill: "awu-workspace", action: "finish", explicit_request: true });
});

test("pacote sem request.md é empty e volta para o workspace registrar o pedido", (context) => {
  const fixture = sandbox(context);
  const front = openFront(fixture);
  fs.rmSync(path.join(front.work_tree, PackagesDir, "us-101/request.md"));
  const status = ok(cli(front.work_tree, "status"));
  assert.deepEqual(status.packages, [{ id: "us-101", phase: "empty" }]);
  assert.deepEqual(status.next, { skill: "awu-workspace", action: "registrar o pedido em request.md", package: "us-101" });
});

test("fora de uma frente lista todas; --workspace divergente do diretório é recusado", (context) => {
  const fixture = sandbox(context);
  const first = openFront(fixture, "101");
  const second = openFront(fixture, "102");
  const listed = ok(cli(fixture.root, "status"));
  assert.deepEqual(listed.fronts.map((front) => [front.workspace_id, front.phase, front.packages[0].phase]), [
    ["us-101", "active", "seeded"],
    ["us-102", "active", "seeded"],
  ]);
  assert.equal(listed.main_tree, undefined);
  assert.equal(ok(cli(fixture.root, "status", "--workspace", "us-102")).work_tree, second.work_tree);
  assert.equal(ok(cli(first.work_tree, "status", "--all")).fronts.length, 2);
  const mismatch = cli(first.work_tree, "status", "--workspace", "us-102");
  assert.equal(mismatch.step, "workspace-mismatch");
  assert.equal(cli(fixture.root, "status", "--workspace", "us-999").step, "workspace-not-found");
});

test("alerta vazamento para a pasta principal e base desatualizada", (context) => {
  const fixture = sandbox(context);
  const front = openFront(fixture);
  write(fixture.root, "src/app.mjs", "edição no lugar errado\n");
  fixture.landOnMain({ "src/other.mjs": "export const other = 1;\n" });
  front.git("fetch", "-q", "origin");
  const status = ok(cli(front.work_tree, "status"));
  assert.deepEqual(status.main_tree, { branch: "main", changed_files: 1, commits_ahead_of_origin: 0 });
  assert.equal(status.base_behind, 1);
});
