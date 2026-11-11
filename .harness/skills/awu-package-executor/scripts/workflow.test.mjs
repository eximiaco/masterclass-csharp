// Integração real de helpers em Git local; sem rede, produto ou sessões simuladas de LLM.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { sandbox, Manifest, PackageDir, CheckpointState, finishUnits, obligations, commitCheckpoint } from "./test-fixture.mjs";
import { parseSimpleYaml } from "../../awu-workspace/scripts/lib/profile.mjs";
import { summarizeResult } from "../../test-suite-guardian/scripts/summary.mjs";

const Guardian = fileURLToPath(new URL("../../test-suite-guardian/scripts/temporary-tests.mjs", import.meta.url));
const ProjectRoot = fileURLToPath(new URL("../../../../", import.meta.url));
function ok(result) {
  assert.equal(result.code, 0, JSON.stringify(result));
  return result;
}

function guardian(fixture, ...args) {
  const outcome = spawnSync(process.execPath, [Guardian, ...args], { cwd: fixture.work, encoding: "utf8" });
  return { code: outcome.status, ...JSON.parse(outcome.stdout) };
}

function temporary(fixture, id = "sample-proof", feature = "sample") {
  const ownedPath = `.harness/workspace/temporary/${id}.test.mjs`;
  const registry = `.harness/workspace/test-lifecycle/${id}/temporary-tests.json`;
  const entry = {
    id,
    path: ownedPath,
    kind: "test",
    lifetime: "validation-only",
    owner: "i",
    reason: "Provar transição A→I",
    oracle: "Resultado integrado mantém contrato",
    expiration: "I integra e valida substituto permanente",
    replacement: "source.mjs",
    required_inputs: ["source.mjs"],
    selection: "node source.mjs",
    default_exclusion: "Workspace fora da discovery permanente",
  };
  fixture.jsonWork(".harness/workspace/plan.json", { authorized_scope: [ownedPath], entries: [entry] });
  fixture.writeWork(".harness/workspace/candidate.mjs", "export const proof = true;\n");
  ok(guardian(fixture, "begin", "--execution", id, "--feature", feature, "--plan", ".harness/workspace/plan.json", "--summary"));
  ok(
    guardian(
      fixture,
      "create",
      "--registry",
      registry,
      "--path",
      ownedPath,
      "--kind",
      "test",
      "--from",
      ".harness/workspace/candidate.mjs",
      "--summary",
    ),
  );
  return { id, ownedPath, registry, entry };
}

function closeTemporary(fixture, proof) {
  const artifact = { ...fixture.ref(".harness/audits/proof.txt"), sanitized: true };
  const group = { result: "passed", artifacts: [artifact] };
  fixture.jsonWork(".harness/workspace/validation.json", {
    source_revision: fixture.gitWork("rev-parse", "HEAD"),
    temporary: group,
    permanent: group,
    expiration_satisfied: true,
    future_risk_resolved: true,
    final_behavior_implemented: true,
    decisions: [
      {
        id: proof.id,
        result: "passed",
        oracle: proof.entry.oracle,
        expiration: proof.entry.expiration,
        replacement: proof.entry.replacement,
      },
    ],
    inputs: [fixture.ref("source.mjs", fixture.work)],
  });
  ok(guardian(fixture, "record-validation", "--registry", proof.registry, "--evidence", ".harness/workspace/validation.json", "--summary"));
  ok(guardian(fixture, "cleanup", "--registry", proof.registry, "--summary"));
  fixture.jsonWork(".harness/workspace/guardian-closure.json", {
    source_revision: fixture.gitWork("rev-parse", "HEAD"),
    default_discovery_excludes_temporaries: true,
    references_clear: true,
    discovery: group,
    references: group,
    affected: group,
  });
  ok(
    guardian(
      fixture,
      "record-closure",
      "--registry",
      proof.registry,
      "--evidence",
      ".harness/workspace/guardian-closure.json",
      "--summary",
    ),
  );
}

test("WV1: pacote documental justifica not-applicable sem exigir fontes de dados ou temporários", (context) => {
  const fixture = sandbox(context);
  const manifest = fs.readFileSync(path.join(fixture.root, Manifest), "utf8").replace("work_type: development", "work_type: documentation");
  fixture.write(Manifest, manifest);
  fixture.write(
    `${PackageDir}/test-strategy.yaml`,
    "schema_version: 1\nstatus: not-applicable\nreason: Somente correção de prosa; contratos intactos\ndecisions: []\n",
  );
  // Nova identidade isolada, pois o pacote anterior já foi capturado: begin deve bloquear alteração.
  assert.equal(fixture.call("begin", "--manifest", Manifest).code, 1);
  fixture.git("checkout", "-qb", "docs-only");
  const begun = ok(fixture.call("begin", "--manifest", Manifest));
  assert.equal(begun.result.status, "planned");
  assert.deepEqual(begun.result.eligible, ["a"]);
  assert.equal(fs.existsSync(path.join(fixture.root, ".harness/data-sources.yaml")), false);
  assert.equal(fs.existsSync(path.join(fixture.root, ".harness/workspace/test-lifecycle")), false);
});

