import fs from "node:fs";
import path from "node:path";
import { mustGit } from "../../../awu-workspace/scripts/lib/git.mjs";
import { StateBase, validateState } from "./package.mjs";
import { closureProof } from "./evidence.mjs";
import { exists, fail, fileHash, hash, json, locked, readJson, safe, verifyRefs, write } from "./storage.mjs";

const ArchiveBase = ".harness/audits/package-executions";

/** Destino determinístico permite consultar o estado antigo sem índice no workspace. */
export function archivePath(relative) {
  const match = /^\.harness\/workspace\/package-executions\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]+)\/state\.json$/.exec(relative);
  if (!match) fail("Estado fora do path fixo de execução");
  return `${ArchiveBase}/${match[1]}/${match[2]}/execution.json`;
}

/** Lê arquivo final e confere integridade sem exigir fontes antigas no worktree atual. */
export function archived(root, relative) {
  const destination = archivePath(relative);
  if (!exists(safe(root, destination))) return null;
  const record = readJson(root, destination);
  if (record.schema_version !== 1 || record.logical_state !== relative || !["removing", "retired"].includes(record.status))
    fail("Arquivo de execução incompatível");
  validateState(record.state, relative);
  if (record.state.root !== root || hash(json(record.state)) !== record.state_hash) fail("Estado arquivado divergente");
  if (record.state.status !== "completed" || !Array.isArray(record.files) || !record.files.some((item) => item.path === relative))
    fail("Arquivo terminal sem estado/inventário próprio");
  verifyRefs(root, record.proofs);
  verifyRemovals(root, record);
  return record;
}

function activeReferences(root, relative) {
  const result = [];
  const base = safe(root, StateBase);
  if (!exists(base)) return () => false;
  for (const pkg of fs.readdirSync(base)) {
    const directory = `${StateBase}/${pkg}`;
    if (!fs.lstatSync(safe(root, directory)).isDirectory()) continue;
    for (const execution of fs.readdirSync(safe(root, directory))) {
      if (!fs.lstatSync(safe(root, `${directory}/${execution}`)).isDirectory()) continue;
      const candidate = `${directory}/${execution}/state.json`;
      if (candidate === relative || !exists(safe(root, candidate))) continue;
      const state = readJson(root, candidate);
      validateState(state, candidate);
      if (state.status !== "completed") result.push(state);
    }
  }
  return (filename) =>
    result.some((state) => {
      if (consumedPaths(state).includes(filename)) return true;
      const id = /^\.harness\/workspace\/test-lifecycle\/([^/]+)\/temporary-tests\.json$/.exec(filename)?.[1];
      return Boolean(id && [...(state.lifecycles ?? []), ...(state.cleanup_intent?.lifecycle?.owned ?? [])].includes(id));
    });
}

function consumedPaths(state) {
  // Baseline Git é fotografia histórica, não declaração de dependências.
  const refs = Object.values(state.units).flatMap((unit) => [
    ...(unit.validation?.inputs ?? []),
    ...(unit.validation?.evidence ?? []),
    unit.validation?.review,
  ]);
  refs.push(
    ...(state.obligations.delivery?.evidence ?? []),
    state.obligations.delivery?.authorization,
    state.obligations.learning?.destination,
    ...Object.values(state.closure ?? {}).flatMap((group) => group?.artifacts ?? []),
  );
  return [state.manifest.commit_policy.execution_state, ...refs.filter(Boolean).map((ref) => ref.path)];
}

function checkpointRecord(state, referenced) {
  const relative = state.manifest.commit_policy.execution_state;
  if (!relative?.startsWith(".harness/workspace/commit-checkpoints/")) fail("Checkpoint fora do diretório operacional");
  if (!exists(safe(state.root, relative)) || referenced(relative)) return null;
  const document = readJson(state.root, relative);
  if (document.status === "blocked") return null;
  const expected = Object.keys(state.checkpoints).sort();
  const actual = Object.keys(document.checkpoints ?? {}).sort();
  if (document.package_id !== state.package_id || !expected.length || json(expected) !== json(actual)) return null;
  if (document.execution_id && document.execution_id !== state.execution_id) return null;
  for (const id of expected) {
    const cp = document.checkpoints[id];
    const observed = state.checkpoints[id];
    if (!["committed", "reused", "no-change"].includes(cp.status)) return null;
    if (cp.branch !== state.branch || cp.worktree !== state.worktree) return null;
    if ((cp.commit_sha ?? cp.source_revision) !== (observed.commit_sha ?? observed.source_revision)) return null;
  }
  return { path: relative, sha256: fileHash(state.root, relative), snapshot: document };
}

