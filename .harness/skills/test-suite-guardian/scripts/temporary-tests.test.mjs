// Autotestes permanentes do lifecycle; não entram na suíte do produto.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const Helper = fileURLToPath(new URL("./temporary-tests.mjs", import.meta.url));
const ExecutionId = "payments-39ea8424-dab4-4cd8-8f90-5c446d6db470";
const Registry = `.harness/workspace/test-lifecycle/${ExecutionId}/temporary-tests.json`;
const OwnedPath = `validation-only/${ExecutionId}/validation-only.parity.spec.mjs`;
const Archive = `.harness/audits/test-strategy/payments/${ExecutionId}`;
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

/** Linked worktree fora da raiz, como as frentes paralelas reais. Uso: linkedWorktree(t, root). */
function linkedWorktree(context, root) {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "guardian-linked-")));
  context.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const work = path.join(parent, "tree");
  execFileSync("git", ["worktree", "add", "-qb", "linked", work], { cwd: root });
  return work;
}

/** `root` é a raiz comum (registro e arquivo); `work` é onde o helper roda. Sem `linked` coincidem. */
function createSandbox(context, { linked = false } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "guardian-test-")));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "baseline"], {
    cwd: root,
  });
  const work = linked ? linkedWorktree(context, root) : root;
  const write = (name, bytes) => {
    fs.mkdirSync(path.dirname(path.join(work, name)), { recursive: true });
    fs.writeFileSync(path.join(work, name), bytes);
  };
  const json = (name, value) => write(name, JSON.stringify(value));
  const callAt = (cwd) => (...args) => {
    const result = spawnSync(process.execPath, [Helper, ...args], { cwd, encoding: "utf8" });
    assert.equal(result.signal, null, result.stderr);
    return { code: result.status, ...JSON.parse(result.stdout) };
  };
  const call = callAt(work);
  write("source.mjs", "export const amount = 1;\n");
  write("permanent.spec.mjs", "permanent");
  write("candidate.mjs", "temporary");
  write("passed.json", '{"result":"passed"}');
  const entry = {
    id: "payment-parity",
    path: OwnedPath,
    kind: "test",
    lifetime: "validation-only",
    owner: "payments-refactor",
    reason: "Comparar transição",
    oracle: "Saídas iguais",
    expiration: "Novo algoritmo entregue e regressão passando",
    replacement: "permanent.spec.mjs",
    required_inputs: ["source.mjs", "permanent.spec.mjs"],
    selection: "node arquivo",
    default_exclusion: "Diretório fora da discovery padrão",
  };
  const plan = { authorized_scope: [OwnedPath], entries: [entry] };
  json("plan.json", plan);
  const begin = () => call("begin", "--execution", ExecutionId, "--feature", "payments", "--plan", "plan.json");
  const create = (owned = OwnedPath) =>
    call("create", "--registry", Registry, "--path", owned, "--from", "candidate.mjs", "--kind", "test");
  const state = () => JSON.parse(fs.readFileSync(path.join(root, Registry), "utf8"));
  const artifact = { path: "passed.json", sha256: hash(fs.readFileSync(path.join(work, "passed.json"))), sanitized: true };
  const group = { result: "passed", artifacts: [artifact] };
  const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: work, encoding: "utf8" }).trim();
  const evidence = {
    source_revision: revision,
    temporary: group,
    permanent: group,
    expiration_satisfied: true,
    future_risk_resolved: true,
    final_behavior_implemented: true,
    decisions: [{ id: entry.id, result: "passed", oracle: entry.oracle, expiration: entry.expiration, replacement: entry.replacement }],
    inputs: ["source.mjs", "permanent.spec.mjs"].map((name) => ({ path: name, sha256: hash(fs.readFileSync(path.join(work, name))) })),
  };
  const validate = () => {
    json("validation.json", evidence);
    return call("record-validation", "--registry", Registry, "--evidence", "validation.json");
  };
  const cleanup = () => call("cleanup", "--registry", Registry);
  const closure = {
    source_revision: revision,
    default_discovery_excludes_temporaries: true,
    references_clear: true,
    discovery: group,
    references: group,
    affected: group,
  };
  const close = () => {
    json("closure.json", closure);
    return call("record-closure", "--registry", Registry, "--evidence", "closure.json");
  };
  return { root, work, write, json, call, callRoot: callAt(root), plan, begin, create, state, evidence, validate, cleanup, closure, close };
}

