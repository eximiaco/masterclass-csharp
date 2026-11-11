/** Registro e remoção exata de provas temporárias. Uso: node temporary-tests.mjs status --all. */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { summarizeResult } from "./summary.mjs";
import { execFileSync } from "node:child_process";

const RegistryBase = ".harness/workspace/test-lifecycle";
const ArchiveBase = ".harness/audits/test-strategy";
const EvidenceBase = ".harness/audits";
const HashPattern = /^[a-f0-9]{64}$/;
const IdPattern = /^[a-z0-9][a-z0-9-]{0,119}$/;
const AllowedKinds = ["test", "helper", "config"];
const now = () => new Date().toISOString();
const digest = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const fail = (message) => {
  throw new Error(message);
};
const jsonBytes = (value) => `${JSON.stringify(value, null, 2)}\n`;

function parseOptions(argv) {
  const [operation, ...args] = argv;
  const options = { operation };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (!["--execution", "--feature", "--plan", "--registry", "--path", "--from", "--kind", "--evidence", "--all", "--summary"].includes(flag))
      fail(`Opção desconhecida: ${flag}`);
    if (!flag.startsWith("--")) fail(`Opção inválida: ${flag}`);
    if (["--all", "--summary"].includes(flag)) {
      if (options[flag.slice(2)]) fail(`Opção repetida: ${flag}`);
      options[flag.slice(2)] = true;
      continue;
    }
    if (index + 1 === args.length || args[index + 1].startsWith("--")) fail(`Falta valor: ${flag}`);
    if (Object.hasOwn(options, flag.slice(2))) fail(`Opção repetida: ${flag}`);
    options[flag.slice(2)] = args[++index];
  }
  return options;
}

const commonRoots = new Map();

/** Raiz do repositório principal, mesmo quando `root` é linked worktree. Uso: commonRoot(root). */
function commonRoot(root) {
  if (!commonRoots.has(root)) {
    const gitDir = execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd: root, encoding: "utf8" }).trim();
    commonRoots.set(root, fs.realpathSync(path.dirname(path.resolve(root, gitDir))));
  }
  return commonRoots.get(root);
}

/**
 * Registro e provas ficam na raiz comum: o executor os lê lá e eles precisam
 * sobreviver à remoção do linked worktree. Fontes, testes e planos ficam no worktree.
 */
function baseFor(root, relative) {
  const durable = relative === RegistryBase || [RegistryBase, EvidenceBase].some((base) => relative.startsWith(`${base}/`));
  return durable ? commonRoot(root) : root;
}

function safePath(root, relative) {
  if (typeof relative !== "string" || !relative || relative.includes("\\") || relative.includes("\0") || path.isAbsolute(relative))
    fail(`Caminho relativo inválido: ${relative}`);
  const parts = relative.split("/");
  if (parts.some((part) => !part || part === ".." || part === ".")) fail(`Caminho não canônico: ${relative}`);
  const base = baseFor(root, relative);
  let current = base;
  for (const part of parts) {
    current = path.join(current, part);
    if (!fs.existsSync(current) && !fs.lstatSync(current, { throwIfNoEntry: false })) continue;
    if (fs.lstatSync(current).isSymbolicLink()) fail(`Symlink proibido: ${relative}`);
    if (!fs.realpathSync(current).startsWith(`${base}${path.sep}`)) fail(`Caminho fora do repositório: ${relative}`);
  }
  return current;
}

function readJson(root, relative) {
  return JSON.parse(readSource(root, relative).toString("utf8"));
}

function readSource(root, relative) {
  if (/(^|\/)(\.env(?:\..*)?|credentials[^/]*|secrets?[^/]*)$|\.(pem|key|pfx)$/i.test(relative ?? ""))
    fail("Leitura de credenciais proibida");
  const filename = safePath(root, relative);
  if (!fs.lstatSync(filename).isFile()) fail(`Esperado arquivo regular: ${relative}`);
  return fs.readFileSync(filename);
}

