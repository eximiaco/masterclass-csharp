// commit, sync e finish contra Git local com remoto bare; PR real só via API simulada.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { sandbox, cli, cliAsync, write, openFront, commitChange, compilePackage, adoServer, Executor, PackagesDir } from "./test-fixture.mjs";

const ok = (result) => {
  assert.equal(result.code, 0, JSON.stringify(result));
  return result;
};
const blocked = (result, step) => {
  assert.equal(result.code, 1, JSON.stringify(result));
  assert.equal(result.step, step, JSON.stringify(result));
  return result;
};
const remoteTip = (fixture, branch) => fixture.otherGit("ls-remote", "origin", `refs/heads/${branch}`).split("\t")[0];

test("commit grava só os paths pedidos, preserva staging alheio e devolve fatos do checkpoint", (context) => {
  const fixture = sandbox(context);
  const front = openFront(fixture);
  const parent = front.git("rev-parse", "HEAD");
  write(front.work_tree, "src/app.mjs", "export const version = 2;\n");
  write(front.work_tree, "src/new.mjs", "export const created = true;\n");
  write(front.work_tree, "src/staged.mjs", "trabalho de outra unidade\n");
  front.git("add", "--", "src/staged.mjs");
  const committed = ok(cli(front.work_tree, "commit", "--message", "feat(app): versão 2", "--paths", "src/app.mjs", "src/new.mjs"));
  assert.deepEqual(committed.changed_paths, ["src/app.mjs", "src/new.mjs"]);
  assert.equal(committed.parent_sha, parent);
  assert.equal(committed.commit_sha, front.git("rev-parse", "HEAD"));
  assert.equal(committed.branch, "feature/us-101");
  assert.equal(committed.worktree, front.work_tree);
  assert.equal(front.git("status", "--porcelain"), "A  src/staged.mjs");
  assert.equal(remoteTip(fixture, "feature/us-101"), "");
  fs.rmSync(path.join(front.work_tree, "src/new.mjs"));
  assert.deepEqual(ok(cli(front.work_tree, "commit", "--message", "refactor(app): remove módulo", "--paths", "src/new.mjs")).changed_paths, ["src/new.mjs"]);
});

test("commit recusa path sem alteração, estado efêmero, mensagem inválida, pasta principal e branch errada", (context) => {
  const fixture = sandbox(context);
  const front = openFront(fixture);
  write(front.work_tree, "src/app.mjs", "export const version = 2;\n");
  const head = front.git("rev-parse", "HEAD");
  blocked(cli(front.work_tree, "commit", "--message", "feat(app): x", "--paths", "src/untouched.mjs"), "commit-path");
  blocked(cli(front.work_tree, "commit", "--message", "feat(app): x", "--paths", `${PackagesDir}/workspace.json`), "commit-path");
  blocked(cli(front.work_tree, "commit", "--message", "feat(app): x", "--paths", "../fora.mjs"), "commit-path");
  blocked(cli(front.work_tree, "commit", "--message", "mensagem livre", "--paths", "src/app.mjs"), "commit-message");
  blocked(cli(front.work_tree, "commit", "--message", "feat(app): x"), "arguments");
  write(fixture.root, "src/app.mjs", "edição na pasta principal\n");
  blocked(cli(fixture.root, "commit", "--message", "feat(app): x", "--paths", "src/app.mjs"), "workspace-required");
  front.git("checkout", "-qb", "desvio");
  blocked(cli(front.work_tree, "commit", "--message", "feat(app): x", "--paths", "src/app.mjs"), "branch");
  assert.equal(front.git("rev-parse", "HEAD"), head);
});