test("WV2: contrato permanente reutilizado produz prova de processo e inputs estáveis", (context) => {
  const fixture = sandbox(context);
  const outcome = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "import assert from 'node:assert/strict'; import { result } from './source.mjs'; assert.equal(result, 1);",
    ],
    { cwd: fixture.root, encoding: "utf8" },
  );
  assert.equal(outcome.status, 0, outcome.stderr);
  fixture.write(
    ".harness/audits/proof.txt",
    JSON.stringify({ command: "node assert sobre source.mjs", exit_code: outcome.status, stdout: outcome.stdout }),
  );
  ok(fixture.start("a"));
  ok(fixture.validate("a"));
  ok(fixture.complete("a"));
  assert.deepEqual(fixture.state().units.a.validation.inputs, [fixture.ref("source.mjs")]);
  assert.equal(fixture.git("diff", "--name-only", "HEAD", "--", "source.mjs"), "");
});

test("WV3: parser real preserva fatos code-derived/verified e recusa recurso YAML não suportado", () => {
  const facts = parseSimpleYaml(
    "sources:\n  - id: tenant\n    status: code-derived\n    schema_authority: migrations/Example.cs\n    fact: 'Column Revision: integer, not null'\n  - id: verified\n    status: verified\n    expected_database: fixture\n",
  );
  assert.equal(facts.sources[0].status, "code-derived");
  assert.equal(facts.sources[0].fact, "Column Revision: integer, not null");
  assert.equal(facts.sources[1].status, "verified");
  assert.throws(() => parseSimpleYaml("fact: |\n  texto\n"));
  const template = fs.readFileSync(path.join(ProjectRoot, ".harness/skills/awu-compiler/templates/execution-manifest.yaml"), "utf8");
  assert.equal(parseSimpleYaml(template).units.length, 1);
});

test("WV4: A→I mantém checkpoint local; lifecycle posterior bloqueia entrega final até closure real", (context) => {
  const fixture = sandbox(context, true);
  const proof = temporary(fixture);
  ok(fixture.start("a"));
  const sha = commitCheckpoint(fixture);
  ok(fixture.event({ type: "unit-validated", unit_id: "a", ...fixture.proof(), lifecycles: [proof.id] }));
  ok(fixture.event({ type: "checkpoint-verified", checkpoint_id: "a-ready", checkpoint_state: CheckpointState }));
  ok(fixture.complete("a"));
  ok(fixture.start("i"));
  ok(fixture.validate("i"));
  ok(fixture.complete("i"));
  obligations(fixture);
  assert.equal(fixture.close().code, 1);
  assert.equal(fs.existsSync(path.join(fixture.root, proof.ownedPath)), true);
  closeTemporary(fixture, proof);
  ok(fixture.operation("resume", "--reason", "I encerrou lifecycle e arquivo durável foi conferido"));
  ok(fixture.close());
  assert.equal(fixture.state().status, "completed");
  assert.equal(fixture.git("rev-parse", "HEAD"), sha);
  assert.equal(fixture.git("remote"), "");
  assert.equal(fs.existsSync(path.join(fixture.root, ".harness/audits/test-strategy/sample/sample-proof/registry.json")), true);
  assert.equal(fs.existsSync(path.join(fixture.root, proof.registry)), false);
  assert.equal(fs.existsSync(path.join(fixture.root, CheckpointState)), false);
});

test("WV5: terceiro ativo é reportado/preservado; sobreposição bloqueia", (context) => {
  const fixture = sandbox(context);
  const proof = temporary(fixture, "third-party", "other-feature");
  finishUnits(fixture);
  obligations(fixture);
  ok(fixture.close());
  assert.deepEqual(fixture.state().cleanup_intent.lifecycle.other_pending, [proof.id]);
  assert.equal(fs.existsSync(path.join(fixture.root, proof.ownedPath)), true);
  const overlap = sandbox(context);
  const other = temporary(overlap, "overlap", "other-feature");
  const registry = JSON.parse(fs.readFileSync(path.join(overlap.root, other.registry), "utf8"));
  registry.entries[0].path = "source.mjs";
  registry.authorized_scope.push("source.mjs");
  overlap.json(other.registry, registry);
  finishUnits(overlap);
  obligations(overlap);
  assert.equal(overlap.close().code, 1);
  assert.equal(fs.existsSync(path.join(overlap.root, Manifest)), true);
});

