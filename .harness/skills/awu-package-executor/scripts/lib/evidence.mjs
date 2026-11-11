import { fileURLToPath } from "node:url";
import { mustGit, gitOk, currentBranch, headCommit, runProgram } from "../../../awu-workspace/scripts/lib/git.mjs";
import { fail, hash, readJson, verifyRefs, safe, fileHash } from "./storage.mjs";

/** Confere ancestralidade e conteúdo do checkpoint externo. Uso: checkpoint(state, id). */
export function checkpoint(state, id) {
  const document = readJson(state.root, state.manifest.commit_policy.execution_state);
  if (document.schema_version !== 1 || document.package_id !== state.package_id) fail("Identidade de checkpoints divergente");
  const cp = document.checkpoints?.[id];
  if (cp?.status === "no-change") return noChange(state, id, cp);
  if (!cp || !["committed", "reused"].includes(cp.status) || !cp.changed_paths?.length || !cp.validation_refs?.length)
    fail(`Checkpoint sem evidência: ${id}`);
  if (!/^[a-f0-9]{40,64}$/.test(cp.commit_sha ?? "") || !/^[a-f0-9]{40,64}$/.test(cp.parent_sha ?? "")) fail("SHA de checkpoint inválido");
  const cwd = state.worktree;
  if (cp.branch !== state.branch || cp.worktree !== cwd || !gitOk(["merge-base", "--is-ancestor", cp.commit_sha, "HEAD"], { cwd }))
    fail(`Checkpoint divergente: ${id}`);
  if (mustGit(["rev-parse", `${cp.commit_sha}^`], { cwd }).trim() !== cp.parent_sha) fail(`Parent divergente: ${id}`);
  const paths = mustGit(["diff-tree", "--no-commit-id", "--name-only", "-r", cp.commit_sha], { cwd }).trim().split("\n").sort();
  if (JSON.stringify(paths) !== JSON.stringify([...cp.changed_paths].sort())) fail(`Paths divergentes: ${id}`);
  const validationRefs = checkpointProofs(state, id, cp);
  verifyCommittedHashes(state, cp);
  const definition = state.manifest.commit_checkpoints.find((item) => item.id === id);
  for (const unitId of definition.validation_from_units) {
    for (const input of state.units[unitId].validation?.inputs ?? []) {
      if (cp.changed_paths.includes(input.path) && cp.input_hashes[input.path] !== input.sha256)
        fail(`Checkpoint não contém input validado: ${input.path}`);
    }
  }
  return { commit_sha: cp.commit_sha, parent_sha: cp.parent_sha, changed_paths: cp.changed_paths, validation_refs: validationRefs };
}

function verifyCommittedHashes(state, cp) {
  if (!cp.input_hashes || !Object.keys(cp.input_hashes).length) fail("Checkpoint sem hashes validados");
  for (const [relative, expected] of Object.entries(cp.input_hashes)) {
    safe(state.worktree, relative);
    const content = runProgram("git", ["show", `${cp.commit_sha}:${relative}`], { cwd: state.worktree });
    // Git show textual: input_hashes devem apontar somente fontes de texto UTF-8.
    if (content.code !== 0) fail(`Input não pertence ao commit: ${relative}`);
    if (hash(content.stdout) !== expected && !matchesCleanedInput(state, cp, relative, expected))
      fail(`Conteúdo do commit divergente: ${relative}`);
  }
}

function matchesCleanedInput(state, cp, relative, expected) {
  // Git pode normalizar CRLF: exigir bytes validados antes de conferir o blob limpo.
  if (fileHash(state.worktree, relative) !== expected) return false;
  const cwd = state.worktree;
  const cleaned = mustGit(["hash-object", "--path", relative, "--", relative], { cwd }).trim();
  const committed = mustGit(["rev-parse", `${cp.commit_sha}:${relative}`], { cwd }).trim();
  return cleaned === committed;
}

/** Confere prova e inputs atuais; evidência durável deve sobreviver ao pacote. */
export function validateProof(state, event) {
  verifyRefs(state.worktree, event.inputs);
  verifyRefs(state.root, event.evidence);
  verifyRefs(state.root, [event.review]);
  for (const ref of [...event.evidence, event.review]) {
    if (ref.path.startsWith(".harness/workspace/") || ref.path.startsWith(`${state.directory}/`))
      fail("Prova deve sobreviver fora do workspace/pacote");
  }
  if (event.source_revision !== headCommit(state.worktree)) fail("Revisão de validação difere do HEAD");
}

/** Revalida fatos, não executa Git mutável. Uso: reconcile(state). */
export function reconcile(state) {
  if (
    currentBranch(state.worktree) !== state.branch ||
    !gitOk(["merge-base", "--is-ancestor", state.baseline.head, "HEAD"], { cwd: state.worktree })
  )
    fail("Branch/ancestralidade divergente");
  for (const [id, observed] of Object.entries(state.checkpoints)) {
    if (JSON.stringify(checkpoint(state, id)) !== JSON.stringify(observed)) fail(`Checkpoint alterado: ${id}`);
  }
  for (const unit of Object.values(state.units)) {
    if (!unit.validation) continue;
    try {
      verifyRefs(state.worktree, unit.validation.inputs);
      verifyRefs(state.root, unit.validation.evidence);
      verifyRefs(state.root, [unit.validation.review]);
    } catch (error) {
      invalidateAffected(
        state,
        Object.keys(state.units).find((id) => state.units[id] === unit)
      );
      throw error;
    }
    if (!gitOk(["merge-base", "--is-ancestor", unit.validation.source_revision, "HEAD"], { cwd: state.worktree }))
      fail("Revisão validada deixou histórico");
  }
  if (state.obligations.learning?.destination) verifyRefs(state.worktree, [state.obligations.learning.destination]);
  if (state.obligations.delivery) {
    verifyRefs(state.root, state.obligations.delivery.evidence);
    if (state.obligations.delivery.authorization) verifyRefs(state.root, [state.obligations.delivery.authorization]);
  }
}