function writeState(root, relative, value) {
  const filename = safePath(root, relative);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  safePath(root, relative);
  const staging = `${filename}.${crypto.randomUUID()}.writing`;
  const descriptor = fs.openSync(staging, "wx", 0o600);
  try {
    fs.writeFileSync(descriptor, jsonBytes(value));
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(staging, filename);
}

function fileHash(root, relative) {
  const filename = safePath(root, relative);
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.nlink !== 1) fail(`Esperado arquivo regular sem hard links: ${relative}`);
  return digest(readSource(root, relative));
}

function head(root) {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
}

function assertId(value, label) {
  if (!IdPattern.test(value ?? "")) fail(`${label} inválido: ${value}`);
  return value;
}

function validateEntry(root, entry, scope) {
  for (const key of ["id", "path", "owner", "reason", "oracle", "expiration", "selection", "default_exclusion"]) {
    if (typeof entry[key] !== "string" || !entry[key].trim()) fail(`Contrato incompleto: ${key}`);
  }
  safePath(root, entry.path);
  if (!scope.includes(entry.path)) fail(`Path não autorizado: ${entry.path}`);
  if (!AllowedKinds.includes(entry.kind)) fail(`Kind inválido: ${entry.kind}`);
  if (!entry.replacement && !entry.no_future_risk) fail(`Risco futuro não resolvido: ${entry.path}`);
  if (!Array.isArray(entry.required_inputs) || !entry.required_inputs.length) fail(`Inputs ausentes: ${entry.path}`);
  for (const input of entry.required_inputs) safePath(root, input);
  if (entry.lifetime !== "validation-only") fail(`Lifetime inválido: ${entry.path}`);
}

function validateRegistry(root, relative, registry) {
  assertId(registry.execution_id, "Execution ID");
  assertId(registry.feature, "Feature");
  if (relative !== `${RegistryBase}/${registry.execution_id}/temporary-tests.json`) fail("Registro fora do path fixo");
  if (registry.schema_version !== 1 || registry.root !== root) fail("Schema ou raiz do registro incompatível");
  if (!Array.isArray(registry.entries) || !Array.isArray(registry.authorized_scope)) fail("Registro inválido");
  const paths = registry.entries.map((entry) => entry.path);
  if (new Set(paths).size !== paths.length) fail("Paths repetidos no registro");
  for (const entry of registry.entries) {
    validateEntry(root, entry, registry.authorized_scope);
    if (entry.baseline !== "absent") fail(`Ownership inválido: ${entry.path}`);
  }
}

function begin(root, options) {
  const executionId = assertId(options.execution, "Execution ID");
  const feature = assertId(options.feature, "Feature");
  const relative = `${RegistryBase}/${executionId}/temporary-tests.json`;
  const filename = safePath(root, relative);
  const plan = readJson(root, options.plan);
  if (!Array.isArray(plan.authorized_scope) || !Array.isArray(plan.entries) || !plan.entries.length)
    fail("Plano exige scope e entries não vazios");
  if (new Set(plan.entries.map((entry) => entry.path)).size !== plan.entries.length) fail("Paths repetidos no plano");
  for (const entry of plan.entries) validateEntry(root, entry, plan.authorized_scope);
  const planHash = fileHash(root, options.plan);
  if (fs.existsSync(filename)) {
    const existing = readJson(root, relative);
    validateRegistry(root, relative, existing);
    if (existing.feature !== feature || existing.plan_hash !== planHash) fail("Registro existente incompatível");
    return existing;
  }
  const registry = {
    schema_version: 1,
    execution_id: executionId,
    feature,
    root,
    authorized_scope: plan.authorized_scope,
    strategy: plan.strategy ?? null,
    plan_hash: planHash,
    contract: plan.entries,
    baselines: Object.fromEntries(
      plan.entries.map((entry) => {
        const tracked = execFileSync("git", ["ls-files", "--", entry.path], { cwd: root, encoding: "utf8" }).trim();
        return [entry.path, fs.existsSync(safePath(root, entry.path)) || tracked ? "present" : "absent"];
      }),
    ),
    entries: [],
    status: "active",
    created_at: now(),
  };
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, jsonBytes(registry), { flag: "wx", mode: 0o600 });
  return registry;
}

