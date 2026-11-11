import { eligible } from "./package.mjs";
import { fail, verifyRefs, readJson } from "./storage.mjs";
import { checkpoint, validateProof, invalidateAffected } from "./evidence.mjs";

/** Aplica evento validado sem executar comandos oriundos de JSON. Uso: record(state, event). */
export function record(state, event) {
  if (event.schema_version !== 1 || typeof event.type !== "string") fail("Evento schema 1/type obrigatório");
  if (["completed", "finalizing", "paused"].includes(state.status)) fail(`Evento proibido no estado ${state.status}`);
  const operations = {
    "unit-started": startUnit,
    "unit-validated": validateUnit,
    "unit-completed": completeUnit,
    "checkpoint-verified": verifyCheckpoint,
    "learning-evaluated": learning,
    "delivery-recorded": delivery,
    stop
  };
  if (!operations[event.type]) fail(`Evento desconhecido: ${event.type}`);
  operations[event.type](state, event);
}

function target(state, event) {
  if (!Object.hasOwn(state.units, event.unit_id)) fail(`Unidade desconhecida: ${event.unit_id}`);
  return state.units[event.unit_id];
}

function startUnit(state, event) {
  const unit = target(state, event);
  if (!eligible(state, event.unit_id)) fail(`Unidade inelegível: ${event.unit_id}`);
  if (!["pending", "blocked"].includes(unit.status)) fail(`Unidade não inicia de ${unit.status}`);
  unit.status = "running";
  unit.intent = { started_at: new Date().toISOString(), head: event.source_revision ?? null };
  delete unit.interrupted;
  delete unit.validation;
  state.status = "running";
}

function validateUnit(state, event) {
  const unit = target(state, event);
  if (!["running", "technical-complete", "completed", "blocked"].includes(unit.status)) fail("Unidade não iniciada");
  // Invalidar antes de conferir nova prova; falha posterior nunca conserva sucesso velho.
  invalidateAffected(state, event.unit_id);
  if (event.result !== "passed") fail(`Validação mais recente falhou: ${event.unit_id}`);
  validateProof(state, event);
  if (event.inputs.some((ref) => ref.path.startsWith(".harness/workspace/"))) fail("Input de validação deve sobreviver ao workspace");
  unit.validation = { inputs: event.inputs, evidence: event.evidence, review: event.review, source_revision: event.source_revision };
  unit.status = "technical-complete";
  delete unit.interrupted;
  for (const id of event.lifecycles ?? []) {
    if (typeof id !== "string" || !id) fail("Lifecycle ID inválido");
    if (!state.lifecycles.includes(id)) state.lifecycles.push(id);
  }
}

function completeUnit(state, event) {
  const unit = target(state, event);
  if (unit.status !== "technical-complete") fail("Gate técnico pendente");
  const owned = state.manifest.commit_checkpoints.filter((cp) => cp.owner_unit === event.unit_id);
  if (owned.some((cp) => !state.checkpoints[cp.id])) fail("Checkpoint do owner pendente");
  unit.status = "completed";
}

function verifyCheckpoint(state, event) {
  const cp = state.manifest.commit_checkpoints.find((item) => item.id === event.checkpoint_id);
  if (!cp || event.checkpoint_state !== state.manifest.commit_policy.execution_state) fail("Referência de checkpoint inválida");
  if ([...cp.after_units, ...cp.validation_from_units].some((id) => !["technical-complete", "completed"].includes(state.units[id].status)))
    fail("Gates técnicos do checkpoint pendentes");
  const verified = checkpoint(state, cp.id);
  const external = readJson(state.root, event.checkpoint_state).checkpoints[cp.id];
  for (const id of cp.validation_from_units) {
    for (const input of state.units[id].validation.inputs) {
      if (verified.changed_paths.includes(input.path) && external.input_hashes[input.path] !== input.sha256)
        fail(`Checkpoint não contém input validado: ${input.path}`);
    }
  }
  state.checkpoints[cp.id] = verified;
}

function learning(state, event) {
  if (!["none", "semantic", "episodic", "procedural"].includes(event.classification) || !event.reason?.trim())
    fail("Aprendizado sem classificação/motivo");
  if (event.classification !== "none") verifyRefs(state.worktree, [event.destination]);
  state.obligations.learning = { classification: event.classification, reason: event.reason, destination: event.destination ?? null };
}

function delivery(state, event) {
  if (Object.values(state.units).some((unit) => unit.status !== "completed")) fail("Entrega antes da conclusão das unidades");
  if (!["local", "published"].includes(event.mode)) fail("Modo de entrega inválido");
  verifyRefs(state.root, event.evidence);
  if (event.evidence.some((ref) => ref.path.startsWith(".harness/workspace/"))) fail("Entrega sem evidência durável");
  if (event.mode === "published") verifyRefs(state.root, [event.authorization]);
  state.obligations.delivery = { mode: event.mode, evidence: event.evidence, authorization: event.authorization ?? null };
}

function stop(state, event) {
  if (!["paused", "blocked"].includes(event.status) || !event.reason?.trim()) fail("Parada sem estado/motivo");
  state.status = event.status;
  state.reason = event.reason;
}
