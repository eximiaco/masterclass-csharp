import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { sandbox, Manifest, PackageDir, CheckpointState, finishUnits, obligations, commitCheckpoint, Helper } from "./test-fixture.mjs";
import { spawnSync } from "node:child_process";
import { loadPackage } from "./lib/package.mjs";

function expectOk(result) {
  assert.equal(result.code, 0, JSON.stringify(result));
  return result;
}
function expectBlocked(result) {
  assert.equal(result.code, 1, JSON.stringify(result));
  assert.equal(result.status, "blocked");
}

for (const reason of ["", "reason: null\n", 'reason: "Estratégia definida"\n']) {
  test(`estratégia ready aceita justificativa opcional: ${reason.trim() || "ausente"}`, (context) => {
    const fixture = sandbox(context);
    fixture.write(`${PackageDir}/test-strategy.yaml`, `status: ready\n${reason}`);
    assert.doesNotThrow(() => loadPackage(fixture.root, Manifest));
  });
}

test("estratégia not-applicable aceita justificativa preenchida", (context) => {
  const fixture = sandbox(context);
  fixture.write(`${PackageDir}/test-strategy.yaml`, 'status: not-applicable\nreason: "Alteração somente documental"\n');
  assert.doesNotThrow(() => loadPackage(fixture.root, Manifest));
});

for (const reason of ["", "reason: null\n", 'reason: ""\n', 'reason: "   "\n', "reason: 42\n", "reason: true\n"]) {
  test(`estratégia not-applicable rejeita justificativa inválida: ${reason.trim() || "ausente"}`, (context) => {
    const fixture = sandbox(context);
    fixture.write(`${PackageDir}/test-strategy.yaml`, `status: not-applicable\n${reason}`);
    assert.throws(() => loadPackage(fixture.root, Manifest), { message: "Estratégia not-applicable exige justificativa" });
  });
}

for (const status of ["needs-resolution", "unknown"]) {
  test(`estratégia ${status} bloqueia mesmo com justificativa`, (context) => {
    const fixture = sandbox(context);
    fixture.write(`${PackageDir}/test-strategy.yaml`, `status: ${status}\nreason: "Justificativa preenchida"\n`);
    assert.throws(() => loadPackage(fixture.root, Manifest), { message: "Estratégia não está pronta" });
  });
}

test("DAG libera gate técnico e separa conclusão de owner/checkpoint", (context) => {
  const fixture = sandbox(context, true);
  expectBlocked(fixture.start("i"));
  expectOk(fixture.operation("resume", "--reason", "Dependência será implementada"));
  expectOk(fixture.start("a"));
  const sha = commitCheckpoint(fixture);
  expectOk(fixture.validate("a"));
  expectBlocked(fixture.complete("a"));
  expectOk(fixture.operation("resume", "--reason", "Commit observado e verificado"));
  assert.deepEqual(fixture.operation("next").result.eligible, []);
  expectOk(fixture.event({ type: "checkpoint-verified", checkpoint_id: "a-ready", checkpoint_state: CheckpointState }));
  expectOk(fixture.complete("a"));
  assert.deepEqual(fixture.operation("next").result.eligible, ["i"]);
  assert.equal(fixture.git("rev-parse", "HEAD"), sha);
  expectOk(fixture.operation("resume"));
  assert.equal(fixture.git("rev-list", "--count", "HEAD"), "2");
});

test("begin idempotente não duplica execução; next não retorna specs nem provas integrais", (context) => {
  const fixture = sandbox(context);
  assert.equal(expectOk(fixture.call("begin", "--manifest", Manifest)).result.state, fixture.statePath);
  assert.deepEqual(fixture.operation("next").result.eligible, ["a"]);
  assert.equal(fixture.operation("status").result.manifest, undefined);
  assert.equal(fixture.operation("status", "--full").result.manifest.id, "sample");
});

