import { block } from "./outcome.mjs";

// Mesmo padrão de id do executor: o primeiro pacote herda o id da frente.
export const IdPattern = /^[a-z0-9][a-z0-9-]{0,119}$/;
const MaxSlugLength = 50;

/** Texto livre para kebab-case ASCII. Uso: slugify("Ajuste de configuração") → "ajuste-de-configuracao". */
export function slugify(text) {
  const plain = String(text ?? "").normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
  const slug = plain.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug.slice(0, MaxSlugLength).replace(/-+$/, "");
}

/** Tipo do work item para chave do profile. Uso: normalizeType("Technical Debt") → "technical_debt". */
export function normalizeType(type) {
  return slugify(type).replace(/-/g, "_");
}

function descriptiveBranch(naming, text) {
  const slug = slugify(text);
  if (!slug) block("naming", `descrição sem letras ou números para nomear a branch: ${JSON.stringify(text ?? "")}`);
  return naming.descriptive.replace("{slug}", slug);
}

function workItemBranch(naming, origin) {
  const template = naming[normalizeType(origin.work_item.type)];
  if (!template) return descriptiveBranch(naming, origin.work_item.title);
  return template.replace("{id}", String(origin.work_item.id));
}

/**
 * Branch e id da frente a partir da origem do trabalho. O id é o último segmento
 * da branch e nomeia pasta do worktree e primeiro pacote.
 * Uso: nameWorkspace(naming, { kind: "work-item", work_item: { id: 5346, type: "User Story" } }).
 */
export function nameWorkspace(naming, origin) {
  const branch = origin.kind === "work-item" ? workItemBranch(naming, origin) : descriptiveBranch(naming, origin.description);
  const workspaceId = branch.split("/").at(-1);
  if (!IdPattern.test(workspaceId)) block("naming", `id de frente inválido derivado da branch ${JSON.stringify(branch)}: ${workspaceId}`);
  return { branch, workspaceId };
}