function prepare(context) {
  const sandbox = createSandbox(context);
  assert.equal(sandbox.begin().code, 0);
  assert.equal(sandbox.create().code, 0);
  return sandbox;
}

test("create exige baseline ausente e preserva arquivo preexistente", (context) => {
  const sandbox = createSandbox(context);
  sandbox.write(OwnedPath, "usuário");
  assert.equal(sandbox.begin().code, 0);
  assert.equal(sandbox.create().code, 1);
  assert.equal(fs.readFileSync(path.join(sandbox.root, OwnedPath), "utf8"), "usuário");
  assert.equal(sandbox.state().entries.length, 0);
});

test("begin idempotente e status em processo novo recuperam ownership e pendências", (context) => {
  const sandbox = prepare(context);
  assert.equal(sandbox.begin().code, 0);
  const resumed = sandbox.call("status", "--all");
  assert.equal(resumed.result[0].entries[0].path, OwnedPath);
  assert.equal(resumed.result[0].entries[0].created_hash, hash("temporary"));
  assert.equal(resumed.result[0].status, "active");
});

test("update invalida prova e preserva alteração externa", (context) => {
  const sandbox = prepare(context);
  assert.equal(sandbox.validate().code, 0);
  sandbox.write("new.mjs", "novo");
  assert.equal(sandbox.call("update", "--registry", Registry, "--path", OwnedPath, "--from", "new.mjs").code, 0);
  assert.equal(sandbox.state().status, "active");
  assert.equal(sandbox.state().validation, undefined);
  assert.equal(fs.readFileSync(path.join(sandbox.root, OwnedPath), "utf8"), "novo");
  sandbox.write(OwnedPath, "usuário");
  assert.equal(sandbox.call("update", "--registry", Registry, "--path", OwnedPath, "--from", "candidate.mjs").code, 1);
  assert.equal(fs.readFileSync(path.join(sandbox.root, OwnedPath), "utf8"), "usuário");
});

test("path traversal e symlink de arquivo, ancestral ou registro bloqueiam escrita", (context) => {
  const sandbox = prepare(context);
  for (const relative of ["../outside.mjs", "/tmp/outside.mjs", "validation-only/../outside.mjs"]) {
    assert.equal(sandbox.create(relative).code, 1);
  }
  fs.symlinkSync("candidate.mjs", path.join(sandbox.root, "link.mjs"));
  assert.equal(sandbox.call("update", "--registry", Registry, "--path", OwnedPath, "--from", "link.mjs").code, 1);
  fs.symlinkSync("validation-only", path.join(sandbox.root, "alias"));
  assert.equal(sandbox.call("status", "--registry", `alias/${ExecutionId}/temporary-tests.json`).code, 1);
  fs.symlinkSync(path.join(sandbox.root, Registry), path.join(sandbox.root, "registry.json"));
  assert.equal(sandbox.call("status", "--registry", "registry.json").code, 1);
});

test("cleanup sem prova ou com teste falho conserva temporário", (context) => {
  const sandbox = prepare(context);
  assert.equal(sandbox.cleanup().code, 1);
  sandbox.evidence.temporary = { ...sandbox.evidence.temporary, result: "failed" };
  assert.equal(sandbox.validate().code, 1);
  assert.equal(sandbox.cleanup().code, 1);
  assert.equal(fs.readFileSync(path.join(sandbox.root, OwnedPath), "utf8"), "temporary");
});

for (const changedPath of [OwnedPath, "source.mjs", "passed.json", "validation.json"]) {
  test(`cleanup bloqueia conteúdo alterado: ${changedPath}`, (context) => {
    const sandbox = prepare(context);
    assert.equal(sandbox.validate().code, 0);
    sandbox.write(changedPath, "alterado");
    assert.equal(sandbox.cleanup().code, 1);
    assert.equal(fs.existsSync(path.join(sandbox.root, OwnedPath)), true);
    assert.equal(sandbox.state().status, "blocked");
  });
}

test("remoção exata preserva permanente e arquivo não registrado com mesmo prefixo", (context) => {
  const sandbox = prepare(context);
  sandbox.write("validation-only.unowned.spec.mjs", "outro");
  assert.equal(sandbox.validate().code, 0);
  assert.equal(sandbox.cleanup().code, 0);
  assert.equal(fs.existsSync(path.join(sandbox.root, OwnedPath)), false);
  assert.equal(fs.readFileSync(path.join(sandbox.root, "permanent.spec.mjs"), "utf8"), "permanent");
  assert.equal(fs.readFileSync(path.join(sandbox.root, "validation-only.unowned.spec.mjs"), "utf8"), "outro");
  assert.equal(sandbox.state().status, "cleanup-pending");
  assert.equal(sandbox.cleanup().code, 0);
});

