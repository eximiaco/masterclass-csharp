import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { sandbox, Manifest, CheckpointState, finishUnits, obligations, commitCheckpoint } from "./test-fixture.mjs";
import { archivePath } from "./lib/retention.mjs";
import { json } from "./lib/storage.mjs";

const ok = (result) => assert.equal(result.code, 0, JSON.stringify(result));
const present = (fixture, relative) => fs.existsSync(path.join(fixture.root, relative));
const archive = (fixture) => JSON.parse(fs.readFileSync(path.join(fixture.root, archivePath(fixture.statePath)), "utf8"));

function closure(fixture, files = [], eventPath = ".harness/workspace/closure.json") {
  const check = { result: "passed", exit_code: 0, command: "fixture check", artifacts: [fixture.ref(".harness/audits/proof.txt")] };
  fixture.json(eventPath, {
    schema_version: 1,
    discovery: check,
    references: check,
    affected: check,
    retirement: { schema_version: 1, package_id: "sample", execution_id: fixture.state().execution_id, files },
  });
  return fixture.operation("close", "--event", eventPath);
}

test("close retira estado operacional e preserva consulta/idempotência no arquivo final", (context) => {
  const fixture = sandbox(context);
  finishUnits(fixture);
  obligations(fixture);
  const before = fixture.git("rev-parse", "HEAD");
  ok(fixture.close());
  assert.equal(present(fixture, fixture.statePath), false);
  assert.equal(present(fixture, path.posix.dirname(fixture.statePath)), false);
  assert.equal(present(fixture, ".harness/audits/proof.txt"), true);
  assert.equal(fixture.operation("status").result.obligations.cleanup, false);
  assert.equal(fixture.operation("status").result.archive, archivePath(fixture.statePath));
  ok(fixture.operation("close"));
  ok(fixture.operation("retire"));
  assert.equal(present(fixture, fixture.statePath), false);
  assert.equal(fixture.git("rev-parse", "HEAD"), before);
});

for (const status of ["planned", "running", "paused", "blocked"]) {
  test(`retire preserva execução ${status}`, (context) => {
    const fixture = sandbox(context);
    if (status === "running") ok(fixture.start("a"));
    if (["paused", "blocked"].includes(status)) ok(fixture.event({ type: "stop", status, reason: "preservar" }));
    const before = fs.readFileSync(path.join(fixture.root, fixture.statePath));
    assert.equal(fixture.operation("retire").code, 1);
    assert.deepEqual(fs.readFileSync(path.join(fixture.root, fixture.statePath)), before);
    assert.equal(present(fixture, Manifest), true);
    assert.equal(present(fixture, archivePath(fixture.statePath)), false);
  });
}

test("auxiliar desconhecido bloqueia antes da retirada do pacote; inventário próprio libera", (context) => {
  const fixture = sandbox(context);
  finishUnits(fixture);
  obligations(fixture);
  const auxiliary = `${path.posix.dirname(fixture.statePath)}/normalization.json`;
  fixture.write(auxiliary, "auxiliar próprio");
  assert.equal(fixture.close().code, 1);
  assert.equal(present(fixture, Manifest), true);
  assert.equal(present(fixture, auxiliary), true);
  ok(fixture.operation("resume", "--reason", "Ownership do auxiliar conferido"));
  const event = `${path.posix.dirname(fixture.statePath)}/closure.json`;
  ok(closure(fixture, [fixture.ref(auxiliary)], event));
  assert.equal(present(fixture, auxiliary), false);
  assert.equal(present(fixture, event), false);
  ok(fixture.operation("close", "--event", event));
});

test("test-results retira somente execução própria e mantém resultados alheios", (context) => {
  const fixture = sandbox(context);
  finishUnits(fixture);
  obligations(fixture);
  const own = `.harness/workspace/test-results/sample/${fixture.state().execution_id}/result.json`;
  const other = ".harness/workspace/test-results/other/active/result.json";
  const notes = ".harness/workspace/package-executions/unrelated/notes.json";
  fixture.write(notes, "metadado alheio fora da execução");
  fixture.write(own, "resultado já arquivado");
  fixture.write(other, "resultado alheio");
  ok(closure(fixture, [fixture.ref(own)]));
  assert.equal(present(fixture, own), false);
  assert.equal(fs.readFileSync(path.join(fixture.root, other), "utf8"), "resultado alheio");
  assert.equal(fs.readFileSync(path.join(fixture.root, notes), "utf8"), "metadado alheio fora da execução");
});