/** Consulta lifecycle integral; só fecha pacote quando registros próprios fecharam. */
export function lifecycleStatus(state) {
  const helper = fileURLToPath(new URL("../../../test-suite-guardian/scripts/temporary-tests.mjs", import.meta.url));
  const outcome = runProgram(process.execPath, [helper, "status", "--all"], { cwd: state.worktree });
  if (outcome.code !== 0) fail(`Lifecycle ilegível: ${outcome.stdout}`);
  const records = JSON.parse(outcome.stdout).result;
  const owned = records.filter((registry) => registry.feature === state.package_id || state.lifecycles.includes(registry.execution_id));
  for (const registry of owned) {
    if (registry.status !== "closed") fail(`Lifecycle pendente: ${registry.execution_id}`);
    const relative = `.harness/workspace/test-lifecycle/${registry.execution_id}/temporary-tests.json`;
    const check = runProgram(process.execPath, [helper, "record-closure", "--registry", relative, "--summary"], { cwd: state.worktree });
    if (check.code !== 0) fail(`Prova de lifecycle inválida: ${registry.execution_id}`);
  }
  for (const id of state.lifecycles)
    if (!records.some((registry) => registry.execution_id === id)) fail(`Lifecycle registrado ausente: ${id}`);
  const affected = Object.values(state.units).flatMap((unit) => unit.validation?.inputs.map((input) => input.path) ?? []);
  const others = records.filter((registry) => !owned.includes(registry) && registry.status !== "closed");
  if (others.some((registry) => registry.entries.some((entry) => affected.includes(entry.path)))) fail("Lifecycle alheio sobrepõe inputs");
  return { owned: owned.map((registry) => registry.execution_id), other_pending: others.map((registry) => registry.execution_id) };
}

/** Gate final exige provas reais dos checks, não apenas booleanos. */
export function closureProof(state, event) {
  if (event?.schema_version !== 1) fail("Schema de fechamento inválido");
  for (const group of ["discovery", "references", "affected"]) {
    const check = event[group];
    if (check?.result !== "passed" || check.exit_code !== 0 || typeof check.command !== "string" || !check.command.trim())
      fail(`Check final pendente: ${group}`);
    verifyRefs(state.root, check.artifacts);
    if (check.artifacts.some((ref) => ref.path.startsWith(".harness/workspace/"))) fail("Prova final dentro do workspace");
  }
  return event;
}

export function invalidateAffected(state, id) {
  const unit = state.units[id];
  delete unit.validation;
  unit.status = "blocked";
  unit.interrupted = "Inputs/provas divergentes: requer nova validação afetada";
  for (const cp of state.manifest.commit_checkpoints) {
    if (cp.after_units.includes(id) || cp.validation_from_units.includes(id)) delete state.checkpoints[cp.id];
  }
  for (const [consumerId, consumer] of Object.entries(state.units)) {
    if (consumer.dependencies.includes(id) && consumer.status !== "pending") invalidateAffected(state, consumerId);
  }
  state.obligations.learning = null;
  state.obligations.delivery = null;
}

function noChange(state, id, cp) {
  if (!cp.no_change_reason?.trim() || !cp.validation_refs?.length || !cp.input_hashes || !Object.keys(cp.input_hashes).length)
    fail(`No-change sem prova: ${id}`);
  if (cp.branch !== state.branch || cp.worktree !== state.worktree) fail(`Identidade no-change divergente: ${id}`);
  if (!gitOk(["merge-base", "--is-ancestor", cp.source_revision, "HEAD"], { cwd: state.worktree })) fail("Revisão no-change divergente");
  verifyCommittedHashes(state, { ...cp, commit_sha: cp.source_revision });
  const refs = Object.entries(cp.input_hashes).map(([relative, sha256]) => ({ path: relative, sha256 }));
  verifyRefs(state.worktree, refs);
  verifyRefs(state.root, cp.evidence);
  const validationRefs = checkpointProofs(state, id, cp);
  const definition = state.manifest.commit_checkpoints.find((item) => item.id === id);
  for (const unitId of definition.validation_from_units) {
    for (const input of state.units[unitId].validation?.inputs ?? []) {
      if (cp.input_hashes[input.path] !== input.sha256) fail(`No-change não prova input: ${input.path}`);
    }
  }
  return {
    status: "no-change",
    source_revision: cp.source_revision,
    changed_paths: [],
    input_hashes: cp.input_hashes,
    evidence: cp.evidence,
    validation_refs: validationRefs
  };
}

function checkpointProofs(state, id, cp) {
  const definition = state.manifest.commit_checkpoints.find((item) => item.id === id);
  const validated = definition.validation_from_units.flatMap((unitId) => state.units[unitId].validation?.evidence ?? []);
  const refs = cp.validation_refs.map((relative) => {
    const ref = validated.find((item) => item.path === relative);
    if (!ref) fail(`Checkpoint sem referência de validação correspondente: ${relative}`);
    return ref;
  });
  verifyRefs(state.root, refs);
  for (const unitId of definition.validation_from_units) {
    if (!state.units[unitId].validation?.evidence.some((ref) => cp.validation_refs.includes(ref.path)))
      fail(`Checkpoint sem prova do provider: ${unitId}`);
  }
  return refs;
}