test("pausa exige retomada explícita e preserva pacote", (context) => {
  const fixture = sandbox(context);
  expectOk(fixture.event({ type: "stop", status: "paused", reason: "Pedido do usuário" }));
  expectBlocked(fixture.operation("resume"));
  assert.equal(fixture.state().status, "paused");
  expectBlocked(fixture.close());
  assert.equal(fs.existsSync(path.join(fixture.root, Manifest)), true);
  expectOk(fixture.operation("resume", "--resume-paused", "--reason", "Usuário pediu retomar"));
});

test("running sem confirmação vira obrigação interrupted em processo novo", (context) => {
  const fixture = sandbox(context);
  expectOk(fixture.start("a"));
  expectOk(fixture.operation("resume"));
  assert.equal(fixture.state().units.a.status, "blocked");
  assert.equal(fixture.operation("next").result.obligations.interrupted[0].unit_id, "a");
  expectOk(fixture.start("a"));
  expectOk(fixture.validate("a"));
  expectOk(fixture.complete("a"));
});

test("falha mais recente invalida prova anterior; inputs alterados exigem revalidação afetada", (context) => {
  const fixture = sandbox(context);
  expectOk(fixture.start("a"));
  expectOk(fixture.validate("a"));
  expectBlocked(fixture.event({ type: "unit-validated", unit_id: "a", ...fixture.proof(), result: "failed" }));
  assert.equal(fixture.state().units.a.validation, undefined);
  expectOk(fixture.operation("resume", "--reason", "Falha corrigida"));
  expectOk(fixture.start("a"));
  expectOk(fixture.validate("a"));
  expectOk(fixture.complete("a"));
  fixture.write("source.mjs", "changed");
  expectBlocked(fixture.operation("resume"));
  assert.equal(fixture.state().units.a.validation, undefined);
  expectOk(fixture.operation("resume", "--reason", "Input mudou; validação afetada reiniciada"));
  expectOk(fixture.start("a"));
  expectOk(fixture.validate("a"));
});

test("close bloqueia aprendizado/entrega/checks pendentes e ausência sem intenção", (context) => {
  const fixture = sandbox(context);
  finishUnits(fixture);
  expectBlocked(fixture.close());
  assert.equal(fs.existsSync(path.join(fixture.root, Manifest)), true);
  expectOk(fixture.operation("resume", "--reason", "Registrar obrigações"));
  obligations(fixture);
  fs.unlinkSync(path.join(fixture.root, `${PackageDir}/a.md`));
  expectBlocked(fixture.close());
  assert.equal(fixture.state().removal, undefined);
});

test("retirada válida deixa recibos externos e repetição verifica provas/recriação", (context) => {
  const fixture = sandbox(context);
  finishUnits(fixture);
  obligations(fixture);
  const closed = expectOk(fixture.close());
  assert.equal(closed.result.status, "completed");
  assert.equal(fs.existsSync(path.join(fixture.root, PackageDir)), false);
  assert.equal(fixture.state().receipt.removed, 5);
  expectOk(fixture.operation("close"));
  fixture.write(`${PackageDir}/a.md`, "alheio");
  expectBlocked(fixture.operation("close"));
  assert.equal(fs.readFileSync(path.join(fixture.root, `${PackageDir}/a.md`), "utf8"), "alheio");
});

test("retoma retirada parcial por recibo sem remover arquivo alheio", (context) => {
  const fixture = sandbox(context);
  finishUnits(fixture);
  obligations(fixture);
  // Fronteira de crash após unlink e antes de recibo, com intenção persistida.
  const state = fixture.state();
  const proof = { result: "passed", exit_code: 0, command: "fixture", artifacts: [fixture.ref(".harness/audits/proof.txt")] };
  state.closure = { schema_version: 1, discovery: proof, references: proof, affected: proof };
  state.status = "finalizing";
  const removed = state.files[0];
  state.removal = { [removed.path]: { status: "removing", sha256: removed.sha256 } };
  fixture.json(fixture.statePath, state);
  fs.unlinkSync(path.join(fixture.root, removed.path));
  fixture.write("unowned.md", "preservar");
  expectOk(fixture.operation("resume"));
  expectOk(fixture.operation("close"));
  assert.equal(fs.readFileSync(path.join(fixture.root, "unowned.md"), "utf8"), "preservar");
});

