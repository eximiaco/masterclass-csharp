import { loadPackage, specPath } from "./package.mjs";
import { exists, fail, fileHash, safe, verifyRefs } from "./storage.mjs";
import { invalidateAffected } from "./evidence.mjs";

/**
 * Aceita refinamento autorizado do pacote durante a execução, sem nova identidade.
 * Recalcula inventário/hashes, invalida a unidade cuja spec mudou (e consumidores),
 * além das unidades pedidas em `invalidate`, e registra o fato com autorização.
 * Unidades e checkpoints do manifesto precisam manter os mesmos IDs e owners:
 * mudança de topologia exige nova compilação/execução. Uso: refine(state, opts).
 */
export function refine(state, { reason, authorization, invalidate }) {
  if (!reason?.trim()) fail("Refinamento exige --reason");
  if (!authorization) fail("Refinamento exige --authorization <prova durável da decisão>");
  if (authorization.startsWith(".harness/workspace/")) fail("Autorização deve sobreviver fora do workspace");
  if (!exists(safe(state.root, authorization))) fail(`Autorização ausente: ${authorization}`);
  const authorizationRef = { path: authorization, sha256: fileHash(state.root, authorization) };
  verifyRefs(state.root, [authorizationRef]);
  if (["completed", "finalizing"].includes(state.status)) fail(`Refinamento proibido no estado ${state.status}`);

  const pkg = loadPackage(state.worktree, state.manifest_path);
  if (pkg.manifest.id !== state.package_id) fail("Refinamento muda identidade do pacote");
  sameTopology(state.manifest, pkg.manifest);

  const before = new Map(state.files.map((item) => [item.path, item.sha256]));
  const after = new Map(pkg.files.map((item) => [item.path, item.sha256]));
  const changes = [...new Set([...before.keys(), ...after.keys()])]
    .filter((relative) => before.get(relative) !== after.get(relative))
    .sort()
    .map((relative) => ({ path: relative, from: before.get(relative) ?? null, to: after.get(relative) ?? null }));
  if (!changes.length) fail("Pacote sem alteração para refinar");

  const requested = invalidate ? invalidate.split(",").map((id) => id.trim()).filter(Boolean) : [];
  for (const id of requested) if (!Object.hasOwn(state.units, id)) fail(`Unidade desconhecida em --invalidate: ${id}`);
  const changedSpecs = pkg.manifest.units
    .filter((unit) => changes.some((change) => change.path === specPath(pkg.directory, unit.spec)))
    .map((unit) => unit.id);
  const invalidated = [...new Set([...changedSpecs, ...requested])].filter((id) => state.units[id].status !== "pending");
  for (const id of invalidated) invalidateAffected(state, id);

  state.manifest = pkg.manifest;
  state.files = pkg.files;
  state.refinements = [
    ...(state.refinements ?? []),
    { at: new Date().toISOString(), reason, authorization: authorizationRef, changes, invalidated },
  ];
  // Pacote alterado reabre as obrigações finais; elas são registradas de novo após os gates.
  state.obligations.learning = null;
  state.obligations.delivery = null;
}

function sameTopology(current, next) {
  const units = (manifest) => manifest.units.map((unit) => unit.id).sort();
  if (JSON.stringify(units(current)) !== JSON.stringify(units(next))) fail("Refinamento muda unidades; compilar nova execução");
  const checkpoints = (manifest) =>
    manifest.commit_checkpoints.map((cp) => `${cp.id}:${cp.owner_unit}`).sort();
  if (JSON.stringify(checkpoints(current)) !== JSON.stringify(checkpoints(next)))
    fail("Refinamento muda checkpoints/owners; compilar nova execução");
}
