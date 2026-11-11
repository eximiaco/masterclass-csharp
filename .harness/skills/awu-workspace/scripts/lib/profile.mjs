import { existsSync, readFileSync } from "node:fs";

const ALLOWED_STRATEGIES = ["trunk-based", "git-flow"];
const ALLOWED_PR_PROVIDERS = ["github", "azure-devops"];
const DEFAULT_PR_PROVIDER = "github";
const STRATEGY_DEFAULT_DEV_BRANCH = { "trunk-based": "main", "git-flow": "develop" };
const DEFAULT_NAMING = { user_story: "feature/us-{id}", descriptive: "feature/{slug}" };

export class ProfileError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "ProfileError";
    Object.assign(this, details);
  }
}

export function readProfile(profilePath) {
  if (!existsSync(profilePath)) {
    return { exists: false, text: null, data: null };
  }
  const text = readFileSync(profilePath, "utf8");
  return { exists: true, text, data: parseSimpleYaml(text) };
}

function stripComment(line) {
  let inSingle = false;
  let inDouble = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === "'" && !inDouble) inSingle = !inSingle;
    else if (char === '"' && !inSingle) inDouble = !inDouble;
    else if (char === "#" && !inSingle && !inDouble) {
      if (index === 0 || /\s/.test(line[index - 1])) return line.slice(0, index);
    }
  }
  return line;
}

function splitInline(text) {
  const items = [];
  let depth = 0;
  let current = "";
  let quote = null;
  for (const char of text) {
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; current += char; continue; }
    if (char === "[" || char === "{") { depth += 1; current += char; continue; }
    if (char === "]" || char === "}") { depth -= 1; current += char; continue; }
    if (char === "," && depth === 0) { items.push(current); current = ""; continue; }
    current += char;
  }
  if (current.trim() !== "" || items.length === 0) items.push(current);
  return items;
}

function parseScalar(raw) {
  const value = raw.trim();
  if (value === "" || value === "~" || value === "null" || value === "Null" || value === "NULL") return null;
  if (value === "true" || value === "True" || value === "TRUE") return true;
  if (value === "false" || value === "False" || value === "FALSE") return false;
  if (/^[+-]?[0-9]+$/.test(value)) return Number(value);
  if (/^[0-9]*\.[0-9]+$/.test(value)) return Number(value);
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    return value.slice(1, -1).replace(/\\(.)/g, (_, char) => (char === "n" ? "\n" : char));
  }
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    if (inner === "") return [];
    return splitInline(inner).map((item) => parseScalar(item));
  }
  if (value.startsWith("{") || value.startsWith("&") || value.startsWith("*") || value.startsWith("|") || value.startsWith(">")) {
    throw new Error(`valor YAML nao suportado pelo parser simplificado do profile: ${JSON.stringify(value.slice(0, 40))}`);
  }
  return value;
}