function invalidate(registry) {
  registry.status = "active";
  delete registry.validation;
  delete registry.pending_closure;
  for (const entry of registry.entries) {
    delete entry.validated_hash;
    if (entry.status === "validated") entry.status = "created";
  }
}

function create(root, relative, registry, options) {
  if (["closed", "cleanup-pending"].includes(registry.status)) fail(`Criação proibida no estado ${registry.status}`);
  const contract = registry.contract.find((entry) => entry.path === options.path);
  if (!contract || contract.kind !== options.kind) fail(`Path/kind não previsto no plano: ${options.path}`);
  if (registry.baselines?.[options.path] !== "absent") fail(`Arquivo preexistente na baseline: ${options.path}`);
  const bytes = readSource(root, options.from);
  const createdHash = digest(bytes);
  const filename = safePath(root, options.path);
  const existing = registry.entries.find((entry) => entry.path === options.path);
  if (existing) {
    if (existing.status === "creating" && existing.created_hash === createdHash && !fs.existsSync(filename)) {
      fs.mkdirSync(path.dirname(filename), { recursive: true });
      safePath(root, options.path);
      fs.writeFileSync(filename, bytes, { flag: "wx" });
      existing.status = "created";
      writeState(root, relative, registry);
      return;
    }
    if (
      existing.status === "creating" &&
      existing.created_hash === createdHash &&
      fs.existsSync(filename) &&
      fileHash(root, existing.path) === createdHash
    ) {
      existing.status = "created";
      writeState(root, relative, registry);
      return;
    }
    fail(`Path já registrado: ${options.path}`);
  }
  if (fs.existsSync(filename)) fail(`Baseline deve estar ausente: ${options.path}`);
  invalidate(registry);
  const entry = { ...contract, baseline: "absent", status: "creating", created_hash: createdHash, created_at: now() };
  registry.entries.push(entry);
  writeState(root, relative, registry);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  safePath(root, options.path);
  fs.writeFileSync(filename, bytes, { flag: "wx" });
  entry.status = "created";
  writeState(root, relative, registry);
}

function finishUpdate(root, relative, registry, entry, bytes) {
  const targetHash = fileHash(root, entry.path);
  if (![entry.created_hash, entry.next_hash].includes(targetHash)) fail(`Update interrompido com alteração externa: ${entry.path}`);
  const staging = safePath(root, entry.write_path);
  if (!fs.existsSync(staging)) fs.writeFileSync(staging, bytes, { flag: "wx" });
  if (fileHash(root, entry.write_path) !== entry.next_hash) fail(`Escrita parcial ou alterada; reconciliar: ${entry.write_path}`);
  if (fileHash(root, entry.path) !== targetHash) fail(`Arquivo mudou durante update: ${entry.path}`);
  fs.renameSync(staging, safePath(root, entry.path));
  entry.created_hash = entry.next_hash;
  delete entry.next_hash;
  delete entry.write_path;
  entry.status = "created";
  registry.status = "active";
  writeState(root, relative, registry);
}

function update(root, relative, registry, options) {
  if (["closed", "cleanup-pending"].includes(registry.status)) fail(`Update proibido no estado ${registry.status}`);
  const entry = registry.entries.find((entry) => entry.path === options.path);
  const bytes = readSource(root, options.from);
  if (entry?.status === "updating" && digest(bytes) === entry.next_hash) {
    finishUpdate(root, relative, registry, entry, bytes);
    return;
  }
  if (!entry || !["created", "validated"].includes(entry.status)) fail(`Arquivo não atualizável: ${options.path}`);
  if (fileHash(root, entry.path) !== entry.created_hash) fail(`Arquivo alterado externamente: ${entry.path}`);
  invalidate(registry);
  entry.status = "updating";
  entry.next_hash = digest(bytes);
  entry.write_path = `${entry.path}.${crypto.randomUUID()}.updating`;
  writeState(root, relative, registry);
  finishUpdate(root, relative, registry, entry, bytes);
}