test("sync sem novidade não mescla; com novidade mescla e registra a base sincronizada", (context) => {
  const fixture = sandbox(context);
  const front = openFront(fixture);
  commitChange(front, "src/app.mjs", "export const version = 2;\n");
  const head = front.git("rev-parse", "HEAD");
  assert.equal(ok(cli(front.work_tree, "sync")).changed, false);
  assert.equal(front.git("rev-parse", "HEAD"), head);
  const landed = fixture.landOnMain({ "src/other.mjs": "export const other = 1;\n" });
  const synced = ok(cli(front.work_tree, "sync"));
  assert.equal(synced.changed, true);
  assert.deepEqual(synced.files, { total: 1, items: ["src/other.mjs"] });
  assert.equal(synced.synced_base_sha, landed);
  assert.equal(synced.head, front.git("rev-parse", "HEAD"));
  assert.equal(ok(cli(front.work_tree, "status")).base_behind, undefined);
  assert.equal(ok(cli(front.work_tree, "sync")).changed, false);
  assert.equal(fixture.git("stash", "list"), "");
});

test("sync com conflito aborta por padrão; --keep-conflict abre o merge e --conclude finaliza", (context) => {
  const fixture = sandbox(context);
  const front = openFront(fixture);
  commitChange(front, "src/app.mjs", "export const version = 'frente';\n");
  const head = front.git("rev-parse", "HEAD");
  fixture.landOnMain({ "src/app.mjs": "export const version = 'terceiro';\n" });
  const aborted = blocked(cli(front.work_tree, "sync"), "sync-conflict");
  assert.deepEqual(aborted.conflicts, { total: 1, items: ["src/app.mjs"] });
  assert.equal(aborted.merge_open, false);
  assert.equal(front.git("status", "--porcelain"), "");
  assert.equal(front.git("rev-parse", "HEAD"), head);
  assert.equal(blocked(cli(front.work_tree, "sync", "--keep-conflict"), "sync-conflict").merge_open, true);
  blocked(cli(front.work_tree, "sync"), "merge-open");
  blocked(cli(front.work_tree, "finish"), "dirty-tree");
  blocked(cli(front.work_tree, "sync", "--conclude"), "sync-conflict");
  write(front.work_tree, "src/app.mjs", "export const version = 'combinado';\n");
  front.git("add", "--", "src/app.mjs");
  const concluded = ok(cli(front.work_tree, "sync", "--conclude"));
  assert.equal(concluded.concluded, true);
  assert.equal(front.git("rev-list", "--parents", "-n", "1", "HEAD").split(" ").length, 3);
  blocked(cli(front.work_tree, "sync", "--conclude"), "merge-not-open");
});

test("sync recusa árvore com alteração rastreada pendente", (context) => {
  const fixture = sandbox(context);
  const front = openFront(fixture);
  fixture.landOnMain({ "src/other.mjs": "export const other = 1;\n" });
  write(front.work_tree, "src/app.mjs", "sem commit\n");
  blocked(cli(front.work_tree, "sync"), "dirty-tree");
  assert.equal(fs.readFileSync(path.join(front.work_tree, "src/app.mjs"), "utf8"), "sem commit\n");
});

test("finish só publica árvore limpa com commits; mantém o worktree e republica após review", (context) => {
  const fixture = sandbox(context);
  const front = openFront(fixture);
  blocked(cli(front.work_tree, "finish"), "nothing-to-deliver");
  write(front.work_tree, "src/solto.mjs", "não commitado\n");
  blocked(cli(front.work_tree, "finish"), "dirty-tree");
  fs.rmSync(path.join(front.work_tree, "src/solto.mjs"));
  commitChange(front, "src/app.mjs", "export const version = 2;\n");
  const delivered = ok(cli(front.work_tree, "finish"));
  assert.equal(delivered.pushed, true);
  assert.equal(delivered.pull_request.mode, "manual");
  assert.equal(delivered.pushed_sha, front.git("rev-parse", "HEAD"));
  assert.equal(remoteTip(fixture, "feature/us-101"), delivered.pushed_sha);
  assert.equal(front.git("rev-parse", "--abbrev-ref", "@{u}"), "origin/feature/us-101");
  const status = ok(cli(front.work_tree, "status"));
  assert.equal(status.phase, "delivered");
  assert.equal(fs.existsSync(front.work_tree), true);
  assert.equal(ok(cli(front.work_tree, "finish")).pushed, false);
  commitChange(front, "src/app.mjs", "export const version = 3;\n", "fix(app): ajuste de review");
  assert.equal(ok(cli(front.work_tree, "status")).phase, "unpublished");
  assert.equal(ok(cli(front.work_tree, "finish")).pushed, true);
  assert.equal(remoteTip(fixture, "feature/us-101"), front.git("rev-parse", "HEAD"));
});