const KEY_LINE = /^([^:#\n]+?)\s*:(?:\s+(.*))?$/;

export function parseSimpleYaml(text) {
  const lines = text.split(/\r?\n/);
  const logical = [];
  for (let index = 0; index < lines.length; index += 1) {
    const raw = stripComment(lines[index]);
    if (raw.trim() === "") continue;
    if (/^\t/.test(raw)) {
      throw new Error(`indentacao com tabulacao nao suportada no profile (linha ${index + 1})`);
    }
    logical.push({ line: index + 1, indent: raw.match(/^ */)[0].length, text: raw.trim() });
  }
  let cursor = 0;
  const result = parseBlock();
  if (cursor !== logical.length) {
    const item = logical[cursor];
    throw new Error(`conteudo YAML nao suportado na linha ${item.line}: ${item.text}`);
  }
  return result;

  function parseBlock() {
    if (cursor >= logical.length) return null;
    const first = logical[cursor];
    if (first.text.startsWith("- ")) return parseSequence(first.indent);
    return parseMapping(first.indent);
  }

  function parseMapping(indent) {
    const mapping = {};
    let lastKey = null;
    while (cursor < logical.length) {
      const item = logical[cursor];
      if (item.indent < indent) break;
      if (item.indent > indent) {
        throw new Error(`indentacao inesperada na linha ${item.line}: ${item.text}`);
      }
      if (item.text.startsWith("- ")) {
        if (lastKey !== null && mapping[lastKey] === null) {
          mapping[lastKey] = parseSequence(indent);
          lastKey = null;
          continue;
        }
        throw new Error(`sequencia inesperada dentro de mapeamento na linha ${item.line}: ${item.text}`);
      }
      const match = item.text.match(KEY_LINE);
      if (!match) {
        throw new Error(`linha nao reconhecida como chave do profile na linha ${item.line}: ${item.text}`);
      }
      const key = match[1].trim();
      const inlineValue = match[2] === undefined ? null : match[2];
      cursor += 1;
      lastKey = key;
      if (inlineValue === null || inlineValue.trim() === "") {
        mapping[key] = peekNested(indent);
      } else {
        mapping[key] = parseScalar(inlineValue);
      }
    }
    return mapping;
  }

  function parseSequence(indent) {
    const sequence = [];
    while (cursor < logical.length) {
      const item = logical[cursor];
      if (item.indent !== indent || !item.text.startsWith("-")) break;
      const body = item.text.slice(1).trim();
      cursor += 1;
      const keyMatch = body.match(KEY_LINE);
      if (body === "") {
        sequence.push(peekNested(indent) ?? null);
      } else if (keyMatch) {
        sequence.push(parseItemMapping(item.indent, keyMatch[1].trim(), keyMatch[2] ?? null));
      } else {
        sequence.push(parseScalar(body));
      }
    }
    return sequence;
  }

  function parseItemMapping(itemIndent, firstKey, inlineValue) {
    const mapping = {};
    if (inlineValue === null || inlineValue.trim() === "") {
      mapping[firstKey] = peekNested(itemIndent);
    } else {
      mapping[firstKey] = parseScalar(inlineValue);
    }
    if (cursor < logical.length && logical[cursor].indent > itemIndent) {
      Object.assign(mapping, parseMapping(logical[cursor].indent));
    }
    return mapping;
  }

  function peekNested(parentIndent) {
    if (cursor >= logical.length) return null;
    const next = logical[cursor];
    if (next.indent <= parentIndent) return null;
    return parseBlock();
  }
}

const isMapping = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function section(parent, key, label) {
  const value = parent?.[key];
  if (value === undefined || value === null) return {};
  if (!isMapping(value)) throw new ProfileError(`secao ${label} invalida no project profile`);
  return value;
}

function oneOf(value, allowed, label) {
  if (!allowed.includes(value)) {
    throw new ProfileError(`${label} nao suportado: ${JSON.stringify(value)}; valores aceitos: ${allowed.join(", ")}`);
  }
  return value;
}

function resolveNaming(branching) {
  const naming = { ...DEFAULT_NAMING, ...section(branching, "work_branch_naming", "version_control.branching.work_branch_naming") };
  for (const [key, template] of Object.entries(naming)) {
    const placeholder = key === "descriptive" ? "{slug}" : "{id}";
    if (!/^[a-z0-9_]+$/.test(key) || typeof template !== "string" || !template.includes(placeholder)) {
      throw new ProfileError(`work_branch_naming.${key} deve ser um template com ${placeholder}; valor atual: ${JSON.stringify(template)}`);
    }
  }
  return naming;
}

function relativeList(value, label) {
  const items = value ?? [];
  const valid = (item) => typeof item === "string" && item !== "" && !item.startsWith("/") && !item.split(/[\\/]/).includes("..");
  if (!Array.isArray(items) || !items.every(valid)) {
    throw new ProfileError(`${label} deve ser uma lista de caminhos relativos ao repositorio, sem ".."`);
  }
  return items.map((item) => item.replace(/\\/g, "/"));
}

function resolveWorktree(versionControl, repoName) {
  const worktree = section(versionControl, "worktree", "version_control.worktree");
  const location = worktree.path ?? `../${repoName}.wt`;
  if (typeof location !== "string" || location.trim() === "" || location.startsWith("/")) {
    throw new ProfileError(`version_control.worktree.path deve ser um caminho relativo a raiz do repositorio; valor atual: ${JSON.stringify(location)}`);
  }
  const bootstrap = section(worktree, "bootstrap", "version_control.worktree.bootstrap");
  return {
    path: location.replace(/\\/g, "/").replace(/\/+$/, ""),
    bootstrap: {
      copy: relativeList(bootstrap.copy, "version_control.worktree.bootstrap.copy"),
      ignore: relativeList(bootstrap.ignore, "version_control.worktree.bootstrap.ignore")
    }
  };
}

/**
 * Configuracao das frentes de trabalho; chaves ausentes usam defaults em memoria e
 * o profile nunca e reescrito. Uso: resolveWorkspaceConfig(readProfile(path), "FTC").
 */
export function resolveWorkspaceConfig(profile, repoName) {
  const versionControl = section(profile.data, "version_control", "version_control");
  const branching = section(versionControl, "branching", "version_control.branching");
  const strategy = oneOf(branching.strategy ?? "trunk-based", ALLOWED_STRATEGIES, "strategy");
  if (branching.open_pr === false) {
    throw new ProfileError("open_pr: false (merge direto) nao e suportado; a entrega e sempre por push e pull request");
  }
  const developmentBranch = branching.development_branch ?? STRATEGY_DEFAULT_DEV_BRANCH[strategy];
  if (typeof developmentBranch !== "string" || developmentBranch.trim() === "") {
    throw new ProfileError("development_branch deve ser uma string nao vazia");
  }
  const commits = section(versionControl, "commits", "version_control.commits");
  return {
    development_branch: developmentBranch,
    pr_provider: oneOf(branching.pr_provider ?? DEFAULT_PR_PROVIDER, ALLOWED_PR_PROVIDERS, "pr_provider"),
    naming: resolveNaming(branching),
    worktree: resolveWorktree(versionControl, repoName),
    commits: { style: commits.style ?? null, header_max_length: commits.header_max_length ?? null }
  };
}