function checkArtifacts(root, artifacts) {
  if (!Array.isArray(artifacts) || !artifacts.length) fail("Artefatos reais de evidência ausentes");
  for (const artifact of artifacts) {
    if (artifact.sanitized !== true || !/\.(json|md|txt)$/.test(artifact.path ?? "")) fail("Evidência deve ser texto sanitizado");
    if (!HashPattern.test(artifact.sha256 ?? "") || fileHash(root, artifact.path) !== artifact.sha256)
      fail(`Artefato alterado: ${artifact.path}`);
  }
}

function checkValidation(root, registry, evidence) {
  if (evidence.source_revision !== head(root)) fail("Revisão da evidência difere do HEAD atual");
  if (
    evidence.temporary?.result !== "passed" ||
    evidence.permanent?.result !== "passed" ||
    evidence.expiration_satisfied !== true ||
    evidence.future_risk_resolved !== true ||
    evidence.final_behavior_implemented !== true
  )
    fail("Condições funcionais de limpeza não satisfeitas");
  checkArtifacts(root, evidence.temporary.artifacts);
  checkArtifacts(root, evidence.permanent.artifacts);
  if (!Array.isArray(evidence.inputs)) fail("Hashes de inputs ausentes");
  for (const input of evidence.inputs) {
    if (!HashPattern.test(input.sha256 ?? "") || fileHash(root, input.path) !== input.sha256) fail(`Input alterado: ${input.path}`);
  }
  if (new Set(evidence.inputs.map((input) => input.path)).size !== evidence.inputs.length) fail("Inputs repetidos");
  for (const entry of registry.entries) {
    const decision = evidence.decisions?.find((item) => item.id === entry.id);
    if (
      !decision ||
      decision.result !== "passed" ||
      decision.oracle !== entry.oracle ||
      decision.expiration !== entry.expiration ||
      decision.replacement !== entry.replacement ||
      decision.no_future_risk !== entry.no_future_risk
    )
      fail(`Expiração/risco sem prova correspondente: ${entry.id}`);
    for (const input of entry.required_inputs) {
      if (!evidence.inputs.some((record) => record.path === input)) fail(`Input obrigatório sem prova: ${input}`);
    }
    if (entry.status === "removed") continue;
    const filename = safePath(root, entry.path);
    if (entry.status === "removing" && !fs.existsSync(filename)) continue;
    if (!["created", "validated", "removing"].includes(entry.status)) fail(`Entrada pendente: ${entry.path}`);
    if (fileHash(root, entry.path) !== entry.created_hash) fail(`Arquivo alterado: ${entry.path}`);
  }
}

function recordValidation(root, relative, registry, options) {
  if (!registry.entries.length || registry.entries.some((entry) => entry.status === "removed"))
    fail("Conjunto de entradas inválido para validação");
  invalidate(registry);
  writeState(root, relative, registry);
  const evidence = readJson(root, options.evidence);
  checkValidation(root, registry, evidence);
  if (registry.contract.length !== registry.entries.length) fail("Plano ainda possui arquivos não criados");
  registry.validation = { evidence, sha256: fileHash(root, options.evidence), source: options.evidence, recorded_at: now() };
  for (const entry of registry.entries) {
    entry.validated_hash = entry.created_hash;
    entry.status = "validated";
  }
  registry.status = "validated";
  writeState(root, relative, registry);
}

