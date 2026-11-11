// cleanup e lock contra Git local; merge de terceiros simulado por um segundo clone.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { sandbox, cli, cliAsync, write, openFront, commitChange, adoServer } from "./test-fixture.mjs";

const ok = (result) => {
  assert.equal(result.code, 0, JSON.stringify(result));
  return result;
};
const blocked = (result, step) => {
  assert.equal(result.code, 1, JSON.stringify(result));
  assert.equal(result.step, step, JSON.stringify(result));
  return result;
};
const blockers = (result) => blocked(result, "cleanup-blocked").blockers.map((item) => item.kind);
const cleanup = (fixture, ...extra) => cli(fixture.root, "cleanup", "--workspace", "us-101", ...extra);

test("cleanup após squash merge remove worktree e branch, move evidências e atualiza a pasta principal", (context) => {
  const fixture = sandbox(context);
  const front = openFront(fixture);
  commitChange(front, "src/app.mjs", "export const version = 2;\n");
  ok(cli(front.work_tree, "finish"));
  fixture.squashMerge("feature/us-101");
  write(front.work_tree, ".harness/audits/test-strategy/us-101/run/proof.txt", "prova local");
  write(front.work_tree, ".harness/reports/conformity-gaps/2026-01-01-01/gap.md", "gap local");
  const preview = ok(cleanup(fixture, "--dry-run"));
  assert.deepEqual([preview.removable, preview.proof, preview.evidence_to_move], [true, "content", 2]);
  assert.equal(fs.existsSync(front.work_tree), true);
  const cleaned = ok(cleanup(fixture));
  assert.deepEqual([cleaned.removed, cleaned.proof, cleaned.evidence_moved], [true, "content", 2]);
  assert.equal(fs.existsSync(front.work_tree), false);
  assert.equal(fixture.git("branch", "--list", "feature/us-101"), "");
  assert.equal(fs.readFileSync(path.join(fixture.root, ".harness/audits/test-strategy/us-101/run/proof.txt"), "utf8"), "prova local");
  assert.equal(fs.readFileSync(path.join(fixture.root, ".harness/reports/conformity-gaps/2026-01-01-01/gap.md"), "utf8"), "gap local");
  const record = JSON.parse(fs.readFileSync(path.join(fixture.root, cleaned.record), "utf8"));
  assert.deepEqual([record.workspace.workspace_id, record.proof], ["us-101", "content"]);
  assert.equal(cleaned.main_tree.action, "updated");
  assert.equal(fixture.git("rev-parse", "HEAD"), fixture.git("rev-parse", "origin/main"));
  assert.deepEqual(ok(cli(fixture.root, "status")).fronts, []);
});

test("cleanup recusa frente não mesclada e só aceita confirmação com o tip exato", (context) => {
  const fixture = sandbox(context);
  const front = openFront(fixture);
  const committed = commitChange(front, "src/app.mjs", "export const version = 2;\n");
  blocked(cli(front.work_tree, "cleanup"), "inside-worktree");
  const refused = blocked(cleanup(fixture), "cleanup-blocked");
  assert.equal(refused.blockers[0].kind, "not-merged");
  assert.equal(refused.blockers[0].unmerged_commits.total, 1);
  assert.equal(refused.blockers[0].confirm_with, committed.commit_sha);
  assert.deepEqual(blockers(cleanup(fixture, "--confirm", "0000000")), ["not-merged"]);
  assert.equal(fs.existsSync(front.work_tree), true);
  assert.equal(ok(cleanup(fixture, "--confirm", committed.commit_sha)).proof, "confirmed");
  assert.equal(fixture.git("branch", "--list", "feature/us-101"), "");
});

test("cleanup recusa árvore suja, execução ativa, lifecycle ativo e evidência conflitante", (context) => {
  const fixture = sandbox(context);
  const front = openFront(fixture);
  write(front.work_tree, "src/solto.mjs", "não commitado\n");
  assert.deepEqual(blockers(cleanup(fixture)), ["dirty-tree"]);
  fs.rmSync(path.join(front.work_tree, "src/solto.mjs"));
  const state = ".harness/workspace/package-executions/us-101/exec/state.json";
  write(fixture.root, state, JSON.stringify({ package_id: "us-101", worktree: front.work_tree, status: "paused", units: {} }));
  assert.deepEqual(blockers(cleanup(fixture)), ["active-execution"]);
  fs.rmSync(path.join(fixture.root, ".harness/workspace/package-executions"), { recursive: true });
  const registry = ".harness/workspace/test-lifecycle/us-101-proof/temporary-tests.json";
  write(fixture.root, registry, JSON.stringify({ execution_id: "us-101-proof", root: front.work_tree, status: "validated" }));
  assert.deepEqual(blockers(cleanup(fixture)), ["active-lifecycle"]);
  fs.rmSync(path.join(fixture.root, ".harness/workspace/test-lifecycle"), { recursive: true });
  write(front.work_tree, ".harness/audits/proof.txt", "versão do worktree");
  write(fixture.root, ".harness/audits/proof.txt", "versão diferente na pasta principal");
  assert.deepEqual(blockers(cleanup(fixture)), ["evidence-conflict"]);
  assert.equal(fs.readFileSync(path.join(front.work_tree, ".harness/audits/proof.txt"), "utf8"), "versão do worktree");
  write(fixture.root, ".harness/audits/proof.txt", "versão do worktree");
  assert.equal(ok(cleanup(fixture)).evidence_moved, 0);
});

