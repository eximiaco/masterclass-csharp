// Fixtures locais com teardown; nenhum remote/serviço real.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { hash } from "./lib/storage.mjs";

export const Helper = fileURLToPath(new URL("./package-state.mjs", import.meta.url));
export const PackageDir = ".harness/workspace/awu-packages/sample";
export const Manifest = `${PackageDir}/execution-manifest.yaml`;
export const CheckpointState = ".harness/workspace/commit-checkpoints/sample.json";

const gitAt = (cwd) => (...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const writeAt = (base) => (name, bytes) => {
  const filename = path.join(base, name);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, bytes);
};

/** Linked worktree fora da raiz, como as frentes paralelas reais. Uso: linkedWorktree(t, git). */
function linkedWorktree(context, git) {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "awu-executor-linked-")));
  context.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const work = path.join(parent, "tree");
  git("worktree", "add", "-qb", "linked", work);
  return work;
}

/**
 * Repositório isolado para testar fronteiras em processos novos. Uso: sandbox(t).
 * `root` guarda estado e provas (raiz comum); `work` guarda pacote e fontes. Sem
 * `linked` os dois coincidem.
 */
export function sandbox(context, withCheckpoint = false, linked = false) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "awu-executor-")));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = gitAt(root);
  git("init", "-q");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  const write = writeAt(root);
  const json = (name, value) => write(name, JSON.stringify(value));
  write("source.mjs", "export const result = 1;\n");
  git("add", "--", "source.mjs");
  git("commit", "-qm", "baseline");
  const work = linked ? linkedWorktree(context, git) : root;
  const gitWork = gitAt(work);
  const writeWork = writeAt(work);
  const jsonWork = (name, value) => writeWork(name, JSON.stringify(value));
  writeWork(Manifest, manifest(withCheckpoint));
  writeWork(`${PackageDir}/review-manifest.md`, "# Review\nA seguido de I; gates independentes de checkpoint.");
  writeWork(`${PackageDir}/a.md`, "# A\nImplementar fonte; validar e revisar.");
  writeWork(`${PackageDir}/i.md`, "# I\nValidar integração A e fechar lifecycle.");
  writeWork(`${PackageDir}/test-strategy.yaml`, "schema_version: 1\nstatus: ready\nreason: null\n");
  write(".harness/audits/proof.txt", "fixture: command completed, review recorded");
  const ref = (name, base = root) => ({ path: name, sha256: hash(fs.readFileSync(path.join(base, name))) });
  const call = (...args) => {
    const outcome = spawnSync(process.execPath, [Helper, ...args], { cwd: work, encoding: "utf8" });
    if (!outcome.stdout) throw new Error(outcome.stderr);
    return { code: outcome.status, ...JSON.parse(outcome.stdout) };
  };
  const begun = call("begin", "--manifest", Manifest);
  if (begun.code !== 0) throw new Error(JSON.stringify(begun));
  const statePath = begun.result.state;
  const operation = (name, ...args) => call(name, "--state", statePath, ...args);
  const event = (value) => {
    json(".harness/workspace/event.json", { schema_version: 1, ...value });
    return operation("record", "--event", ".harness/workspace/event.json");
  };
  const proof = () => ({
    inputs: [ref("source.mjs", work)],
    evidence: [ref(".harness/audits/proof.txt")],
    review: ref(".harness/audits/proof.txt"),
    source_revision: gitWork("rev-parse", "HEAD"),
    result: "passed",
  });
  const start = (unit_id) => event({ type: "unit-started", unit_id });
  const validate = (unit_id) => event({ type: "unit-validated", unit_id, ...proof() });
  const complete = (unit_id) => event({ type: "unit-completed", unit_id });
  const state = () =>
    fs.existsSync(path.join(root, statePath))
      ? JSON.parse(fs.readFileSync(path.join(root, statePath), "utf8"))
      : operation("status", "--full").result;
  const check = () => ({ result: "passed", exit_code: 0, command: "fixture check", artifacts: [ref(".harness/audits/proof.txt")] });
  const close = () => {
    json(".harness/workspace/closure.json", { schema_version: 1, discovery: check(), references: check(), affected: check() });
    return operation("close", "--event", ".harness/workspace/closure.json");
  };
  return {
    root,
    work,
    git,
    gitWork,
    write,
    writeWork,
    json,
    jsonWork,
    ref,
    call,
    statePath,
    operation,
    event,
    proof,
    start,
    validate,
    complete,
    state,
    close,
    begun,
  };
}

function manifest(checkpoint) {
  return `id: sample
title: Fixture
units:
  - id: a
    spec: ./a.md
    work_type: development
    depends_on: []
  - id: i
    spec: ./i.md
    work_type: integration-testing
    depends_on: [a]
commit_policy:
  execution_state: ${CheckpointState}
  final_gate: all checks
commit_checkpoints: ${
    checkpoint
      ? `
  - id: a-ready
    owner_unit: a
    after_units: [a]
    before_units: [i]
    paths_from_units: [a]
    validation_from_units: [a]
    gate: reviewed and passed
    commit_subject: 'feat: fixture'
`
      : "[]\n"
  }`;
}

/** Fecha gates locais sem checkpoint. Uso: finishUnits(sandbox). */
export function finishUnits(fixture) {
  for (const id of ["a", "i"]) {
    for (const result of [fixture.start(id), fixture.validate(id), fixture.complete(id)]) {
      if (result.code !== 0) throw new Error(JSON.stringify(result));
    }
  }
}

/** Registra obrigações finais observadas. Uso: obligations(fixture). */
export function obligations(fixture) {
  const learning = fixture.event({ type: "learning-evaluated", classification: "none", reason: "Comportamento já documentado na skill" });
  const delivery = fixture.event({ type: "delivery-recorded", mode: "local", evidence: [fixture.ref(".harness/audits/proof.txt")] });
  if (learning.code || delivery.code) throw new Error(JSON.stringify([learning, delivery]));
}

/** Efetua commit antes de registrar fato no executor. Uso: commitCheckpoint(fixture). */
export function commitCheckpoint(fixture) {
  fixture.writeWork("source.mjs", "export const result = 2;\n");
  const parent = fixture.gitWork("rev-parse", "HEAD");
  fixture.gitWork("add", "--", "source.mjs");
  fixture.gitWork("commit", "-qm", "feat: fixture");
  const sha = fixture.gitWork("rev-parse", "HEAD");
  fixture.json(CheckpointState, {
    schema_version: 1,
    package_id: "sample",
    checkpoints: {
      "a-ready": {
        status: "committed",
        commit_sha: sha,
        parent_sha: parent,
        branch: fixture.gitWork("branch", "--show-current"),
        worktree: fixture.work,
        changed_paths: ["source.mjs"],
        validation_refs: [".harness/audits/proof.txt"],
        input_hashes: { "source.mjs": fixture.ref("source.mjs", fixture.work).sha256 },
      },
    },
  });
  return sha;
}