function cleanup(root, relative, registry) {
  if (registry.status === "closed") {
    for (const entry of registry.entries)
      if (fs.existsSync(safePath(root, entry.path))) fail(`Arquivo removido foi recriado: ${entry.path}`);
    return;
  }
  if (!registry.validation) fail("Sem evidência de validação");
  if (fileHash(root, registry.validation.source) !== registry.validation.sha256) fail("Evidência normalizada alterada");
  checkValidation(root, registry, registry.validation.evidence);
  for (const entry of registry.entries) {
    if (entry.validated_hash !== entry.created_hash) fail(`Sem hash validado: ${entry.path}`);
    if (entry.status === "removed" && fs.existsSync(safePath(root, entry.path))) fail(`Arquivo removido foi recriado: ${entry.path}`);
  }
  registry.status = "cleanup-pending";
  writeState(root, relative, registry);
  for (const entry of registry.entries) {
    if (entry.status === "removed") continue;
    const filename = safePath(root, entry.path);
    if (entry.status === "removing" && !fs.existsSync(filename)) {
      entry.status = "removed";
      entry.removal = { result: "resumed-after-intent", at: now() };
      writeState(root, relative, registry);
      continue;
    }
    entry.status = "removing";
    writeState(root, relative, registry);
    if (fileHash(root, entry.path) !== entry.validated_hash) fail(`Arquivo alterado durante limpeza: ${entry.path}`);
    fs.unlinkSync(filename);
    entry.status = "removed";
    entry.removal = { result: "removed", at: now() };
    writeState(root, relative, registry);
  }
}

function copyImmutable(root, destination, bytes) {
  const filename = safePath(root, destination);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  safePath(root, destination);
  if (fs.existsSync(filename)) {
    if (digest(fs.readFileSync(filename)) !== digest(bytes)) fail(`Arquivo durável diferente: ${destination}`);
    return;
  }
  fs.writeFileSync(filename, bytes, { flag: "wx", mode: 0o600 });
}

function archiveEvidence(root, directory, label, evidence) {
  const archived = structuredClone(evidence);
  const groups = label === "validation" ? ["temporary", "permanent"] : ["discovery", "references", "affected"];
  for (const group of groups) {
    archived[group].artifacts = evidence[group].artifacts.map((artifact, index) => {
      const relative = `artifacts/${label}-${group}-${index}${path.extname(artifact.path)}`;
      const bytes = fs.readFileSync(safePath(root, artifact.path));
      copyImmutable(root, `${directory}/${relative}`, bytes);
      return { path: relative, sha256: digest(bytes), sanitized: true };
    });
  }
  copyImmutable(root, `${directory}/${label}.json`, jsonBytes(archived));
  const files = groups.flatMap((group) => archived[group].artifacts.map((artifact) => ({ path: artifact.path, sha256: artifact.sha256 })));
  return [{ path: `${label}.json`, sha256: digest(jsonBytes(archived)) }, ...files];
}

