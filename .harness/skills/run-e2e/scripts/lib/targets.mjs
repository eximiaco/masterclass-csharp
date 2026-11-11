// Resolve alvos (pasta ou spec) para caminhos relativos a contexts/core/frontend, como o runner espera.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

const FRONTEND_REL = join("contexts", "core", "frontend");

function normalizeInput(input, { repoRoot, frontendDir }) {
  let value = input.trim().replace(/\\/g, "/");
  if (isAbsolute(value)) value = relative(frontendDir, value).split(sep).join("/");
  value = value.replace(/^\.\//, "").replace(/\/+$/, "");
  const prefix = FRONTEND_REL.split(sep).join("/") + "/";
  if (value.startsWith(prefix)) value = value.slice(prefix.length);
  void repoRoot;
  return value;
}

function candidates(value) {
  if (value.startsWith("e2e/")) return [value];
  if (value.startsWith("features/")) return [`e2e/${value}`];
  return [`e2e/features/${value}`, `e2e/${value}`];
}

function featureFolders(frontendDir) {
  const dir = join(frontendDir, "e2e", "features");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => `e2e/features/${e.name}`);
}

function classify(frontendDir, rel) {
  const full = join(frontendDir, rel);
  if (!existsSync(full)) return null;
  const kind = statSync(full).isDirectory() ? "dir" : "file";
  if (kind === "file" && !rel.endsWith(".spec.ts")) return { rel, kind, error: "arquivo nao e um spec (*.spec.ts); o runner nao encontraria testes" };
  if (kind === "file" && !rel.startsWith("e2e/features/")) return { rel, kind, error: "spec fora de e2e/features/ nao casa com testMatch do playwright.config.ts" };
  return { rel, kind };
}

// Retorna { resolved: [{input, path, kind}], errors: [{input, message, suggestions}] }.
export function resolveTargets(inputs, { repoRoot, frontendDir }) {
  const resolved = [];
  const errors = [];
  for (const input of inputs) {
    const value = normalizeInput(input, { repoRoot, frontendDir });
    const found = candidates(value).map((rel) => classify(frontendDir, rel)).find(Boolean);
    if (!found) {
      errors.push({ input, message: `alvo nao encontrado sob contexts/core/frontend/e2e: ${JSON.stringify(input)}`, suggestions: ["Alvos validos sao pastas ou specs sob e2e/features/.", `Pastas disponiveis: ${featureFolders(frontendDir).join(", ") || "(nenhuma)"}`] });
      continue;
    }
    if (found.error) {
      errors.push({ input, message: found.error, suggestions: ["Informe a pasta da feature ou um arquivo *.spec.ts em e2e/features/."] });
      continue;
    }
    resolved.push({ input, path: found.rel, kind: found.kind });
  }
  return { resolved, errors };
}

function collectSpecFiles(dir, acc) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectSpecFiles(full, acc);
    else if (entry.name.endsWith(".spec.ts")) acc.push(full);
  }
  return acc;
}

const TITLE_RE = /^\s*test(?:\.describe)?(?:\.(?:only|skip|fixme|serial|parallel))*\(\s*(['"`])((?:\\.|(?!\1).)*)\1/;

// Listagem estática (sem Docker): extrai títulos de test()/test.describe() por regex.
export function listSpecs(resolved, { frontendDir }) {
  const files = [];
  for (const target of resolved) {
    const full = join(frontendDir, target.path);
    if (target.kind === "dir") collectSpecFiles(full, files);
    else files.push(full);
  }
  const unique = [...new Set(files)].sort();
  return unique.map((file) => ({
    file: relative(frontendDir, file).split(sep).join("/"),
    entries: readFileSync(file, "utf8").split("\n").map((line, index) => {
      const match = line.match(TITLE_RE);
      if (!match) return null;
      return { line: index + 1, kind: line.includes("describe") ? "describe" : "test", title: match[2] };
    }).filter(Boolean)
  }));
}