test("finish segue quando a base andou em arquivos disjuntos e bloqueia com sobreposição", (context) => {
  const fixture = sandbox(context);
  const disjoint = openFront(fixture, "101");
  commitChange(disjoint, "src/app.mjs", "export const version = 2;\n");
  fixture.landOnMain({ "src/other.mjs": "export const other = 1;\n" });
  assert.equal(ok(cli(disjoint.work_tree, "finish")).pushed, true);
  const overlapping = openFront(fixture, "102");
  commitChange(overlapping, "src/other.mjs", "export const other = 'frente';\n");
  fixture.landOnMain({ "src/other.mjs": "export const other = 'terceiro';\n" });
  const moved = blocked(cli(overlapping.work_tree, "finish"), "base-moved");
  assert.deepEqual(moved.overlap, { total: 1, items: ["src/other.mjs"] });
  assert.equal(remoteTip(fixture, "feature/us-102"), "");
});

test("finish recusa pacote em execução com gates pendentes", (context) => {
  const fixture = sandbox(context);
  const front = openFront(fixture);
  commitChange(front, "src/app.mjs", "export const version = 2;\n");
  const manifest = compilePackage(front.work_tree, "us-101");
  assert.equal(spawnSync(process.execPath, [Executor, "begin", "--manifest", manifest], { cwd: front.work_tree }).status, 0);
  const pending = blocked(cli(front.work_tree, "finish"), "package-pending");
  assert.deepEqual(pending.packages, [{ id: "us-101", execution: "planned" }]);
  assert.equal(remoteTip(fixture, "feature/us-101"), "");
});

test("finish cria o PR pela API do provedor e reaproveita o PR aberto", async (context) => {
  const api = await adoServer(context);
  const fixture = sandbox(context, { remoteUrl: api.remoteUrl });
  const front = openFront(fixture);
  commitChange(front, "src/app.mjs", "export const version = 2;\n");
  const env = { AZURE_DEVOPS_PAT: "pat-de-teste" };
  const created = ok(await cliAsync(front.work_tree, ["finish", "--pr-footer", "rodapé do harness"], env));
  assert.deepEqual([created.pull_request.mode, created.pull_request.number], ["created", 7]);
  assert.equal(api.pulls[0].title, "User Story 101: Exportar CSV");
  assert.match(api.pulls[0].description, /feat\(app\): altera fonte[\s\S]*rodapé do harness$/);
  assert.equal(api.pulls[0].sourceRefName, "refs/heads/feature/us-101");
  assert.equal(api.requests[0].authorization, `Basic ${Buffer.from(":pat-de-teste").toString("base64")}`);
  assert.equal(api.requests.every((request) => request.url.startsWith("/org/Follow%20the%20Code/_apis/git/repositories/repo/pullrequests")), true);
  commitChange(front, "src/app.mjs", "export const version = 3;\n", "fix(app): ajuste de review");
  const reused = ok(await cliAsync(front.work_tree, ["finish"], env));
  assert.deepEqual([reused.pull_request.mode, reused.pull_request.number, reused.pushed], ["existing", 7, true]);
  assert.equal(api.pulls.length, 1);
  const withoutPat = ok(await cliAsync(front.work_tree, ["finish"], { AZURE_DEVOPS_PAT: "" }));
  assert.equal(withoutPat.pull_request.mode, "manual");
  assert.match(withoutPat.pull_request.create_url, /pullrequestcreate\?sourceRef=feature%2Fus-101&targetRef=main$/);
});
