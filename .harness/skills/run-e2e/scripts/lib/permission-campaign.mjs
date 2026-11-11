import { writeFileSync } from "node:fs";
import { inspectOwnedImages, retireOwnedImages } from "./owned-images.mjs";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

export const CampaignTargets = Object.freeze([
  "e2e/features/auth/menu-permission-recovery.spec.ts",
  "e2e/features/smoke/shell-core-smoke.spec.ts",
  "e2e/features/architecture/decision-authoring.spec.ts",
  "e2e/features/architecture/decision-revisions.spec.ts",
  "e2e/features/architecture/decision-search.spec.ts",
  "e2e/features/architecture/mcp-decision-authoring.spec.ts",
]);
const WatchedRoots = [
  "contexts/shared/",
  "contexts/identity/",
  "contexts/shell/",
  "contexts/core/",
  "contexts/collect/frontend/",
  "contexts/tenant/",
  ".harness/skills/run-e2e/scripts/",
];
const RootBuildInputs = new Set([
  "global.json",
  "Directory.Build.props",
  "Directory.Build.targets",
  "Directory.Packages.props",
  "nuget.config",
  "NuGet.Config",
  "package.json",
  "package-lock.json",
  ".npmrc",
  ".dockerignore",
]);

/** Plano fixo, sem repeat-each nem redução de amostra. Exemplo: createCampaignPlan().comparison.length === 20. */
export function createCampaignPlan() {
  return {
    comparison: Array.from({ length: 20 }, (_, index) => ({
      id: `comparison-${String(index + 1).padStart(2, "0")}`,
      group: "comparison",
      workers: index % 2 ? 3 : 1,
    })),
    concurrent: [1, 2].map((index) => ({
      id: `concurrent-${index}`,
      group: "concurrent",
      workers: 3,
    })),
  };
}

/** Reprova retry, skip, infra, divergência ou sucesso incompleto. Exemplo: assertCampaignRun(report, 1). */
export function assertCampaignRun(report, workers, nativeResults) {
  const stats = report.stats;
  if (
    report.environment !== "controlled" ||
    report.verdict !== "passed" ||
    report.teardown?.status !== "ok" ||
    !stats ||
    stats.workers !== workers ||
    stats.expected <= 0 ||
    stats.unexpected ||
    stats.flaky ||
    stats.skipped ||
    report.run_errors?.length ||
    stats.expected !== 20 ||
    report.tests?.length !== stats.expected ||
    report.tests.some((test) => test.status !== "expected")
  )
    throw new Error(
      "Campanha exige testes completos aprovados, zero retry/skip/flaky e teardown ok",
    );
  const tests = collectNativeTests(nativeResults?.suites ?? []);
  if (
    tests.length !== 20 ||
    tests.some(
      (test) =>
        test.status !== "expected" ||
        test.results?.length !== 1 ||
        test.results[0].retry !== 0 ||
        test.results[0].status !== "passed",
    )
  )
    throw new Error(
      "Reporter nativo deve comprovar uma tentativa por teste, sem retry",
    );
}

function collectNativeTests(suites) {
  return suites.flatMap((suite) => [
    ...(suite.specs ?? []).flatMap((spec) => spec.tests ?? []),
    ...collectNativeTests(suite.suites ?? []),
  ]);
}

/** Hash de fontes/configs efetivos, sem outputs nem documentação. Exemplo: await captureCampaignInputs(root). */
export async function captureCampaignInputs(root) {
  const listed = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: root, encoding: "utf8" },
  );
  const paths = [
    ...new Set(
      listed
        .split("\0")
        .filter(
          (name) =>
            (RootBuildInputs.has(name) ||
              WatchedRoots.some((prefix) => name.startsWith(prefix))) &&
            !name.endsWith(".md"),
        ),
    ),
  ].sort();
  const inputs = [];
  for (const name of paths)
    inputs.push({
      path: name,
      sha256: createHash("sha256")
        .update(await readFile(path.join(root, name)))
        .digest("hex"),
    });
  return {
    sha256: createHash("sha256").update(JSON.stringify(inputs)).digest("hex"),
    files: inputs,
  };
}

