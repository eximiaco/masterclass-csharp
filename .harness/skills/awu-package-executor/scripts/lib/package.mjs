import path from "node:path";
import { parseSimpleYaml } from "../../../awu-workspace/scripts/lib/profile.mjs";
import { read, safe, fail, inventory, verifyRefs } from "./storage.mjs";

export const StateBase = ".harness/workspace/package-executions";
export const PackageStates = ["planned", "running", "blocked", "paused", "finalizing", "completed"];
export const UnitStates = ["pending", "running", "technical-complete", "completed", "blocked"];
export const assertId = (id) => {
  if (!/^[a-z0-9][a-z0-9-]{0,119}$/.test(id ?? "")) fail(`ID inválido: ${id}`);
  return id;
};
const unitIds = (items) => items.map((item) => (typeof item === "string" ? item : item.id));

/** Carrega pacote fechado sem executar conteúdo YAML. Uso: loadPackage(root, manifest). */
export function loadPackage(root, manifestPath) {
  const manifest = parseSupported(read(root, manifestPath).toString("utf8"));
  assertId(manifest.id);
  const directory = path.posix.dirname(manifestPath);
  if (!directory.startsWith(".harness/workspace/awu-packages/")) fail("Pacote fora de awu-packages");
  validateUnits(root, directory, manifest.units);
  validateCheckpoints(manifest);
  const strategyPath = `${directory}/test-strategy.yaml`;
  const strategy = parseSupported(read(root, strategyPath).toString("utf8"));
  if (!["ready", "not-applicable"].includes(strategy.status)) fail("Estratégia não está pronta");
  if (strategy.status === "not-applicable" && (typeof strategy.reason !== "string" || !strategy.reason.trim())) {
    fail("Estratégia not-applicable exige justificativa");
  }
  read(root, `${directory}/review-manifest.md`);
  const known = [
    manifestPath,
    strategyPath,
    `${directory}/review-manifest.md`,
    ...manifest.units.map((unit) => specPath(directory, unit.spec)),
    ...packageInputPaths(root, directory, manifest.package_inputs)
  ];
  const files = inventory(root, directory);
  if (files.some((item) => !known.includes(item.path))) fail("Arquivo desconhecido no pacote");
  return { manifest, directory, files };
}

function packageInputPaths(root, directory, inputs = []) {
  if (!Array.isArray(inputs)) fail("package_inputs deve ser uma lista de referências path/sha256");
  const refs = inputs.map((input) => {
    if (!input || typeof input.path !== "string") fail("Input do pacote exige path relativo e sha256");
    const relative = input.path.startsWith("./") ? input.path.slice(2) : input.path;
    const inputPath = `${directory}/${relative}`;
    safe(root, inputPath);
    return { path: inputPath, sha256: input.sha256 };
  });
  if (refs.length) verifyRefs(root, refs);
  return refs.map((ref) => ref.path);
}

export function specPath(directory, spec) {
  if (typeof spec !== "string") fail("Spec ausente");
  const relative = spec.startsWith("./") ? spec.slice(2) : spec;
  if (relative.split("/").includes("..") || path.isAbsolute(relative)) fail(`Spec fora do pacote: ${spec}`);
  return `${directory}/${relative}`;
}

function validateUnits(root, directory, units) {
  if (!Array.isArray(units) || !units.length) fail("Unidades ausentes");
  const ids = units.map((unit) => assertId(unit.id));
  if (new Set(ids).size !== ids.length) fail("IDs de unidades repetidos");
  if (new Set(units.map((unit) => specPath(directory, unit.spec))).size !== units.length) fail("Spec compartilhada entre owners");
  for (const unit of units) {
    if (
      ![
        "development",
        "unit-testing",
        "integration-testing",
        "e2e-testing",
        "documentation",
        "review",
        "testing",
        "code-review",
        "troubleshooting"
      ].includes(unit.work_type)
    )
      fail(`work_type inválido: ${unit.work_type}`);
    read(root, specPath(directory, unit.spec));
    if (!Array.isArray(unit.depends_on) || unitIds(unit.depends_on).some((id) => !ids.includes(id)))
      fail(`Dependência inválida: ${unit.id}`);
  }
  for (const id of ids) visit(units, id, []);
}