for (const issue of ["hash", "foreign", "symlink", "hardlink", "tracked", "tracked-state", "tracked-glob"]) {
  test(`inventário ${issue} bloqueia sem apagar dados`, (context) => {
    const fixture = sandbox(context);
    finishUnits(fixture);
    obligations(fixture);
    const own = `${path.posix.dirname(fixture.statePath)}/${issue === "tracked-glob" ? "candidate[1].json" : "candidate.json"}`;
    fixture.write(own, "original");
    let ref = fixture.ref(own);
    if (issue === "hash") fixture.write(own, "alterado");
    if (issue === "foreign") ref = fixture.ref("source.mjs");
    if (issue === "symlink") {
      fs.unlinkSync(path.join(fixture.root, own));
      fs.symlinkSync(path.join(fixture.root, "source.mjs"), path.join(fixture.root, own));
    }
    if (issue === "hardlink") {
      fs.unlinkSync(path.join(fixture.root, own));
      fs.linkSync(path.join(fixture.root, "source.mjs"), path.join(fixture.root, own));
    }
    if (issue === "tracked") fixture.git("add", "--", own);
    if (issue === "tracked-state") fixture.git("add", "--", fixture.statePath);
    if (issue === "tracked-glob") fixture.git("--literal-pathspecs", "add", "--", own);
    assert.equal(closure(fixture, [ref]).code, 1);
    assert.equal(present(fixture, own), true);
    assert.equal(present(fixture, Manifest), true);
  });
}

test("checkpoint usado por outro pacote ativo permanece no workspace", (context) => {
  const fixture = sandbox(context, true);
  ok(fixture.start("a"));
  commitCheckpoint(fixture);
  ok(fixture.validate("a"));
  ok(fixture.event({ type: "checkpoint-verified", checkpoint_id: "a-ready", checkpoint_state: CheckpointState }));
  ok(fixture.complete("a"));
  ok(fixture.start("i"));
  ok(fixture.validate("i"));
  ok(fixture.complete("i"));
  obligations(fixture);
  const branch = fixture.git("branch", "--show-current");
  fixture.git("checkout", "-qb", "other");
  const other = fixture.call("begin", "--manifest", Manifest);
  ok(other);
  fixture.git("checkout", branch);
  ok(fixture.close());
  assert.equal(present(fixture, CheckpointState), true);
  assert.equal(present(fixture, other.result.state), true);
  assert.equal(archive(fixture).checkpoint, null);
});

test("retire de legado preserva história após rename da branch e evolução dos inputs", (context) => {
  const fixture = sandbox(context);
  finishUnits(fixture);
  obligations(fixture);
  ok(fixture.close());
  const record = archive(fixture);
  fixture.write(fixture.statePath, json(record.state));
  fs.unlinkSync(path.join(fixture.root, archivePath(fixture.statePath)));
  fixture.git("branch", "-m", "feature/us-legacy");
  fixture.write("source.mjs", "evolução posterior\n");
  ok(fixture.operation("retire"));
  assert.equal(present(fixture, fixture.statePath), false);
  assert.equal(fixture.operation("status").result.status, "completed");
  assert.equal(fs.readFileSync(path.join(fixture.root, "source.mjs"), "utf8"), "evolução posterior\n");
});

test("retire de legado não apaga checkpoint bloqueado posteriormente", (context) => {
  const fixture = sandbox(context, true);
  ok(fixture.start("a"));
  commitCheckpoint(fixture);
  ok(fixture.validate("a"));
  ok(fixture.event({ type: "checkpoint-verified", checkpoint_id: "a-ready", checkpoint_state: CheckpointState }));
  ok(fixture.complete("a"));
  ok(fixture.start("i"));
  ok(fixture.validate("i"));
  ok(fixture.complete("i"));
  obligations(fixture);
  ok(fixture.close());
  const record = archive(fixture);
  fixture.write(fixture.statePath, json(record.state));
  const checkpoint = record.checkpoint.snapshot;
  checkpoint.checkpoints["a-ready"].status = "blocked";
  fixture.json(CheckpointState, checkpoint);
  fs.unlinkSync(path.join(fixture.root, archivePath(fixture.statePath)));
  ok(fixture.operation("retire"));
  assert.equal(present(fixture, CheckpointState), true);
});

for (const intended of [true, false]) {
  test(`retirada parcial ${intended ? "retoma intenção" : "recusa ausência sem intenção"}`, (context) => {
    const fixture = sandbox(context);
    finishUnits(fixture);
    obligations(fixture);
    const own = `${path.posix.dirname(fixture.statePath)}/discard.json`;
    fixture.write(own, "descartável");
    ok(closure(fixture, [fixture.ref(own)]));
    const record = archive(fixture);
    record.status = "removing";
    delete record.removals[fixture.statePath];
    if (intended) record.removals[own] = "removing";
    else delete record.removals[own];
    fixture.write(fixture.statePath, json(record.state));
    fixture.json(archivePath(fixture.statePath), record);
    const result = fixture.operation("retire");
    assert.equal(result.code, intended ? 0 : 1, JSON.stringify(result));
    assert.equal(present(fixture, fixture.statePath), !intended);
  });
}

test("arquivo final alterado ou operacional recriado bloqueia sem expurgo", (context) => {
  const fixture = sandbox(context);
  finishUnits(fixture);
  obligations(fixture);
  ok(fixture.close());
  const proof = fs.readFileSync(path.join(fixture.root, ".harness/audits/proof.txt"));
  fixture.write(".harness/audits/proof.txt", "prova alterada");
  assert.equal(fixture.operation("status").code, 1);
  fixture.write(".harness/audits/proof.txt", proof);
  fixture.write(fixture.statePath, "arquivo recriado por outro processo");
  assert.equal(fixture.operation("retire").code, 1);
  assert.equal(fs.readFileSync(path.join(fixture.root, fixture.statePath), "utf8"), "arquivo recriado por outro processo");
});