function lifecycleRecords(state, referenced) {
  const ids = new Set([...(state.lifecycles ?? []), ...(state.cleanup_intent?.lifecycle?.owned ?? [])]);
  return [...ids].map((id) => {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) fail("ID de lifecycle inválido");
    const relative = `.harness/workspace/test-lifecycle/${id}/temporary-tests.json`;
    const registry = readJson(state.root, relative);
    if (registry.execution_id !== id || registry.status !== "closed" || registry.root !== state.worktree)
      fail(`Lifecycle não pode ser retirado: ${id}`);
    if (!registry.archive?.files?.length || registry.entries.some((entry) => entry.status !== "removed"))
      fail(`Lifecycle sem arquivo integral: ${id}`);
    const proofs = registry.archive.files.map((item) => ({ ...item, path: `${registry.archive.directory}/${item.path}` }));
    verifyRefs(state.root, proofs);
    return { path: relative, sha256: fileHash(state.root, relative), snapshot: registry, proofs, shared: referenced(relative) };
  });
}

function scope(state, relative, lifecycles) {
  return [
    path.posix.dirname(relative),
    `.harness/workspace/test-results/${state.package_id}/${state.execution_id}`,
    ...lifecycles.filter((item) => !item.shared).map((item) => path.posix.dirname(item.path)),
  ];
}

function ownedFiles(state, relative, event, eventPath, lifecycles) {
  if (event && (event.schema_version !== 1 || event.package_id !== state.package_id || event.execution_id !== state.execution_id))
    fail("Inventário operacional sem identidade da execução");
  const directories = scope(state, relative, lifecycles);
  const files = event?.files ?? [];
  if (!Array.isArray(files)) fail("Inventário operacional inválido");
  const selected = files.map((item) => ({ path: item.path, sha256: item.sha256 }));
  if (eventPath && directories.some((directory) => eventPath.startsWith(`${directory}/`)))
    selected.push({ path: eventPath, sha256: fileHash(state.root, eventPath) });
  if (selected.some((item) => item.path === relative || !directories.some((directory) => item.path?.startsWith(`${directory}/`))))
    fail("Arquivo operacional fora do escopo próprio");
  if (selected.length) verifyRefs(state.root, selected);
  return { directories, files: selected };
}

function metadata(state, relative, referenced) {
  const lifecycles = lifecycleRecords(state, referenced);
  const checkpoint = checkpointRecord(state, referenced);
  const files = lifecycles.filter((item) => !item.shared).map(({ path, sha256 }) => ({ path, sha256 }));
  if (checkpoint) files.push({ path: checkpoint.path, sha256: checkpoint.sha256 });
  return { lifecycles, checkpoint, files };
}

/** Conferência prévia bloqueia arquivos desconhecidos antes de retirar o pacote. */
export function operationalInventory(state, relative, event, eventPath) {
  const referenced = activeReferences(state.root, relative);
  const records = metadata(state, relative, referenced);
  const owned = ownedFiles(state, relative, event, eventPath, records.lifecycles);
  const files = [...owned.files, ...records.files];
  const selected = new Set([...files.map((item) => item.path), relative, `${relative}.lock`]);
  if (selected.size !== files.length + 2) fail("Arquivo operacional repetido/reservado");
  for (const directory of owned.directories) {
    if (!exists(safe(state.root, directory))) continue;
    for (const item of inventoryWithoutLock(state.root, directory, `${relative}.lock`))
      if (!selected.has(item.path)) fail(`Arquivo operacional desconhecido: ${item.path}`);
  }
  for (const item of [...files, { path: relative }]) {
    if (referenced(item.path)) fail(`Arquivo usado por execução ativa: ${item.path}`);
    if (item.path !== relative && exists(safe(state.root, `${item.path}.lock`))) fail(`Registro operacional ocupado: ${item.path}`);
    if (mustGit(["--literal-pathspecs", "ls-files", "--", item.path], { cwd: state.root }).trim())
      fail(`Arquivo operacional rastreado: ${item.path}`);
  }
  return { ...records, ...owned, files };
}

function inventoryWithoutLock(root, directory, lock) {
  const files = [];
  for (const name of fs.readdirSync(safe(root, directory))) {
    const relative = `${directory}/${name}`;
    if (relative === lock) continue;
    if (fs.lstatSync(safe(root, relative)).isDirectory()) files.push(...inventoryWithoutLock(root, relative, lock));
    else files.push({ path: relative, sha256: fileHash(root, relative) });
  }
  return files;
}

function terminalProofs(state, lifecycles) {
  if (
    state.status !== "completed" ||
    !state.receipt?.completed_at ||
    Object.values(state.units).some(
      (unit) =>
        unit.status !== "completed" || !unit.validation?.inputs?.length || !unit.validation.evidence?.length || !unit.validation.review,
    )
  )
    fail("Somente execução concluída pode retirar estado operacional");
  if (
    !state.obligations.learning ||
    !state.obligations.delivery ||
    state.manifest.commit_checkpoints.some((cp) => !state.checkpoints[cp.id])
  )
    fail("Execução concluída sem obrigações verificadas");
  if (state.files.some((item) => state.removal?.[item.path]?.status !== "removed") || state.receipt.removed !== state.files.length)
    fail("Retirada do pacote ainda não concluída");
  if (exists(safe(state.worktree, state.directory)) && fs.readdirSync(safe(state.worktree, state.directory)).length)
    fail("Pacote reapareceu após conclusão");
  closureProof(state, state.closure);
  for (const unit of Object.values(state.units)) {
    if (!/^[a-f0-9]{40,64}$/.test(unit.validation.source_revision ?? "")) fail("Revisão validada inválida");
    mustGit(["cat-file", "-e", `${unit.validation.source_revision}^{commit}`], { cwd: state.root });
  }
  const proofs = Object.values(state.units).flatMap((unit) => [
    ...(unit.validation?.evidence ?? []),
    ...(unit.validation?.review ? [unit.validation.review] : []),
  ]);
  proofs.push(...state.obligations.delivery.evidence, ...Object.values(state.closure).flatMap((group) => group?.artifacts ?? []));
  if (state.obligations.delivery.authorization) proofs.push(state.obligations.delivery.authorization);
  proofs.push(...lifecycles.flatMap((item) => item.proofs));
  const unique = [...new Map(proofs.map((item) => [item.path, item])).values()];
  if (unique.some((item) => item.path.startsWith(".harness/workspace/"))) fail("Prova final ainda depende do workspace");
  verifyRefs(state.root, unique);
  return unique;
}