for (const modification of ["unknown", "changed", "symlink", "hardlink"]) {
  test(`pacote ${modification} bloqueia e preserva bytes alheios`, (context) => {
    const fixture = sandbox(context);
    const filename = path.join(fixture.root, `${PackageDir}/a.md`);
    if (modification === "unknown") fixture.write(`${PackageDir}/extra.md`, "alheio");
    if (modification === "changed") fixture.write(`${PackageDir}/a.md`, "alheio");
    if (["symlink", "hardlink"].includes(modification)) {
      fs.unlinkSync(filename);
      if (modification === "symlink") fs.symlinkSync(path.join(fixture.root, "source.mjs"), filename);
      else fs.linkSync(path.join(fixture.root, "source.mjs"), filename);
    }
    const source = fs.readFileSync(path.join(fixture.root, "source.mjs"), "utf8");
    expectBlocked(fixture.operation("resume"));
    assert.equal(fs.readFileSync(path.join(fixture.root, "source.mjs"), "utf8"), source);
    expectBlocked(fixture.call("begin", "--manifest", Manifest));
  });
}

test("lock ativo/corrupto preserva estado; PID morto recupera", (context) => {
  const fixture = sandbox(context);
  const before = fs.readFileSync(path.join(fixture.root, fixture.statePath), "utf8");
  fixture.json(`${fixture.statePath}.lock`, { pid: process.pid, root: fixture.root });
  expectBlocked(fixture.start("a"));
  assert.equal(fs.readFileSync(path.join(fixture.root, fixture.statePath), "utf8"), before);
  fixture.write(`${fixture.statePath}.lock`, "{}");
  expectBlocked(fixture.start("a"));
  fixture.json(`${fixture.statePath}.lock`, { pid: 2147483647, root: fixture.root });
  expectOk(fixture.start("a"));
});

test("corrupção de estado e branch divergente nunca autorizam overwrite", (context) => {
  const fixture = sandbox(context);
  const before = fixture.state();
  fixture.write(fixture.statePath, "{corrupt");
  expectBlocked(fixture.operation("resume"));
  assert.equal(fs.readFileSync(path.join(fixture.root, fixture.statePath), "utf8"), "{corrupt");
  fixture.json(fixture.statePath, before);
  fixture.git("checkout", "-qb", "other");
  expectBlocked(fixture.operation("resume"));
  assert.deepEqual(fixture.state(), before);
});

test("manifesto cíclico/ID repetido/estratégia inválida falham sem apagar pacote", (context) => {
  const fixture = sandbox(context);
  const original = fs.readFileSync(path.join(fixture.root, Manifest), "utf8");
  for (const contents of [
    original.replace("depends_on: []", "depends_on: [i]"),
    original.replace("id: i", "id: a"),
    original.replace("work_type: development", "work_type: magical")
  ]) {
    fixture.write(Manifest, contents);
    expectBlocked(fixture.call("begin", "--manifest", Manifest));
  }
  fixture.write(Manifest, original);
  fixture.write(`${PackageDir}/test-strategy.yaml`, "status: needs-resolution\nreason: missing oracle\n");
  expectBlocked(fixture.call("begin", "--manifest", Manifest));
});

test("estado principal sobrevive em commonRepoRoot de linked worktree", (context) => {
  const fixture = sandbox(context);
  const linked = path.join(fixture.root, "linked");
  fixture.git("worktree", "add", "-qb", "linked", linked);
  for (const filename of ["execution-manifest.yaml", "a.md", "i.md", "test-strategy.yaml", "review-manifest.md"]) {
    const target = path.join(linked, PackageDir, filename);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(fixture.root, PackageDir, filename), target);
  }
  const outcome = spawnSync(process.execPath, [Helper, "begin", "--manifest", Manifest], { cwd: linked, encoding: "utf8" });
  assert.equal(outcome.status, 0, outcome.stdout);
  const statePath = JSON.parse(outcome.stdout).result.state;
  assert.equal(fs.existsSync(path.join(fixture.root, statePath)), true);
  assert.equal(fs.existsSync(path.join(linked, statePath)), false);
  fixture.git("worktree", "remove", "--force", linked);
  assert.equal(fs.existsSync(path.join(fixture.root, statePath)), true);
});