test("arquivo ausente externamente não equivale a remoção própria", (context) => {
  const sandbox = prepare(context);
  assert.equal(sandbox.validate().code, 0);
  fs.unlinkSync(path.join(sandbox.root, OwnedPath));
  assert.equal(sandbox.cleanup().code, 1);
  assert.equal(sandbox.state().entries[0].status, "validated");
  assert.equal(sandbox.state().status, "blocked");
});

test("interrupção após intenção de remoção permite retomada sem testes novos", (context) => {
  const sandbox = prepare(context);
  assert.equal(sandbox.validate().code, 0);
  const registry = sandbox.state();
  registry.entries[0].status = "removing";
  registry.status = "cleanup-pending";
  sandbox.json(Registry, registry);
  fs.unlinkSync(path.join(sandbox.root, OwnedPath));
  assert.equal(sandbox.cleanup().code, 0);
  assert.equal(sandbox.state().entries[0].removal.result, "resumed-after-intent");
  assert.equal(sandbox.cleanup().code, 0);
});

test("closure exige conferência, arquiva provas e preserva destino diferente", (context) => {
  const sandbox = prepare(context);
  assert.equal(sandbox.validate().code, 0);
  assert.equal(sandbox.close().code, 1);
  assert.equal(sandbox.cleanup().code, 0);
  sandbox.closure.references_clear = false;
  assert.equal(sandbox.close().code, 1);
  sandbox.closure.references_clear = true;
  sandbox.write(`${Archive}/validation.json`, "arquivo anterior");
  assert.equal(sandbox.close().code, 1);
  assert.equal(fs.readFileSync(path.join(sandbox.root, Archive, "validation.json"), "utf8"), "arquivo anterior");
  assert.notEqual(sandbox.state().status, "closed");
});

test("closure durável não depende do pacote e repetição verifica arquivo preservado", (context) => {
  const sandbox = prepare(context);
  assert.equal(sandbox.validate().code, 0);
  assert.equal(sandbox.cleanup().code, 0);
  assert.equal(sandbox.close().code, 0);
  assert.equal(sandbox.state().status, "closed");
  for (const name of ["registry.json", "validation.json", "closure.json"])
    assert.equal(fs.existsSync(path.join(sandbox.root, Archive, name)), true);
  fs.unlinkSync(path.join(sandbox.root, "passed.json"));
  fs.unlinkSync(path.join(sandbox.root, "validation.json"));
  assert.equal(sandbox.close().code, 0);
  const archived = JSON.parse(fs.readFileSync(path.join(sandbox.root, Archive, "validation.json"), "utf8"));
  assert.equal(archived.temporary.artifacts[0].path.startsWith("artifacts/"), true);
  sandbox.write(`${Archive}/registry.json`, "modificado");
  assert.equal(sandbox.close().code, 1);
});

test("retoma criação interrompida antes ou depois da escrita exclusiva", (context) => {
  const sandbox = prepare(context);
  const registry = sandbox.state();
  registry.entries[0].status = "creating";
  sandbox.json(Registry, registry);
  assert.equal(sandbox.create().code, 0);
  registry.entries[0].status = "creating";
  sandbox.json(Registry, registry);
  fs.unlinkSync(path.join(sandbox.root, OwnedPath));
  assert.equal(sandbox.create().code, 0);
  assert.equal(fs.readFileSync(path.join(sandbox.root, OwnedPath), "utf8"), "temporary");
});

test("retoma update interrompido e rejeita credenciais como fonte", (context) => {
  const sandbox = prepare(context);
  sandbox.write("new.mjs", "novo");
  const registry = sandbox.state();
  registry.entries[0].status = "updating";
  registry.entries[0].next_hash = hash("novo");
  registry.entries[0].write_path = `${OwnedPath}.interrupted.updating`;
  sandbox.json(Registry, registry);
  assert.equal(sandbox.call("update", "--registry", Registry, "--path", OwnedPath, "--from", "new.mjs").code, 0);
  assert.equal(fs.readFileSync(path.join(sandbox.root, OwnedPath), "utf8"), "novo");
  sandbox.write(".env", "secret");
  assert.equal(sandbox.call("update", "--registry", Registry, "--path", OwnedPath, "--from", ".env").code, 1);
  assert.equal(fs.readFileSync(path.join(sandbox.root, OwnedPath), "utf8"), "novo");
});

