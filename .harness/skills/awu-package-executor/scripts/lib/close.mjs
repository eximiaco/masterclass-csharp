import fs from "node:fs";
import path from "node:path";
import { fail, safe, exists, inventory, fileHash, write } from "./storage.mjs";
import { reconcile, lifecycleStatus, closureProof } from "./evidence.mjs";
import { operationalInventory } from "./retention.mjs";

/** Verifica inventário, inclusive ausências que só são válidas após intenção. */
export function verifyPackage(state) {
  const removed = state.removal ?? {};
  if (exists(safe(state.worktree, state.directory))) {
    const current = inventory(state.worktree, state.directory);
    for (const item of current) {
      const original = state.files.find((entry) => entry.path === item.path);
      if (!original || original.sha256 !== item.sha256 || removed[item.path]?.status === "removed")
        fail(`Pacote alterado/recriado: ${item.path}`);
    }
  }
  for (const item of state.files) {
    if (!exists(safe(state.worktree, item.path)) && !["removing", "removed"].includes(removed[item.path]?.status))
      fail(`Arquivo ausente antes de intenção: ${item.path}`);
  }
}

/** Finaliza em duas fases; nunca usa glob, rmtree ou git clean. Uso: close(state, relative, proof). */
export function close(state, relative, event, eventPath) {
  reconcile(state);
  verifyPackage(state);
  if (state.status === "completed") {
    closureProof(state, state.closure);
    lifecycleStatus(state);
    return;
  }
  if (["paused", "blocked"].includes(state.status)) fail(`Retomar antes de fechar: ${state.status}`);
  if (Object.values(state.units).some((unit) => unit.status !== "completed")) fail("Unidades pendentes");
  if (state.manifest.commit_checkpoints.some((cp) => !state.checkpoints[cp.id])) fail("Checkpoints pendentes");
  if (!state.obligations.learning || !state.obligations.delivery) fail("Aprendizado/entrega pendente");
  if (state.manifest.commit_policy.required_delivery === "published" && state.obligations.delivery.mode !== "published")
    fail("Publicação requerida pendente");
  const lifecycle = lifecycleStatus(state);
  const closure = closureProof(state, state.closure ?? event);
  // Fechar ownership antes de retirar pacote ou qualquer estado operacional.
  operationalInventory({ ...state, cleanup_intent: { lifecycle } }, relative, closure.retirement, eventPath);
  state.closure = closure;
  state.status = "finalizing";
  state.removal ??= {};
  state.cleanup_intent ??= { at: new Date().toISOString(), inventory: state.files, lifecycle };
  write(state.root, relative, state);
  for (const item of state.files) removeFile(state, relative, item);
  removeDirectories(state);
  state.status = "completed";
  state.receipt = { completed_at: new Date().toISOString(), removed: state.files.length, delivery: state.obligations.delivery.mode };
  write(state.root, relative, state);
}

function removeFile(state, relative, item) {
  const receipt = state.removal[item.path];
  if (receipt?.status === "removed") return;
  const filename = safe(state.worktree, item.path);
  if (exists(filename)) {
    if (fileHash(state.worktree, item.path) !== item.sha256) fail(`Pacote mudou durante retirada: ${item.path}`);
    state.removal[item.path] = { status: "removing", sha256: item.sha256 };
    write(state.root, relative, state);
    fs.unlinkSync(filename);
  } else if (receipt?.status !== "removing") fail(`Ausência sem intenção: ${item.path}`);
  state.removal[item.path] = { status: "removed", sha256: item.sha256, at: new Date().toISOString() };
  write(state.root, relative, state);
}

function removeDirectories(state) {
  const directories = new Set([state.directory]);
  for (const item of state.files) {
    let parent = path.posix.dirname(item.path);
    while (parent.startsWith(`${state.directory}/`)) {
      directories.add(parent);
      parent = path.posix.dirname(parent);
    }
  }
  for (const directory of [...directories].sort((left, right) => right.length - left.length)) {
    const filename = safe(state.worktree, directory);
    if (!exists(filename)) continue;
    if (fs.readdirSync(filename).length) fail(`Diretório preservado por arquivo desconhecido: ${directory}`);
    fs.rmdirSync(filename);
  }
}