test("--repo opera o worktree da frente a partir de outro diretório; sem ele a identidade diverge", (context) => {
  const fixture = sandbox(context, false, true);
  const from = (cwd, ...args) => {
    const outcome = spawnSync(process.execPath, [Helper, ...args], { cwd, encoding: "utf8" });
    return { code: outcome.status, ...JSON.parse(outcome.stdout) };
  };
  expectBlocked(from(fixture.root, "status", "--state", fixture.statePath));
  const pointed = from(fixture.root, "status", "--state", fixture.statePath, "--repo", fixture.work);
  assert.equal(pointed.code, 0, JSON.stringify(pointed));
  assert.equal(pointed.result.status, "planned");
});

test("JSON não executa comandos e paths de evento/estado rejeitam traversal", (context) => {
  const fixture = sandbox(context);
  expectBlocked(fixture.event({ type: "exec", command: "touch breached" }));
  assert.equal(fs.existsSync(path.join(fixture.root, "breached")), false);
  expectBlocked(fixture.call("status", "--state", "../state.json"));
  expectBlocked(fixture.operation("record", "--event", "../event.json"));
});

test("checkpoint exige referência real correspondente ao provider validado", (context) => {
  const fixture = sandbox(context, true);
  expectOk(fixture.start("a"));
  commitCheckpoint(fixture);
  expectOk(fixture.validate("a"));
  assert.equal(fixture.state().units.a.interrupted, undefined);
  const external = JSON.parse(fs.readFileSync(path.join(fixture.root, CheckpointState), "utf8"));
  external.checkpoints["a-ready"].validation_refs = [".harness/audits/does-not-exist.txt"];
  fixture.json(CheckpointState, external);
  expectBlocked(fixture.event({ type: "checkpoint-verified", checkpoint_id: "a-ready", checkpoint_state: CheckpointState }));
  assert.equal(fixture.state().checkpoints["a-ready"], undefined);
  expectBlocked(fixture.start("i"));
});

test("destino de aprendizado removido bloqueia close e conserva inventário", (context) => {
  const fixture = sandbox(context);
  finishUnits(fixture);
  obligations(fixture);
  fixture.write(".harness/memory/MEMORY.md", "restrição útil");
  expectOk(
    fixture.event({
      type: "learning-evaluated",
      classification: "semantic",
      reason: "Restrição verificada",
      destination: fixture.ref(".harness/memory/MEMORY.md")
    })
  );
  fs.unlinkSync(path.join(fixture.root, ".harness/memory/MEMORY.md"));
  expectBlocked(fixture.close());
  assert.equal(fs.existsSync(path.join(fixture.root, Manifest)), true);
});

test("no-change exige fontes rastreadas inalteradas e prova, sem commit vazio", (context) => {
  const fixture = sandbox(context, true);
  expectOk(fixture.start("a"));
  expectOk(fixture.validate("a"));
  fixture.json(CheckpointState, {
    schema_version: 1,
    package_id: "sample",
    checkpoints: {
      "a-ready": {
        status: "no-change",
        source_revision: fixture.git("rev-parse", "HEAD"),
        branch: fixture.git("branch", "--show-current"),
        worktree: fixture.root,
        no_change_reason: "Contrato já implementado e validado",
        validation_refs: [".harness/audits/proof.txt"],
        input_hashes: { "source.mjs": fixture.ref("source.mjs").sha256 },
        evidence: [fixture.ref(".harness/audits/proof.txt")]
      }
    }
  });
  expectOk(fixture.event({ type: "checkpoint-verified", checkpoint_id: "a-ready", checkpoint_state: CheckpointState }));
  expectOk(fixture.complete("a"));
  assert.equal(fixture.git("rev-list", "--count", "HEAD"), "1");
});
