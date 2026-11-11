import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
export const fail = (message) => {
  throw new Error(message);
};
export const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
export const exists = (filename) => Boolean(fs.lstatSync(filename, { throwIfNoEntry: false }));

/** Resolve somente paths canônicos sem links. Uso: safe(root, "evidence/run.json"). */
export function safe(root, relative) {
  if (typeof relative !== "string" || !relative || path.isAbsolute(relative) || relative.includes("\\") || relative.includes("\0"))
    fail(`Caminho relativo inválido: ${relative}`);
  if (relative.split("/").some((part) => !part || part === "." || part === "..")) fail(`Caminho não canônico: ${relative}`);
  let current = root;
  for (const part of relative.split("/")) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink() || (stat?.isFile() && stat.nlink !== 1)) fail(`Link proibido: ${relative}`);
  }
  return current;
}

/** Lê fonte regular sem credenciais. Uso: read(root, "proof.json"). */
export function read(root, relative) {
  if (/(^|\/)(\.env(?:\..*)?|credentials[^/]*|secrets?[^/]*)$|\.(pem|key|pfx)$/i.test(relative ?? ""))
    fail(`Fonte sensível proibida: ${relative}`);
  const filename = safe(root, relative);
  if (!fs.lstatSync(filename).isFile()) fail(`Esperado arquivo regular: ${relative}`);
  return fs.readFileSync(filename);
}

export const readJson = (root, relative) => JSON.parse(read(root, relative).toString("utf8"));
export const fileHash = (root, relative) => hash(read(root, relative));

/** Persiste estado atomicamente sem sobrescrever staging existente. Uso: write(root, statePath, state). */
export function write(root, relative, value) {
  const filename = safe(root, relative);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  safe(root, relative);
  const staging = `${filename}.${crypto.randomUUID()}.writing`;
  const fd = fs.openSync(staging, "wx", 0o600);
  try {
    fs.writeFileSync(fd, json(value));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(staging, filename);
}

/** Lock por execução, recuperável só com PID morto. Uso: locked(root, statePath, action). */
export function locked(root, relative, action) {
  const filename = safe(root, `${relative}.lock`);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  if (exists(filename)) recoverLock(root, `${relative}.lock`);
  const fd = fs.openSync(filename, "wx", 0o600);
  try {
    fs.writeFileSync(fd, json({ root, pid: process.pid }));
    fs.fsyncSync(fd);
    return action();
  } finally {
    fs.closeSync(fd);
    fs.unlinkSync(filename);
  }
}

function recoverLock(root, relative) {
  const previous = readJson(root, relative);
  if (previous.root !== root || !Number.isSafeInteger(previous.pid) || previous.pid < 1) fail("Lock ilegível exige reconciliação");
  try {
    process.kill(previous.pid, 0);
    fail("Execução ocupada por processo ativo");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
  fs.unlinkSync(safe(root, relative));
}

/** Inventário exato; nunca segue links. Uso: inventory(root, packageDir). */
export function inventory(root, directory) {
  const result = [];
  for (const name of fs.readdirSync(safe(root, directory))) {
    const relative = `${directory}/${name}`;
    const stat = fs.lstatSync(safe(root, relative));
    if (stat.isDirectory()) result.push(...inventory(root, relative));
    else result.push({ path: relative, sha256: fileHash(root, relative) });
  }
  return result.sort((left, right) => left.path.localeCompare(right.path));
}

/** Verifica referências reais e hashes. Uso: verifyRefs(root, event.inputs). */
export function verifyRefs(root, refs) {
  if (!Array.isArray(refs) || !refs.length) fail("Referências/hashes ausentes");
  if (new Set(refs.map((ref) => ref.path)).size !== refs.length) fail("Referências repetidas");
  for (const ref of refs) {
    if (!/^[a-f0-9]{64}$/.test(ref.sha256 ?? "") || fileHash(root, ref.path) !== ref.sha256) fail(`Prova/input alterado: ${ref.path}`);
  }
}