function draft(root, relative, event, eventPath) {
  const state = readJson(root, relative);
  validateState(state, relative);
  if (state.root !== root) fail("Raiz de execução divergente");
  const planned = operationalInventory(state, relative, event ?? state.closure?.retirement, eventPath);
  const proofs = terminalProofs(state, planned.lifecycles);
  return {
    schema_version: 1,
    logical_state: relative,
    status: "removing",
    state,
    state_hash: hash(json(state)),
    proofs,
    checkpoint: planned.checkpoint,
    lifecycles: planned.lifecycles,
    directories: planned.directories,
    files: [...planned.files, { path: relative, sha256: fileHash(root, relative) }],
    removals: {},
    started_at: new Date().toISOString(),
  };
}

function verifyRemovals(root, record) {
  for (const item of record.files) {
    const present = exists(safe(root, item.path));
    const receipt = record.removals[item.path];
    if (receipt === "removed" && present) fail(`Arquivo operacional recriado: ${item.path}`);
    if (!present && !["removing", "removed"].includes(receipt)) fail(`Ausência sem intenção operacional: ${item.path}`);
    if (present && fileHash(root, item.path) !== item.sha256) fail(`Arquivo operacional alterado: ${item.path}`);
    if (record.status === "retired" && receipt !== "removed") fail("Recibo operacional incompleto");
  }
}

function removePlanned(root, destination, record) {
  verifyRemovals(root, record);
  for (const item of record.files) {
    if (record.removals[item.path] === "removed") continue;
    if (exists(safe(root, `${item.path}.lock`)) && item.path !== record.logical_state) fail(`Registro operacional ocupado: ${item.path}`);
    record.removals[item.path] = "removing";
    write(root, destination, record);
    if (exists(safe(root, item.path))) {
      if (fileHash(root, item.path) !== item.sha256) fail(`Arquivo mudou durante retirada: ${item.path}`);
      fs.unlinkSync(safe(root, item.path));
    }
    record.removals[item.path] = "removed";
    write(root, destination, record);
  }
  record.status = "retired";
  record.completed_at = new Date().toISOString();
  write(root, destination, record);
}

function prune(root, directories, files) {
  const known = new Set(directories);
  for (const directory of directories)
    if (directory.startsWith(`${StateBase}/`) || directory.startsWith(".harness/workspace/test-results/"))
      known.add(path.posix.dirname(directory));
  for (const item of files) {
    let parent = path.posix.dirname(item.path);
    while (directories.some((directory) => parent === directory || parent.startsWith(`${directory}/`))) {
      known.add(parent);
      parent = path.posix.dirname(parent);
    }
  }
  for (const directory of [...known].sort((left, right) => right.length - left.length)) {
    const filename = safe(root, directory);
    if (exists(filename) && !fs.readdirSync(filename).length) fs.rmdirSync(filename);
  }
}

/** Arquiva fatos terminais e retira somente o inventário conferido, com retomada por recibo. */
export function retire(root, relative, event = null, eventPath = null) {
  const destination = archivePath(relative);
  const result = locked(root, destination, () => {
    const action = () => {
      const record = archived(root, relative) ?? draft(root, relative, event, eventPath);
      if (record.status !== "retired") {
        write(root, destination, record);
        removePlanned(root, destination, record);
      }
      return { state: { ...record.state, operational_retirement: { archive: destination, status: record.status } }, relative, record };
    };
    return exists(safe(root, relative)) ? locked(root, relative, action) : action();
  });
  prune(root, result.record.directories, result.record.files);
  return result;
}

/** Resultado histórico não recria locks/estado operacional nem revalida inputs de outra revisão. */
export function archivedResult(root, relative, operation) {
  const record = archived(root, relative);
  if (!record) return null;
  if (record.status !== "retired") fail(`Retirada interrompida; executar retire --state ${relative}`);
  if (!["status", "next", "close", "resume"].includes(operation)) fail("Execução arquivada é somente leitura");
  return { state: { ...record.state, operational_retirement: { archive: archivePath(relative), status: record.status } }, relative };
}