test("worktree fora do diretório base não é frente, mesmo com workspace.json copiado", (context) => {
  const fixture = sandbox(context);
  const front = openFront(fixture);
  const foreign = path.join(fixture.parent, "elsewhere");
  fixture.git("worktree", "add", "-qb", "alheia", foreign);
  const copied = ".harness/workspace/awu-packages/workspace.json";
  write(foreign, copied, fs.readFileSync(path.join(front.work_tree, copied), "utf8").replace("us-101", "us-999"));
  assert.deepEqual(ok(cli(fixture.root, "status")).fronts.map((item) => item.workspace_id), ["us-101"]);
  blocked(cli(fixture.root, "cleanup", "--workspace", "us-999"), "workspace-not-found");
  blocked(cli(foreign, "commit", "--message", "feat(x): y", "--paths", "src/app.mjs"), "workspace-required");
  assert.equal(fs.existsSync(foreign), true);
});

test("cleanup aceita PR concluído no provedor só quando o commit de origem é o tip", async (context) => {
  const api = await adoServer(context);
  const fixture = sandbox(context, { remoteUrl: api.remoteUrl });
  const front = openFront(fixture);
  commitChange(front, "src/app.mjs", "export const version = 'frente';\n");
  const env = { AZURE_DEVOPS_PAT: "pat-de-teste" };
  const delivered = ok(await cliAsync(front.work_tree, ["finish"], env));
  // A base muda as mesmas linhas depois: o conteúdo deixa de ser comprovável por merge.
  fixture.landOnMain({ "src/app.mjs": "export const version = 'reescrito depois';\n" });
  const args = ["cleanup", "--workspace", "us-101"];
  blocked(await cliAsync(fixture.root, args, env), "cleanup-blocked");
  Object.assign(api.pulls[0], { status: "completed", lastMergeSourceCommit: { commitId: "outro-commit" } });
  blocked(await cliAsync(fixture.root, args, env), "cleanup-blocked");
  api.pulls[0].lastMergeSourceCommit.commitId = delivered.pushed_sha;
  assert.equal(ok(await cliAsync(fixture.root, args, env)).proof, "pull-request");
  assert.equal(fs.existsSync(front.work_tree), false);
});

test("lock recusa segundo dono vivo, recupera dono encerrado e vale para todas as frentes", async (context) => {
  const fixture = sandbox(context);
  const front = openFront(fixture);
  const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"]);
  context.after(() => holder.kill());
  ok(cli(fixture.root, "lock", "acquire", "e2e-stack", "--pid", String(holder.pid), "--owner", "us-101"));
  const busy = blocked(cli(front.work_tree, "lock", "acquire", "e2e-stack", "--pid", String(process.pid), "--owner", "us-102"), "lock-busy");
  assert.deepEqual([busy.holder.pid, busy.holder.owner], [holder.pid, "us-101"]);
  assert.equal(ok(cli(front.work_tree, "lock", "status", "e2e-stack")).holder.pid, holder.pid);
  blocked(cli(fixture.root, "lock", "release", "e2e-stack", "--pid", String(process.pid)), "lock-busy");
  holder.kill();
  await once(holder, "exit");
  assert.equal(ok(cli(fixture.root, "lock", "status", "e2e-stack")).holder, null);
  ok(cli(front.work_tree, "lock", "acquire", "e2e-stack", "--pid", String(process.pid), "--owner", "us-102"));
  ok(cli(fixture.root, "lock", "release", "e2e-stack", "--pid", String(process.pid)));
  assert.equal(ok(cli(fixture.root, "lock", "status", "e2e-stack")).holder, null);
  blocked(cli(fixture.root, "lock", "acquire", "../fora", "--pid", String(process.pid)), "lock");
});
