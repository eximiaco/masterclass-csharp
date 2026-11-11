import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { sandbox, Manifest, PackageDir, CheckpointState } from "./test-fixture.mjs";
import { hash } from "./lib/storage.mjs";
import { loadPackage } from "./lib/package.mjs";

function declareInput(fixture, relative, sha256) {
  const original = fs.readFileSync(path.join(fixture.root, Manifest), "utf8").split("\npackage_inputs:")[0];
  fixture.write(Manifest, `${original}\npackage_inputs:\n  - path: ${JSON.stringify(relative)}\n    sha256: ${sha256}\n`);
}

function inputFixture(context) {
  const fixture = sandbox(context);
  fixture.write(`${PackageDir}/fixtures/item.json`, '{"total":10}\n');
  declareInput(fixture, "./fixtures/item.json", fixture.ref(`${PackageDir}/fixtures/item.json`).sha256);
  return fixture;
}

function record(fixture, statePath, value) {
  fixture.json(".harness/workspace/event.json", { schema_version: 1, ...value });
  const result = fixture.call("record", "--state", statePath, "--event", ".harness/workspace/event.json");
  assert.equal(result.code, 0, JSON.stringify(result));
}

function closeWithInput(fixture, statePath) {
  for (const unit_id of ["a", "i"]) {
    record(fixture, statePath, { type: "unit-started", unit_id });
    record(fixture, statePath, { type: "unit-validated", unit_id, ...fixture.proof() });
    record(fixture, statePath, { type: "unit-completed", unit_id });
  }
  record(fixture, statePath, { type: "learning-evaluated", classification: "none", reason: "Contrato coberto pelo teste" });
  record(fixture, statePath, { type: "delivery-recorded", mode: "local", evidence: [fixture.ref(".harness/audits/proof.txt")] });
  const check = { result: "passed", exit_code: 0, command: "fixture check", artifacts: [fixture.ref(".harness/audits/proof.txt")] };
  fixture.json(".harness/workspace/closure.json", { schema_version: 1, discovery: check, references: check, affected: check });
  return fixture.call("close", "--state", statePath, "--event", ".harness/workspace/closure.json");
}

test("input declarado com hash integra inventário e retirada exata", (context) => {
  const fixture = inputFixture(context);
  fixture.git("checkout", "-qb", "with-input");
  const begun = fixture.call("begin", "--manifest", Manifest);
  assert.equal(begun.code, 0, JSON.stringify(begun));
  const closed = closeWithInput(fixture, begun.result.state);
  assert.equal(closed.code, 0, JSON.stringify(closed));
  assert.equal(closed.result.receipt.removed, 6);
  assert.equal(fs.existsSync(path.join(fixture.root, PackageDir)), false);
  assert.equal(fs.existsSync(path.join(fixture.root, "source.mjs")), true);
});

for (const relative of ["../source.mjs", "/source.mjs", "fixtures/../a.md", "fixtures\\item.json", "", ".env"]) {
  test(`input rejeita path fora do contrato: ${JSON.stringify(relative)}`, (context) => {
    const fixture = inputFixture(context);
    if (relative === ".env") fixture.write(`${PackageDir}/.env`, "credencial de teste");
    declareInput(fixture, relative, "a".repeat(64));
    assert.throws(() => loadPackage(fixture.root, Manifest));
    assert.equal(fs.existsSync(path.join(fixture.root, `${PackageDir}/fixtures/item.json`)), true);
  });
}