/** Cria destinos novos sem sobrescrever prova anterior. Exemplo: await prepareCampaignDirectories(out, evidence). */
export async function prepareCampaignDirectories(outRoot, evidenceRoot) {
  for (const [parent, child] of [
    [outRoot, evidenceRoot],
    [evidenceRoot, outRoot],
  ]) {
    const relative = path.relative(parent, child);
    if (!relative || (!relative.startsWith("..") && !path.isAbsolute(relative)))
      throw new Error(
        "Runtime e prova devem ficar em diretórios independentes",
      );
  }
  for (const directory of [outRoot, evidenceRoot]) {
    await mkdir(path.dirname(directory), { recursive: true });
    await mkdir(directory, { mode: 0o700 });
  }
}

function dockerJson(args) {
  const output = execFileSync("docker", args, {
    encoding: "utf8",
    timeout: 15_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return output
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** Amostra containers próprios, aceitando retirada concorrente comprovada. Exemplo: readDockerResourceStats(containers). */
export function readDockerResourceStats(containers, invoke = execFileSync) {
  const args = [
    "stats",
    "--no-stream",
    "--format",
    "{{json .}}",
    ...containers.map((container) => container.ID),
  ];
  let output;
  const retired = [];
  try {
    output = invoke("docker", args, { encoding: "utf8", timeout: 15_000 });
  } catch (error) {
    const messages = String(error.stderr ?? "")
      .trim()
      .split(/\r?\n/)
      .filter(Boolean);
    if (!messages.length) throw error;
    for (const message of messages) {
      if (message === "EOF") continue;
      const match =
        /^(?:Error response from daemon: )?No such container: (\S+)$/.exec(
          message,
        );
      if (
        !match ||
        !containers.some((container) => match[1].startsWith(container.ID))
      )
        throw error;
      retired.push(match[1]);
    }
    if (messages.includes("EOF")) {
      const active = String(
        invoke("docker", ["ps", "--no-trunc", "--format", "{{.ID}}"], {
          encoding: "utf8",
          timeout: 15_000,
          stdio: ["ignore", "pipe", "pipe"],
        }),
      )
        .trim()
        .split("\n");
      const disappeared = containers.filter(
        (container) => !active.some((id) => id.startsWith(container.ID)),
      );
      // Docker pode emitir um EOF por stream encerrado; validar retirada, nunca repetir teste/ocultar EOF ativo.
      if (!disappeared.length) throw error;
      retired.push(...disappeared.map((container) => container.ID));
    }
    output = String(error.stdout ?? "");
  }
  const stats = output
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return { stats, retired };
}

async function sampleResources(outDir, samples) {
  let marker;
  try {
    marker = JSON.parse(
      await readFile(path.join(outDir, "runtime/ownership.json"), "utf8"),
    );
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  const containers = dockerJson([
    "ps",
    "--filter",
    `label=com.docker.compose.project=${marker.project}`,
    "--format",
    "{{json .}}",
  ]);
  if (!containers.length) return;
  const { stats, retired } = readDockerResourceStats(containers);
  const phase = containers.some((container) =>
    container.Names.includes("-playwright-run-"),
  )
    ? "tests"
    : containers.some((container) =>
          container.Names.includes("-bootstrap-run-"),
        )
      ? "bootstrap"
      : "stack";
  samples.push({
    at: new Date().toISOString(),
    phase,
    retired_during_sample: retired,
    containers: stats.map(({ Name, CPUPerc, MemUsage }) => ({
      name: Name,
      cpu_percent: CPUPerc,
      memory: MemUsage,
    })),
  });
}

function startSampling(outDir) {
  const samples = [];
  const errors = [];
  let pending = null;
  const timer = setInterval(() => {
    if (pending) return;
    pending = sampleResources(outDir, samples)
      .catch((error) => errors.push(error.message))
      .finally(() => {
        pending = null;
      });
  }, 5_000);
  return {
    stop: async () => {
      clearInterval(timer);
      await pending;
      return { samples, errors };
    },
  };
}

async function invokeRunner(root, outDir, workers, liveChildren) {
  const logs = { stdout: "", stderr: "" };
  const args = [
    ".harness/skills/run-e2e/scripts/run-e2e.mjs",
    ...CampaignTargets,
    "--workers",
    String(workers),
    "--retries",
    "0",
    "--logs",
    "always",
    "--out",
    outDir,
    "--",
    "--trace",
    "on",
  ];
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: { ...process.env, FTC_E2E_ENVIRONMENT: "controlled" },
  });
  liveChildren.add(child);
  child.stdout.on("data", (chunk) => {
    logs.stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    logs.stderr += chunk;
  });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 2));
  });
  liveChildren.delete(child);
  await writeFile(path.join(outDir, "runner.stdout"), logs.stdout);
  await writeFile(path.join(outDir, "runner.stderr"), logs.stderr);
  return { code, command: [process.execPath, ...args] };
}