test("lifecycle closed consumido por execução ativa permanece operacional", (context) => {
  const fixture = sandbox(context);
  const proof = temporary(fixture);
  finishUnits(fixture);
  closeTemporary(fixture, proof);
  obligations(fixture);
  const directory = ".harness/workspace/awu-packages/consumer";
  for (const name of ["execution-manifest.yaml", "a.md", "i.md", "test-strategy.yaml", "review-manifest.md"]) {
    const content = fs.readFileSync(path.join(fixture.root, PackageDir, name), "utf8");
    fixture.write(`${directory}/${name}`, name === "execution-manifest.yaml" ? content.replace("id: sample", "id: consumer") : content);
  }
  const consumer = fixture.call("begin", "--manifest", `${directory}/execution-manifest.yaml`);
  ok(consumer);
  const event = (value) => {
    fixture.json(".harness/workspace/consumer-event.json", { schema_version: 1, ...value });
    ok(fixture.call("record", "--state", consumer.result.state, "--event", ".harness/workspace/consumer-event.json"));
  };
  event({ type: "unit-started", unit_id: "a" });
  event({ type: "unit-validated", unit_id: "a", ...fixture.proof(), lifecycles: [proof.id] });
  ok(fixture.close());
  assert.equal(fs.existsSync(path.join(fixture.root, proof.registry)), true);
  assert.equal(fs.existsSync(path.join(fixture.root, consumer.result.state)), true);
});

test("WV7: linked worktree fecha lifecycle com registro e arquivo duráveis na raiz comum", (context) => {
  const fixture = sandbox(context, true, true);
  const proof = temporary(fixture);
  ok(fixture.start("a"));
  commitCheckpoint(fixture);
  ok(fixture.event({ type: "unit-validated", unit_id: "a", ...fixture.proof(), lifecycles: [proof.id] }));
  ok(fixture.event({ type: "checkpoint-verified", checkpoint_id: "a-ready", checkpoint_state: CheckpointState }));
  ok(fixture.complete("a"));
  ok(fixture.start("i"));
  ok(fixture.validate("i"));
  ok(fixture.complete("i"));
  obligations(fixture);
  closeTemporary(fixture, proof);
  ok(fixture.close());
  assert.equal(fixture.state().status, "completed");
  assert.equal(fs.existsSync(path.join(fixture.root, ".harness/audits/test-strategy/sample/sample-proof/registry.json")), true);
  assert.equal(fs.existsSync(path.join(fixture.root, proof.registry)), false);
  // Remover o worktree não pode levar registro nem prova: nada disso vive nele.
  assert.equal(fs.existsSync(path.join(fixture.work, ".harness/audits")), false);
  assert.equal(fs.existsSync(path.join(fixture.work, ".harness/workspace/test-lifecycle")), false);
  fixture.git("worktree", "remove", "--force", fixture.work);
  assert.equal(fixture.git("worktree", "list", "--porcelain").includes(fixture.work), false);
  assert.equal(fs.existsSync(path.join(fixture.root, ".harness/audits/test-strategy/sample/sample-proof/registry.json")), true);
});

test("WV8: consumidor que edita arquivo do checkpoint anterior não invalida o provedor e o pacote fecha", (context) => {
  const fixture = sandbox(context, true);
  ok(fixture.start("a"));
  commitCheckpoint(fixture);
  ok(fixture.validate("a"));
  ok(fixture.event({ type: "checkpoint-verified", checkpoint_id: "a-ready", checkpoint_state: CheckpointState }));
  ok(fixture.complete("a"));
  ok(fixture.start("i"));
  // I altera o mesmo arquivo commitado por A (ex.: testes migrados depois de corrigidos).
  fixture.writeWork("source.mjs", "export const result = 3;\n");
  ok(fixture.validate("i"));
  ok(fixture.complete("i"));
  ok(fixture.operation("status"));
  assert.equal(fixture.state().units.a.status, "completed");
  assert.notEqual(fixture.state().units.a.validation.inputs[0].sha256, fixture.ref("source.mjs", fixture.work).sha256);
  obligations(fixture);
  ok(fixture.close());
  assert.equal(fixture.state().status, "completed");
});

test("WV8: input commitado adulterado no histórico ainda invalida o provedor", (context) => {
  const fixture = sandbox(context, true);
  ok(fixture.start("a"));
  commitCheckpoint(fixture);
  ok(fixture.validate("a"));
  ok(fixture.event({ type: "checkpoint-verified", checkpoint_id: "a-ready", checkpoint_state: CheckpointState }));
  ok(fixture.complete("a"));
  const state = fixture.state();
  state.units.a.validation.inputs[0].sha256 = "0".repeat(64);
  fixture.json(fixture.statePath, state);
  const resumed = fixture.operation("resume", "--reason", "teste");
  assert.equal(resumed.code, 1);
  assert.match(resumed.message, /input validado/i);
  assert.equal(fixture.state().status, "blocked");
});