test("lock abandonado tem retomada; lock de processo ativo preserva estado", (context) => {
  const sandbox = prepare(context);
  sandbox.json(`${Registry}.lock`, { pid: process.pid, root: sandbox.root });
  assert.equal(sandbox.validate().code, 1);
  assert.equal(sandbox.state().status, "active");
  sandbox.json(`${Registry}.lock`, { pid: 2147483647, root: sandbox.root });
  assert.equal(sandbox.validate().code, 0);
  assert.equal(fs.existsSync(path.join(sandbox.root, `${Registry}.lock`)), false);
});

test("closure verifica hashes de artefatos copiados e cleanup preserva recriação", (context) => {
  const sandbox = prepare(context);
  assert.equal(sandbox.validate().code, 0);
  assert.equal(sandbox.cleanup().code, 0);
  assert.equal(sandbox.close().code, 0);
  sandbox.write(`${Archive}/artifacts/validation-temporary-0.json`, "alterado");
  assert.equal(sandbox.close().code, 1);
  sandbox.write(OwnedPath, "arquivo novo do usuário");
  assert.equal(sandbox.cleanup().code, 1);
  assert.equal(fs.readFileSync(path.join(sandbox.root, OwnedPath), "utf8"), "arquivo novo do usuário");
});

test("validação mais recente falha invalida prova anterior em arquivo diferente", (context) => {
  const sandbox = prepare(context);
  assert.equal(sandbox.validate().code, 0);
  sandbox.json("failed.json", { ...sandbox.evidence, temporary: { result: "failed", artifacts: sandbox.evidence.temporary.artifacts } });
  assert.equal(sandbox.call("record-validation", "--registry", Registry, "--evidence", "failed.json").code, 1);
  assert.equal(sandbox.state().validation, undefined);
  assert.equal(sandbox.cleanup().code, 1);
  assert.equal(fs.readFileSync(path.join(sandbox.root, OwnedPath), "utf8"), "temporary");
});

test("update rejeita hard link sem modificar permanente", (context) => {
  const sandbox = prepare(context);
  sandbox.write("same.mjs", "temporary");
  fs.unlinkSync(path.join(sandbox.root, OwnedPath));
  fs.linkSync(path.join(sandbox.root, "same.mjs"), path.join(sandbox.root, OwnedPath));
  sandbox.write("new.mjs", "novo");
  assert.equal(sandbox.call("update", "--registry", Registry, "--path", OwnedPath, "--from", "new.mjs").code, 1);
  assert.equal(fs.readFileSync(path.join(sandbox.root, "same.mjs"), "utf8"), "temporary");
});

test("update parcial preserva original e exige reconciliação do staging", (context) => {
  const sandbox = prepare(context);
  sandbox.write("new.mjs", "novo");
  const registry = sandbox.state();
  const entry = registry.entries[0];
  entry.status = "updating";
  entry.next_hash = hash("novo");
  entry.write_path = `${OwnedPath}.partial.updating`;
  sandbox.json(Registry, registry);
  sandbox.write(entry.write_path, "nov");
  assert.equal(sandbox.call("update", "--registry", Registry, "--path", OwnedPath, "--from", "new.mjs").code, 1);
  assert.equal(fs.readFileSync(path.join(sandbox.root, OwnedPath), "utf8"), "temporary");
  assert.equal(fs.readFileSync(path.join(sandbox.root, entry.write_path), "utf8"), "nov");
});

test("arquivo preexistente não ganha ownership após remoção externa", (context) => {
  const sandbox = createSandbox(context);
  sandbox.write(OwnedPath, "usuário");
  assert.equal(sandbox.begin().code, 0);
  fs.unlinkSync(path.join(sandbox.root, OwnedPath));
  assert.equal(sandbox.create().code, 1);
  assert.equal(sandbox.state().entries.length, 0);
});