function visit(units, id, stack) {
  if (stack.includes(id)) fail(`DAG cíclico: ${[...stack, id].join(" → ")}`);
  for (const dependency of unitIds(units.find((unit) => unit.id === id).depends_on)) visit(units, dependency, [...stack, id]);
}

function validateCheckpoints(manifest) {
  if (!manifest.commit_policy?.execution_state || !manifest.commit_policy?.final_gate) fail("commit_policy incompleta");
  safe("/", manifest.commit_policy.execution_state);
  if (!manifest.commit_policy.execution_state.startsWith(".harness/workspace/commit-checkpoints/"))
    fail("Estado de checkpoints fora do destino");
  const ids = manifest.units.map((unit) => unit.id);
  const checkpoints = manifest.commit_checkpoints;
  if (!Array.isArray(checkpoints)) fail("commit_checkpoints ausentes");
  if (new Set(checkpoints.map((cp) => assertId(cp.id))).size !== checkpoints.length) fail("Checkpoints repetidos");
  for (const cp of checkpoints) {
    if (!ids.includes(cp.owner_unit) || !cp.gate || !cp.commit_subject) fail(`Checkpoint incompleto: ${cp.id}`);
    for (const key of ["after_units", "before_units", "paths_from_units", "validation_from_units"]) {
      if (!Array.isArray(cp[key]) || cp[key].some((id) => !ids.includes(id))) fail(`Checkpoint inválido: ${cp.id}/${key}`);
    }
    if (!cp.after_units.includes(cp.owner_unit)) fail(`Owner sem gate técnico: ${cp.id}`);
    for (const consumer of cp.before_units) {
      if (cp.after_units.includes(consumer) || !cp.after_units.some((provider) => dependsOn(manifest.units, consumer, provider)))
        fail(`Consumidor artificial/cíclico de checkpoint: ${consumer}`);
    }
  }
}

/** Elegibilidade técnica separada do commit do owner. Uso: eligible(state, unitId). */
export function eligible(state, id) {
  const unit = state.units[id];
  const dependenciesReady = unit.dependencies.every((dependency) =>
    ["technical-complete", "completed"].includes(state.units[dependency].status)
  );
  const checkpointsReady = state.manifest.commit_checkpoints
    .filter((cp) => cp.before_units.includes(id))
    .every((cp) => Boolean(state.checkpoints[cp.id]));
  return dependenciesReady && checkpointsReady;
}

/** Valida estrutura persistida antes de qualquer overwrite. Uso: validateState(state, relative). */
export function validateState(state, relative) {
  if (state.schema_version !== 1 || !PackageStates.includes(state.status)) fail("Schema/estado de pacote desconhecido");
  if (relative !== `${StateBase}/${assertId(state.package_id)}/${assertId(state.execution_id)}/state.json`)
    fail("Estado fora do path fixo");
  if (!state.manifest || !Array.isArray(state.files) || !state.baseline || !state.checkpoints || !state.units || !state.obligations)
    fail("Estado corrompido");
  if (Object.keys(state.units).length !== state.manifest.units.length) fail("Inventário de unidades corrompido");
  for (const spec of state.manifest.units) {
    if (!UnitStates.includes(state.units[spec.id]?.status)) fail(`Estado de unidade desconhecido: ${spec.id}`);
  }
}

function dependsOn(units, consumer, provider) {
  const dependencies = unitIds(units.find((unit) => unit.id === consumer).depends_on);
  return dependencies.includes(provider) || dependencies.some((id) => dependsOn(units, id, provider));
}

function parseSupported(text) {
  if (/(?:^|:\s+|-\s+|\[\s*)![a-zA-Z!]/m.test(text)) fail("Tag YAML não suportada");
  return parseSimpleYaml(text);
}
