import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { block } from "./outcome.mjs";

export const PackagesDir = ".harness/workspace/awu-packages";
export const WorkspaceFile = `${PackagesDir}/workspace.json`;
export const RequestName = "request.md";

export const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
export const packageDir = (workTree, packageId) => path.join(workTree, PackagesDir, packageId);
export const requestPath = (workTree, packageId) => path.join(packageDir(workTree, packageId), RequestName);

/** Fatos da frente; `null` quando o worktree não é uma frente. Uso: readWorkspace(workTree). */
export function readWorkspace(workTree) {
  const filename = path.join(workTree, WorkspaceFile);
  if (!fs.existsSync(filename)) return null;
  const workspace = JSON.parse(fs.readFileSync(filename, "utf8"));
  if (workspace.schema_version !== 1 || typeof workspace.workspace_id !== "string" || !Array.isArray(workspace.packages)) {
    block("workspace-file", `workspace.json incompatível em ${filename}: esperado schema_version 1 com workspace_id e packages`);
  }
  return workspace;
}

/** Escrita atômica: nunca deixa workspace.json pela metade. Uso: writeWorkspace(workTree, workspace). */
export function writeWorkspace(workTree, workspace) {
  const filename = path.join(workTree, WorkspaceFile);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const staging = `${filename}.${crypto.randomUUID()}.writing`;
  fs.writeFileSync(staging, `${JSON.stringify(workspace, null, 2)}\n`, { flag: "wx" });
  fs.renameSync(staging, filename);
}

/** Aplica fatos novos preservando os demais. Uso: updateWorkspace(workTree, { pushed_sha }). */
export function updateWorkspace(workTree, facts) {
  const workspace = { ...readWorkspace(workTree), ...facts };
  writeWorkspace(workTree, workspace);
  return workspace;
}

function originLine(origin) {
  if (origin.kind !== "work-item") return "Origem: descrição informada pelo usuário";
  const item = origin.work_item;
  return `Origem: ${item.type} ${item.id}${item.title ? ` — ${item.title}` : ""}`;
}

/**
 * Cria a pasta do pacote com o pedido inicial. O hash do seed distingue pedido
 * ainda não detalhado de pedido capturado, sem marcação manual de fase.
 * Uso: createPackage(workTree, "us-5346", origin, "texto do pedido").
 */
export function createPackage(workTree, packageId, origin, description) {
  const directory = packageDir(workTree, packageId);
  if (fs.existsSync(directory)) block("package-exists", `pasta do pacote já existe: ${packageId}`);
  fs.mkdirSync(directory, { recursive: true });
  const seed = [`# Pedido — ${packageId}`, "", originLine(origin), ...(description ? ["", description.trim()] : []), ""].join("\n");
  fs.writeFileSync(requestPath(workTree, packageId), seed, { flag: "wx" });
  return { id: packageId, seed_sha256: sha256(seed) };
}