test("summary preserva IDs, pendências e mutações sem copiar provas grandes", (context) => {
  const sandbox = createSandbox(context);
  const begun = sandbox.call("begin", "--execution", ExecutionId, "--feature", "payments", "--plan", "plan.json", "--summary");
  assert.equal(begun.code, 0);
  assert.equal(begun.result.execution_id, ExecutionId);
  assert.equal(begun.result.contract, undefined);
  assert.equal(sandbox.create().code, 0);
  assert.equal(sandbox.validate().code, 0);
  const registry = sandbox.state();
  registry.validation.evidence.large = "x".repeat(200000);
  sandbox.json(Registry, registry);
  const summary = sandbox.call("status", "--registry", Registry, "--summary");
  assert.equal(summary.result.status, "validated");
  assert.equal(summary.result.pending[0].owner, "payments-refactor");
  assert.deepEqual(summary.result.paths, [OwnedPath]);
  assert.equal(summary.result.validation, undefined);
  assert.ok(JSON.stringify(summary).length < 2000);
  assert.ok(JSON.stringify(sandbox.call("status", "--registry", Registry)).length > 200000);
  sandbox.json("failed.json", { ...sandbox.evidence, temporary: { result: "failed" } });
  const failure = sandbox.call("record-validation", "--registry", Registry, "--evidence", "failed.json", "--summary");
  assert.equal(failure.code, 1);
  const blocked = sandbox.call("status", "--all", "--summary");
  assert.equal(blocked.result.pending[0].status, "blocked");
  assert.ok(blocked.result.pending[0].blocked_reason);
  assert.equal(sandbox.state().validation, undefined);
});

test("summary não oculta owner alheio ou corrupção; closed pode agregar", (context) => {
  const sandbox = prepare(context);
  const otherId = "other-owner";
  const otherPath = `.harness/workspace/test-lifecycle/${otherId}/temporary-tests.json`;
  const other = { ...sandbox.state(), execution_id: otherId, feature: "other", status: "blocked", blocked_reason: "owner alheio pendente" };
  sandbox.json(otherPath, other);
  const all = sandbox.call("status", "--all", "--summary");
  assert.equal(all.code, 0);
  assert.deepEqual(all.result.pending.map((item) => item.execution_id).sort(), [otherId, ExecutionId].sort());
  assert.equal(all.result.pending.find((item) => item.execution_id === otherId).blocked_reason, "owner alheio pendente");
  other.status = "closed";
  sandbox.json(otherPath, other);
  assert.equal(sandbox.call("status", "--all", "--summary").result.closed, 1);
  sandbox.write(otherPath, "{invalid");
  assert.equal(sandbox.call("status", "--all", "--summary").code, 1);
});

test("linked worktree mantém registro e arquivo na raiz comum e fontes no worktree", (context) => {
  const sandbox = createSandbox(context, { linked: true });
  assert.equal(sandbox.begin().code, 0);
  assert.equal(sandbox.create().code, 0);
  assert.equal(sandbox.state().root, sandbox.work);
  assert.equal(fs.existsSync(path.join(sandbox.work, OwnedPath)), true);
  assert.equal(fs.existsSync(path.join(sandbox.root, OwnedPath)), false);
  assert.equal(sandbox.validate().code, 0);
  assert.equal(sandbox.cleanup().code, 0);
  assert.equal(sandbox.close().code, 0);
  assert.equal(sandbox.state().status, "closed");
  assert.equal(fs.existsSync(path.join(sandbox.root, Archive, "registry.json")), true);
  // Nada durável no worktree: removê-lo não leva registro nem prova.
  assert.equal(fs.existsSync(path.join(sandbox.work, ".harness")), false);
  execFileSync("git", ["worktree", "remove", "--force", sandbox.work], { cwd: sandbox.root });
  assert.equal(fs.existsSync(path.join(sandbox.root, Archive, "registry.json")), true);
});

test("diretório compartilhado: status --all responde só pelo worktree atual e recusa registro alheio", (context) => {
  const sandbox = createSandbox(context, { linked: true });
  assert.equal(sandbox.begin().code, 0);
  const otherId = "main-owner";
  const otherPath = `.harness/workspace/test-lifecycle/${otherId}/temporary-tests.json`;
  const other = { ...sandbox.state(), execution_id: otherId, feature: "other", root: sandbox.root };
  fs.mkdirSync(path.dirname(path.join(sandbox.root, otherPath)), { recursive: true });
  fs.writeFileSync(path.join(sandbox.root, otherPath), JSON.stringify(other));
  assert.deepEqual(sandbox.call("status", "--all").result.map((registry) => registry.execution_id), [ExecutionId]);
  assert.deepEqual(sandbox.callRoot("status", "--all").result.map((registry) => registry.execution_id), [otherId]);
  assert.equal(sandbox.call("status", "--registry", otherPath).code, 1);
  assert.equal(sandbox.callRoot("status", "--registry", Registry).code, 1);
});
