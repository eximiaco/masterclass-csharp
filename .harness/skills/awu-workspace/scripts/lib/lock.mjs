import fs from "node:fs";
import path from "node:path";
import { block } from "./outcome.mjs";

const LockBase = ".harness/workspace/locks";
const ResourcePattern = /^[a-z0-9][a-z0-9-]{0,63}$/;

function lockFile(common, resource) {
  if (!ResourcePattern.test(resource ?? "")) block("lock", `recurso inválido: ${JSON.stringify(resource ?? null)}`);
  return path.join(common, LockBase, `${resource}.json`);
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

/** Dono atual do recurso, ou `null` quando livre ou com dono já encerrado. Uso: lockHolder(common, "e2e-stack"). */
export function lockHolder(common, resource) {
  const filename = lockFile(common, resource);
  if (!fs.existsSync(filename)) return null;
  const holder = JSON.parse(fs.readFileSync(filename, "utf8"));
  return Number.isSafeInteger(holder.pid) && isAlive(holder.pid) ? holder : null;
}

/**
 * Recurso único da máquina (por exemplo, a stack E2E) compartilhado entre frentes:
 * a segunda frente recebe o dono atual em vez de uma falha de infraestrutura.
 * O dono é o processo de longa duração, por isso o pid é informado por quem chama.
 * Uso: acquireLock(common, "e2e-stack", { pid: process.pid, owner: "us-5346" }).
 */
export function acquireLock(common, resource, holder) {
  const filename = lockFile(common, resource);
  const current = lockHolder(common, resource);
  if (current && current.pid !== holder.pid) block("lock-busy", `recurso ${resource} em uso por outra frente`, { holder: current });
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.rmSync(filename, { force: true });
  const record = { resource, pid: holder.pid, owner: holder.owner ?? null, acquired_at: new Date().toISOString() };
  fs.writeFileSync(filename, `${JSON.stringify(record)}\n`, { flag: "wx" });
  return record;
}

/** Libera só o lock do próprio dono; lock de processo vivo alheio é preservado. Uso: releaseLock(common, "e2e-stack", pid). */
export function releaseLock(common, resource, pid) {
  const filename = lockFile(common, resource);
  const current = lockHolder(common, resource);
  if (current && current.pid !== pid) block("lock-busy", `recurso ${resource} pertence a outro processo`, { holder: current });
  fs.rmSync(filename, { force: true });
  return { resource, released: true };
}
