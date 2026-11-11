import { execFileSync } from "node:child_process";

/** @typedef {{tag: string, id: string, project: string, layers: string[]}} OwnedImage */
const DockerOptions = {
  encoding: "utf8",
  timeout: 30_000,
  maxBuffer: 8 * 1024 * 1024,
  stdio: ["ignore", "pipe", "pipe"],
};
const rows = (value) => String(value).trim().split("\n").filter(Boolean);
const jsonRows = (value) => rows(value).map((line) => JSON.parse(line));

function validateProject(project) {
  if (!/^ftc-e2e-controlled-run-[a-z0-9-]{6,48}$/.test(project))
    throw new Error("Projeto Docker controlado inválido; retirada bloqueada");
}

function inspectTag(tag, project, invoke) {
  const image = JSON.parse(
    invoke(
      "docker",
      ["image", "inspect", "--format", "{{json .}}", tag],
      DockerOptions,
    ),
  );
  if (image.Config?.Labels?.["com.docker.compose.project"] !== project)
    throw new Error(`Ownership da imagem divergente: ${tag}`);
  return image;
}

/** Inventaria somente tags do projeto com label conferida. Exemplo: inspectOwnedImages(marker.project). @returns {OwnedImage[]} */
export function inspectOwnedImages(project, invoke = execFileSync) {
  validateProject(project);
  const images = jsonRows(
    invoke("docker", ["image", "ls", "--format", "{{json .}}"], DockerOptions),
  );
  return images
    .filter(
      (image) =>
        image.Repository.startsWith(`${project}-`) && image.Tag !== "<none>",
    )
    .map((image) => {
      const tag = `${image.Repository}:${image.Tag}`;
      const current = inspectTag(tag, project, invoke);
      return {
        tag,
        id: current.Id,
        project,
        layers: current.RootFS?.Layers ?? [],
      };
    });
}

function assertUnused(inventory, invoke) {
  const containers = rows(invoke("docker", ["ps", "-aq"], DockerOptions));
  if (!containers.length) return;
  const used = new Set(
    rows(
      invoke(
        "docker",
        ["inspect", "--format", "{{.Image}}", ...containers],
        DockerOptions,
      ),
    ),
  );
  if (inventory.some((image) => used.has(image.id)))
    throw new Error(
      "Imagem própria ainda usada por container; retirada bloqueada",
    );
}

function verifyInventory(project, inventory, invoke) {
  validateProject(project);
  for (const item of inventory) {
    if (
      item.project !== project ||
      !item.tag.startsWith(`${project}-`) ||
      inspectTag(item.tag, project, invoke).Id !== item.id
    )
      throw new Error(`Imagem alterada antes da retirada: ${item.tag}`);
  }
  assertUnused(inventory, invoke);
}

/** Retira tags exatas após último uso, sem force/prune. Exemplo: retireOwnedImages(project, inventory, { persist }). */
export function retireOwnedImages(
  project,
  inventory,
  { invoke = execFileSync, persist = () => {} } = {},
) {
  verifyInventory(project, inventory, invoke);
  const receipt = {
    schema_version: 1,
    project,
    started_at: new Date().toISOString(),
    entries: inventory.map((item) => ({ ...item, status: "planned" })),
  };
  persist(receipt);
  for (const item of receipt.entries) retireTag(item, receipt, invoke, persist);
  receipt.completed_at = new Date().toISOString();
  persist(receipt);
  return receipt;
}

function retireTag(item, receipt, invoke, persist) {
  if (inspectTag(item.tag, item.project, invoke).Id !== item.id)
    throw new Error(`Imagem mudou durante retirada: ${item.tag}`);
  item.status = "removing";
  persist(receipt);
  invoke("docker", ["image", "rm", item.tag], DockerOptions);
  const remaining = rows(
    invoke(
      "docker",
      [
        "image",
        "ls",
        "--filter",
        `reference=${item.tag}`,
        "--format",
        "{{json .}}",
      ],
      DockerOptions,
    ),
  );
  if (remaining.length)
    throw new Error(`Tag permaneceu após retirada: ${item.tag}`);
  item.status = "removed";
  item.removed_at = new Date().toISOString();
  persist(receipt);
}