/** Executa uma rodada via runner oficial e arquiva antes da próxima. Exemplo: await executeCampaignRun(context, plan). */
export async function executeCampaignRun(context, plan) {
  const { root, outRoot, evidenceRoot, inputs, liveChildren, repoRoot } =
    context;
  const outDir = path.join(outRoot, plan.id);
  const destination = path.join(evidenceRoot, plan.id);
  const before = await captureCampaignInputs(root);
  if (before.sha256 !== inputs.sha256)
    throw new Error("Inputs mudaram antes da rodada");
  await mkdir(outDir, { recursive: true });
  const startedAt = new Date().toISOString();
  const sampling = startSampling(outDir);
  let invocation;
  try {
    invocation = await invokeRunner(root, outDir, plan.workers, liveChildren);
  } finally {
    await writeFile(
      path.join(outDir, "resources.json"),
      JSON.stringify(await sampling.stop(), null, 2),
    );
  }
  execFileSync(
    "python3",
    [
      path.join(
        root,
        ".harness/skills/run-e2e/scripts/archive-controlled-run.py",
      ),
      "--run",
      outDir,
      "--dest",
      destination,
      "--source-root",
      root,
      "--repo-root",
      repoRoot,
    ],
    { encoding: "utf8" },
  );
  const resources = JSON.parse(
    await readFile(path.join(outDir, "resources.json"), "utf8"),
  );
  await writeFile(
    path.join(destination, "resources.json"),
    JSON.stringify(resources, null, 2),
  );
  const report = JSON.parse(
    await readFile(path.join(outDir, "report.json"), "utf8"),
  );
  const after = await captureCampaignInputs(root);
  const realm = await readFile(path.join(outDir, "runtime/realm.json"));
  const nativeResults =
    invocation.code === 0
      ? JSON.parse(
          await readFile(
            path.join(outDir, "runtime/test-results/e2e-results.json"),
            "utf8",
          ),
        )
      : null;
  const marker = JSON.parse(
    await readFile(path.join(outDir, "runtime/ownership.json"), "utf8"),
  );
  const settings = {};
  for (const filename of (
    await readdir(path.join(outDir, "runtime/settings"))
  ).sort())
    settings[filename] = createHash("sha256")
      .update(await readFile(path.join(outDir, "runtime/settings", filename)))
      .digest("hex");
  const images = inspectOwnedImages(marker.project);
  await writeFile(
    path.join(destination, "owned-images.json"),
    JSON.stringify(images, null, 2),
  );
  const record = {
    ...plan,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    project: marker.project,
    settings_sha256: settings,
    run_id: report.run_id,
    exit_code: invocation.code,
    command: invocation.command,
    inputs_sha256: before.sha256,
    realm_sha256: createHash("sha256").update(realm).digest("hex"),
    versions: report.versions,
    duration_ms: report.stats?.duration_ms,
    stack_seconds: report.stack.up_seconds,
    verdict: report.verdict,
    infra_error: report.infra_error,
    teardown: report.teardown,
    evidence: destination,
    resource_samples: resources.samples.filter(
      (sample) => sample.containers.length,
    ).length,
    retirement_transitions: resources.samples.filter(
      (sample) => sample.retired_during_sample.length,
    ).length,
  };
  await writeFile(
    path.join(destination, "campaign-run.json"),
    JSON.stringify(record, null, 2),
  );
  if (before.sha256 !== after.sha256)
    throw new Error(`Inputs mudaram durante ${plan.id}`);
  if (invocation.code !== 0)
    throw new Error(
      `Rodada ${plan.id} falhou: ${report.infra_error?.step ?? report.verdict}; prova em ${destination}`,
    );
  assertCampaignRun(report, plan.workers, nativeResults);
  if (
    resources.errors.length ||
    !resources.samples.some((sample) => sample.containers.length)
  )
    throw new Error(`Amostragem incompleta em ${plan.id}`);
  if (!images.length)
    throw new Error(`Imagens próprias não identificadas: ${plan.id}`);
  const retirement = retireOwnedImages(marker.project, images, {
    persist: (receipt) =>
      writeFileSync(
        path.join(destination, "image-retirement.json"),
        JSON.stringify(receipt, null, 2),
      ),
  });
  record.retired_images = retirement.entries.length;
  record.finished_at = new Date().toISOString();
  await writeFile(
    path.join(destination, "campaign-run.json"),
    JSON.stringify(record, null, 2),
  );
  return record;
}
