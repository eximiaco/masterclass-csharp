import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const BRANCHING_KEYS = ["strategy", "development_branch", "open_pr", "work_branch_template", "pr_provider"];
export const WORKTREE_KEYS = ["enabled", "path"];
export const DEFAULT_WORKTREE_PATH = ".harness/worktrees";
export const ALLOWED_STRATEGIES = ["trunk-based", "git-flow"];
export const ALLOWED_PR_PROVIDERS = ["github", "azure-devops"];
export const DEFAULT_PR_PROVIDER = "github";
export const STRATEGY_DEFAULT_DEV_BRANCH = { "trunk-based": "main", "git-flow": "develop" };
export const DEFAULT_WORK_BRANCH_TEMPLATE = "{type}({context})";

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

export function resolveBranchingConfig(profile) {
  const profileExists = Boolean(profile.exists);
  let section = null;
  let worktreeSection = null;
  if (profileExists) {
    const versionControl = profile.data?.version_control;
    if (versionControl !== undefined && (versionControl === null || typeof versionControl !== "object" || Array.isArray(versionControl))) {
      throw new ProfileError("secao version_control invalida no project profile");
    }
    const branching = versionControl?.branching;
    if (branching !== undefined && (branching === null || typeof branching !== "object" || Array.isArray(branching))) {
      throw new ProfileError("secao version_control.branching invalida no project profile");
    }
    section = branching ?? null;
    const worktree = versionControl?.worktree;
    if (worktree !== undefined && (worktree === null || typeof worktree !== "object" || Array.isArray(worktree))) {
      throw new ProfileError("secao version_control.worktree invalida no project profile");
    }
    worktreeSection = worktree ?? null;
  }

  const worktreeEnabled = worktreeSection?.enabled ?? false;
  if (typeof worktreeEnabled !== "boolean") {
    throw new ProfileError(`version_control.worktree.enabled deve ser booleano (true ou false); valor atual: ${JSON.stringify(worktreeEnabled)}`);
  }
  const worktreePath = worktreeSection?.path ?? DEFAULT_WORKTREE_PATH;
  if (typeof worktreePath !== "string" || worktreePath.trim() === "") {
    throw new ProfileError("version_control.worktree.path deve ser um caminho relativo nao vazio");
  }
  if (worktreePath.startsWith("/") || worktreePath.split(/[\\/]/).includes("..")) {
    throw new ProfileError(
      `version_control.worktree.path deve ser um caminho relativo dentro do repositorio, sem ".."; valor atual: ${JSON.stringify(worktreePath)}`
    );
  }

  const missingKeys = [];
  for (const key of BRANCHING_KEYS) {
    if (!section || section[key] === undefined || section[key] === null) missingKeys.push(key);
  }

  const strategy = section?.strategy ?? "trunk-based";
  if (!ALLOWED_STRATEGIES.includes(strategy)) {
    throw new ProfileError(
      `strategy nao suportada: ${JSON.stringify(strategy)}; valores aceitos: ${ALLOWED_STRATEGIES.join(", ")}`
    );
  }
  const developmentBranch = section?.development_branch ?? STRATEGY_DEFAULT_DEV_BRANCH[strategy];
  if (typeof developmentBranch !== "string" || developmentBranch.trim() === "") {
    throw new ProfileError("development_branch deve ser uma string nao vazia");
  }
  const openPr = section?.open_pr ?? true;
  if (typeof openPr !== "boolean") {
    throw new ProfileError(`open_pr deve ser booleano (true ou false); valor atual: ${JSON.stringify(openPr)}`);
  }
  const prProvider = section?.pr_provider ?? DEFAULT_PR_PROVIDER;
  if (!ALLOWED_PR_PROVIDERS.includes(prProvider)) {
    throw new ProfileError(
      `pr_provider nao suportado: ${JSON.stringify(prProvider)}; valores aceitos: ${ALLOWED_PR_PROVIDERS.join(", ")}`
    );
  }
  const workBranchTemplate = section?.work_branch_template ?? DEFAULT_WORK_BRANCH_TEMPLATE;
  if (typeof workBranchTemplate !== "string" || !workBranchTemplate.includes("{type}") || !workBranchTemplate.includes("{context}")) {
    throw new ProfileError(
      `work_branch_template deve conter os placeholders {type} e {context}; valor atual: ${JSON.stringify(workBranchTemplate)}`
    );
  }

  return {
    config: {
      strategy,
      development_branch: developmentBranch,
      open_pr: openPr,
      work_branch_template: workBranchTemplate,
      pr_provider: prProvider,
      worktree: {
        enabled: worktreeEnabled,
        path: worktreePath.replace(/\\/g, "/").replace(/\/+$/, "")
      }
    },
    missing_keys: missingKeys,
    section_present: Boolean(section)
  };
}

function lineInfo(line) {
  const raw = stripComment(line);
  if (raw.trim() === "") return null;
  const indent = raw.match(/^ */)[0].length;
  return { indent, text: raw.trim() };
}