for (const invalid of ["missing", "hash", "duplicate", "symlink", "hardlink", "unknown", "shape", "null"]) {
  test(`input ${invalid} bloqueia sem remover arquivos`, (context) => {
    const fixture = inputFixture(context);
    const filename = path.join(fixture.root, `${PackageDir}/fixtures/item.json`);
    if (invalid === "missing") fs.unlinkSync(filename);
    if (invalid === "hash") fixture.write(`${PackageDir}/fixtures/item.json`, "alterado");
    if (invalid === "duplicate") fs.appendFileSync(path.join(fixture.root, Manifest), `  - path: fixtures/item.json\n    sha256: ${fixture.ref(`${PackageDir}/fixtures/item.json`).sha256}\n`);
    if (["symlink", "hardlink"].includes(invalid)) {
      fs.unlinkSync(filename);
      fs[invalid === "symlink" ? "symlinkSync" : "linkSync"](path.join(fixture.root, "source.mjs"), filename);
    }
    if (invalid === "unknown") fixture.write(`${PackageDir}/fixtures/unlisted.json`, "alheio");
    if (invalid === "shape" || invalid === "null") {
      const original = fs.readFileSync(path.join(fixture.root, Manifest), "utf8").split("\npackage_inputs:")[0];
      fixture.write(Manifest, `${original}\npackage_inputs: ${invalid === "null" ? "null" : "42"}\n`);
    }
    assert.throws(() => loadPackage(fixture.root, Manifest));
    assert.equal(fs.readFileSync(path.join(fixture.root, "source.mjs"), "utf8"), "export const result = 1;\n");
  });
}

test("input alterado após begin bloqueia retomada e preserva pacote", (context) => {
  const fixture = inputFixture(context);
  fixture.git("checkout", "-qb", "with-input");
  const begun = fixture.call("begin", "--manifest", Manifest);
  assert.equal(begun.code, 0);
  fixture.write(`${PackageDir}/fixtures/item.json`, "alterado");
  const result = fixture.call("resume", "--state", begun.result.state);
  assert.equal(result.code, 1);
  assert.equal(fs.readFileSync(path.join(fixture.root, `${PackageDir}/fixtures/item.json`), "utf8"), "alterado");
});

for (const changed of [false, true]) {
  test(`checkpoint confere normalização Git e ${changed ? "rejeita mudança real" : "aceita CRLF validado"}`, (context) => {
    const fixture = sandbox(context, true);
    fixture.git("config", "core.autocrlf", "input");
    fixture.write(".gitattributes", "* text=auto\n");
    fixture.write("source.mjs", "export const result = 2;\r\n");
    assert.equal(fixture.start("a").code, 0);
    assert.equal(fixture.validate("a").code, 0);
    const parent = fixture.git("rev-parse", "HEAD");
    fixture.git("add", "--", ".gitattributes", "source.mjs");
    fixture.git("commit", "-qm", "fix: normalização");
    const sha = fixture.git("rev-parse", "HEAD");
    const input = fixture.ref("source.mjs");
    assert.notEqual(input.sha256, hash(fixture.git("show", `${sha}:source.mjs`) + "\n"));
    fixture.json(CheckpointState, {
      schema_version: 1, package_id: "sample", checkpoints: {
        "a-ready": { status: "committed", commit_sha: sha, parent_sha: parent,
          branch: fixture.git("branch", "--show-current"), worktree: fixture.root,
          changed_paths: [".gitattributes", "source.mjs"], validation_refs: [".harness/audits/proof.txt"],
          input_hashes: { "source.mjs": input.sha256 } }
      }
    });
    if (changed) {
      fixture.write("source.mjs", "export const result = 3;\r\n");
      assert.equal(fixture.operation("resume").code, 1);
      assert.equal(fixture.operation("resume", "--reason", "Input alterado exige nova prova").code, 0);
      assert.equal(fixture.start("a").code, 0);
      assert.equal(fixture.validate("a").code, 0);
      const checkpoint = JSON.parse(fs.readFileSync(path.join(fixture.root, CheckpointState), "utf8"));
      checkpoint.checkpoints["a-ready"].input_hashes["source.mjs"] = fixture.ref("source.mjs").sha256;
      fixture.json(CheckpointState, checkpoint);
    }
    const result = fixture.event({ type: "checkpoint-verified", checkpoint_id: "a-ready", checkpoint_state: CheckpointState });
    assert.equal(result.code, changed ? 1 : 0, JSON.stringify(result));
    if (changed) assert.match(result.message, /Conteúdo do commit divergente/);
  });
}