test("WV9: refine aceita mudança autorizada do pacote e invalida só a unidade cuja spec mudou", (context) => {
  const fixture = sandbox(context);
  finishUnits(fixture);
  fixture.writeWork(`${PackageDir}/i.md`, "# I\nValidar integração A; decisão nova do usuário.");
  assert.equal(fixture.operation("status").code, 1);
  assert.equal(fixture.operation("refine", "--reason", "sem autorização").code, 1);
  fixture.write(".harness/audits/decision.md", "Usuário autorizou refinar a spec de I.");
  const refined = ok(fixture.operation("refine", "--reason", "Decisão do usuário", "--authorization", ".harness/audits/decision.md"));
  assert.equal(refined.result.units.a, "completed");
  assert.equal(refined.result.units.i, "blocked");
  const state = fixture.state();
  assert.equal(state.refinements.length, 1);
  assert.deepEqual(state.refinements[0].invalidated, ["i"]);
  assert.equal(state.refinements[0].changes[0].path, `${PackageDir}/i.md`);
  assert.equal(fixture.operation("refine", "--reason", "nada mudou", "--authorization", ".harness/audits/decision.md").code, 1);
  ok(fixture.operation("resume", "--reason", "Refinamento aplicado"));
  ok(fixture.start("i"));
  ok(fixture.validate("i"));
  ok(fixture.complete("i"));
  obligations(fixture);
  ok(fixture.close());
});

test("WV9: refine recusa mudança de topologia e aceita --invalidate explícito", (context) => {
  const fixture = sandbox(context);
  finishUnits(fixture);
  fixture.write(".harness/audits/decision.md", "Usuário autorizou.");
  fixture.writeWork(`${PackageDir}/review-manifest.md`, "# Review\nAtualizado.");
  const refined = ok(
    fixture.operation("refine", "--reason", "Review regerado", "--authorization", ".harness/audits/decision.md", "--invalidate", "a"),
  );
  assert.equal(refined.result.units.a, "blocked");
  assert.equal(refined.result.units.i, "blocked");
  const manifest = fs.readFileSync(path.join(fixture.work, Manifest), "utf8").replace("id: i\n", "id: j\n").replace("[a]", "[a]");
  fixture.writeWork(Manifest, manifest);
  assert.equal(fixture.operation("refine", "--reason", "topologia", "--authorization", ".harness/audits/decision.md").code, 1);
});

test("WV6: resumo cresce com bloqueios e não com evidência aninhada", () => {
  const registry = {
    execution_id: "one",
    feature: "sample",
    status: "blocked",
    blocked_reason: "Falha recente",
    entries: [],
    contract: { bytes: "x" },
  };
  const small = JSON.stringify(summarizeResult([registry]));
  registry.contract.bytes = "x".repeat(1000000);
  assert.equal(JSON.stringify(summarizeResult([registry])), small);
  const more = summarizeResult([registry, { ...registry, execution_id: "two", blocked_reason: "Outro owner" }]);
  assert.equal(more.pending.length, 2);
  assert.equal(more.pending[1].blocked_reason, "Outro owner");
});

test("WV6: retenção distingue fonte, resumo, placeholder, prova e pacote ativo em índice isolado", (context) => {
  const fixture = sandbox(context);
  fixture.write(".gitignore", fs.readFileSync(path.join(ProjectRoot, ".gitignore")));
  const cases = {
    ".harness/skills/example/SKILL.md": false,
    ".harness/memory/MEMORY.md": false,
    ".harness/workspace/awu-packages/.gitkeep": false,
    [Manifest]: true,
    ".harness/audits/raw/proof.json": true,
    ".harness/audits/README.md": false,
    ".harness/audits/summaries/result.md": false,
    ".harness/plans/cleanup-fixture/review.md": true,
    ".harness/reports/result.md": true,
  };
  for (const [filename, ignored] of Object.entries(cases)) {
    if (filename !== Manifest) fixture.write(filename, "fixture");
    const outcome = spawnSync("git", ["check-ignore", "-q", "--", filename], { cwd: fixture.root });
    assert.equal(outcome.status === 0, ignored, filename);
  }
  fixture.git("add", "--", ".harness/skills/example/SKILL.md", ".harness/audits/summaries/result.md");
  assert.equal(fixture.git("ls-files", "--", ".harness/audits/raw/proof.json"), "");
  assert.equal(fixture.git("ls-files", "--", ".harness/skills/example/SKILL.md"), ".harness/skills/example/SKILL.md");
});