function findTopLevelKey(lines, key) {
  for (let index = 0; index < lines.length; index += 1) {
    const info = lineInfo(lines[index]);
    if (!info) continue;
    if (info.indent === 0 && info.text === `${key}:`) return index;
  }
  return -1;
}

function blockEndAfter(lines, keyIndex) {
  const keyIndent = lineInfo(lines[keyIndex]).indent;
  for (let index = keyIndex + 1; index < lines.length; index += 1) {
    const info = lineInfo(lines[index]);
    if (!info) continue;
    if (info.indent <= keyIndent) return index;
  }
  return lines.length;
}

function formatBranchingValue(key, value) {
  if (typeof value === "string") return `"${value}"`;
  return String(value);
}

function branchingBlock(config, keyIndent, unit) {
  return [
    " ".repeat(keyIndent) + "branching:",
    " ".repeat(keyIndent + unit) + `strategy: ${config.strategy}`,
    " ".repeat(keyIndent + unit) + `development_branch: ${config.development_branch}`,
    " ".repeat(keyIndent + unit) + `open_pr: ${config.open_pr}`,
    " ".repeat(keyIndent + unit) + `work_branch_template: ${formatBranchingValue("work_branch_template", config.work_branch_template)}`,
    " ".repeat(keyIndent + unit) + `pr_provider: ${formatBranchingValue("pr_provider", config.pr_provider)}`
  ];
}

export function ensureBranchingDefaults(profilePath, config) {
  if (!existsSync(profilePath)) {
    const content = [
      "schema_version: 1",
      "",
      ...branchingBlockMinimal(config),
      ""
    ].join("\n");
    mkdirSync(dirname(profilePath), { recursive: true });
    writeFileSync(profilePath, content);
    return { created: true, changed: true, added_keys: [...BRANCHING_KEYS] };
  }

  const original = readFileSync(profilePath, "utf8");
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  const lines = original.split(/\r?\n/);
  const addedKeys = [];

  const vcIndex = findTopLevelKey(lines, "version_control");
  if (vcIndex === -1) {
    while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
    lines.push("", ...branchingBlockMinimal(config), "");
    writeFileSync(profilePath, lines.join(eol));
    return { created: false, changed: true, added_keys: [...BRANCHING_KEYS] };
  }

  const vcEnd = blockEndAfter(lines, vcIndex);
  let childIndent = null;
  let branchingIndex = -1;
  for (let index = vcIndex + 1; index < vcEnd; index += 1) {
    const info = lineInfo(lines[index]);
    if (!info) continue;
    if (childIndent === null) childIndent = info.indent;
    if (info.indent === childIndent && info.text === "branching:") branchingIndex = index;
  }

  if (branchingIndex === -1) {
    childIndent = childIndent ?? 2;
    const unit = childIndent;
    const block = branchingBlock(config, childIndent, unit).slice(0);
    let insertAt = vcEnd;
    while (insertAt > vcIndex + 1 && lines[insertAt - 1].trim() === "") insertAt -= 1;
    lines.splice(insertAt, 0, ...block);
    writeFileSync(profilePath, lines.join(eol));
    return { created: false, changed: true, added_keys: [...BRANCHING_KEYS] };
  }

  const branchingEnd = blockEndAfter(lines, branchingIndex);
  let branchChildIndent = null;
  const presentKeys = new Set();
  for (let index = branchingIndex + 1; index < branchingEnd; index += 1) {
    const info = lineInfo(lines[index]);
    if (!info) continue;
    if (branchChildIndent === null) branchChildIndent = info.indent;
    if (info.indent !== branchChildIndent) continue;
    const keyMatch = info.text.match(/^([A-Za-z0-9_-]+)\s*:/);
    if (keyMatch) presentKeys.add(keyMatch[1]);
  }
  for (const key of BRANCHING_KEYS) {
    if (presentKeys.has(key)) continue;
    addedKeys.push(key);
  }
  if (addedKeys.length === 0) {
    return { created: false, changed: false, added_keys: [] };
  }
  const unit = branchChildIndent !== null ? branchChildIndent - lineInfo(lines[branchingIndex]).indent : 4;
  const keyIndent = branchChildIndent ?? lineInfo(lines[branchingIndex]).indent + unit;
  let insertAt = branchingEnd;
  for (const key of addedKeys) {
    lines.splice(insertAt, 0, " ".repeat(keyIndent) + `${key}: ${formatBranchingValue(key, config[key])}`);
    insertAt += 1;
  }
  writeFileSync(profilePath, lines.join(eol));
  return { created: false, changed: true, added_keys: addedKeys };
}

function branchingBlockMinimal(config) {
  return [
    "version_control:",
    "  branching:",
    `    strategy: ${config.strategy}`,
    `    development_branch: ${config.development_branch}`,
    `    open_pr: ${config.open_pr}`,
    `    work_branch_template: ${formatBranchingValue("work_branch_template", config.work_branch_template)}`,
    `    pr_provider: ${formatBranchingValue("pr_provider", config.pr_provider)}`
  ];
}