function recordClosure(root, relative, registry, options) {
  if (registry.status === "closed") {
    for (const entry of registry.entries)
      if (fs.existsSync(safePath(root, entry.path))) fail(`Arquivo removido foi recriado: ${entry.path}`);
    for (const item of registry.archive.files)
      if (fileHash(root, `${registry.archive.directory}/${item.path}`) !== item.sha256) fail("Arquivo durável alterado");
    return;
  }
  if (!registry.validation || registry.entries.some((entry) => entry.status !== "removed")) fail("Limpeza ainda não concluída");
  for (const entry of registry.entries) if (fs.existsSync(safePath(root, entry.path))) fail(`Temporário ainda existe: ${entry.path}`);
  checkValidation(root, registry, registry.validation.evidence);
  if (fileHash(root, registry.validation.source) !== registry.validation.sha256) fail("Evidência normalizada alterada");
  const evidence = readJson(root, options.evidence);
  if (
    evidence.source_revision !== head(root) ||
    evidence.default_discovery_excludes_temporaries !== true ||
    evidence.references_clear !== true
  )
    fail("Conferência final incompleta");
  for (const group of ["discovery", "references", "affected"]) {
    if (evidence[group]?.result !== "passed") fail(`Conferência falhou: ${group}`);
    checkArtifacts(root, evidence[group].artifacts);
  }
  registry.pending_closure ??= { at: now(), evidence_hash: fileHash(root, options.evidence) };
  if (registry.pending_closure.evidence_hash !== fileHash(root, options.evidence)) fail("Evidência de closure mudou durante retomada");
  writeState(root, relative, registry);
  const directory = `${ArchiveBase}/${registry.feature}/${registry.execution_id}`;
  const files = [
    ...archiveEvidence(root, directory, "validation", registry.validation.evidence),
    ...archiveEvidence(root, directory, "closure", evidence),
  ];
  const closed = {
    ...registry,
    status: "closed",
    closed_at: registry.pending_closure.at,
    validation: { archived: files[0] },
    archive: { directory, files },
  };
  delete closed.pending_closure;
  copyImmutable(root, `${directory}/registry.json`, jsonBytes(closed));
  closed.archive.files = [...files, { path: "registry.json", sha256: fileHash(root, `${directory}/registry.json`) }];
  registry.status = "closed";
  Object.assign(registry, closed);
  writeState(root, relative, registry);
}

function statusAll(root) {
  const base = safePath(root, RegistryBase);
  if (!fs.existsSync(base)) return [];
  return fs.readdirSync(base).flatMap((directory) => {
    const relative = `${RegistryBase}/${directory}/temporary-tests.json`;
    const registry = readJson(root, relative);
    // O diretório é compartilhado entre worktrees; cada um responde só pelos seus.
    if (typeof registry.root === "string" && registry.root !== root) return [];
    validateRegistry(root, relative, registry);
    return [registry];
  });
}

function acquireLock(root, relative) {
  const filename = safePath(root, relative);
  if (fs.existsSync(filename)) {
    const previous = readJson(root, relative);
    if (!Number.isSafeInteger(previous.pid) || previous.pid < 1 || previous.root !== root) fail("Lock ilegível exige reconciliação");
    try {
      process.kill(previous.pid, 0);
      fail("Registro ocupado por processo ativo");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
    fs.unlinkSync(filename);
  }
  const descriptor = fs.openSync(filename, "wx", 0o600);
  fs.writeFileSync(descriptor, jsonBytes({ pid: process.pid, root }));
  fs.fsyncSync(descriptor);
  return descriptor;
}

function run(root, options) {
  if (options.operation === "begin") return begin(root, options);
  if (options.operation === "status" && options.all) return statusAll(root);
  const relative = options.registry;
  const registry = readJson(root, relative);
  validateRegistry(root, relative, registry);
  if (options.operation === "status") return registry;
  const lock = `${relative}.lock`;
  const lockPath = safePath(root, lock);
  const descriptor = acquireLock(root, lock);
  try {
    const current = readJson(root, relative);
    validateRegistry(root, relative, current);
    const operations = { create, update, "record-validation": recordValidation, cleanup, "record-closure": recordClosure };
    if (!operations[options.operation]) fail(`Operação inválida: ${options.operation}`);
    operations[options.operation](root, relative, current, options);
    return current;
  } catch (error) {
    const current = readJson(root, relative);
    if (current.status !== "closed") {
      current.status = "blocked";
      current.blocked_reason = error.message;
      writeState(root, relative, current);
    }
    throw error;
  } finally {
    fs.closeSync(descriptor);
    fs.unlinkSync(lockPath);
  }
}

try {
  const root = fs.realpathSync(execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim());
  const options = parseOptions(process.argv.slice(2));
  const result = run(root, options);
  process.stdout.write(jsonBytes({ status: "ok", result: options.summary ? summarizeResult(result) : result }));
} catch (error) {
  process.stdout.write(jsonBytes({ status: "blocked", message: error.message }));
  process.exitCode = 1;
}
