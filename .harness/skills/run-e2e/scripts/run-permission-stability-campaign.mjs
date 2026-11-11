#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  CampaignTargets,
  createCampaignPlan,
  captureCampaignInputs,
  executeCampaignRun,
  prepareCampaignDirectories,
} from "./lib/permission-campaign.mjs";

const options = {};
for (let index = 2; index < process.argv.length; index += 1) {
  const option = process.argv[index];
  if (option === "--dry-run") options.dryRun = true;
  else if (["--out", "--evidence"].includes(option) && process.argv[index + 1])
    options[option.slice(2)] = process.argv[++index];
  else
    throw new Error(
      `Opção inválida: ${option}; esperado --out/--evidence/--dry-run`,
    );
}
if (process.env.FTC_E2E_ENVIRONMENT !== "controlled")
  throw new Error("Campanha exige FTC_E2E_ENVIRONMENT=controlled");
const plan = createCampaignPlan();
if (options.dryRun) {
  process.stdout.write(
    JSON.stringify(
      {
        plan,
        targets: CampaignTargets,
        retries: 0,
        trace: "on",
        fresh_environment: true,
      },
      null,
      2,
    ) + "\n",
  );
  process.exit(0);
}
const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();
const repoRoot = path.dirname(
  execFileSync(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    { encoding: "utf8" },
  ).trim(),
);
const id = `permission-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
const outRoot = path.resolve(
  options.out || path.join(root, ".harness/workspace/e2e-campaigns", id),
);
const evidenceRoot = path.resolve(
  options.evidence ||
    path.join(
      repoRoot,
      ".harness/audits/test-strategy/e2e-permission-stability/campaigns",
      id,
    ),
);
await prepareCampaignDirectories(outRoot, evidenceRoot);
const inputs = await captureCampaignInputs(root);
const liveChildren = new Set();
let interrupted = false;
const interrupt = () => {
  interrupted = true;
  for (const child of liveChildren) child.kill("SIGTERM");
};
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
const summary = {
  id,
  status: "running",
  execution_order: ["concurrent", "comparison"],
  inputs_sha256: inputs.sha256,
  head: execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim(),
  comparison: [],
  concurrent: [],
  errors: [],
  out_root: outRoot,
  evidence_root: evidenceRoot,
};
const context = { root, outRoot, evidenceRoot, inputs, liveChildren, repoRoot };
await writeFile(
  path.join(evidenceRoot, "inputs.json"),
  JSON.stringify(inputs, null, 2),
);
await writeFile(
  path.join(outRoot, "ownership.json"),
  JSON.stringify(
    {
      owner: "permission-stability-campaign",
      id,
      root,
      outRoot,
      evidenceRoot,
      plan,
    },
    null,
    2,
  ),
);
async function saveProgress() {
  await writeFile(
    path.join(evidenceRoot, "campaign.json"),
    JSON.stringify(summary, null, 2),
  );
  process.stdout.write(
    JSON.stringify({
      status: summary.status,
      comparison: summary.comparison.length,
      concurrent: summary.concurrent.length,
      errors: summary.errors,
    }) + "\n",
  );
}
try {
  // Validar pressão concorrente antes da comparação longa, preservando ambos os grupos completos.
  if (interrupted)
    throw new Error("Campanha interrompida antes da prova concorrente");
  const simultaneous = await Promise.allSettled(
    plan.concurrent.map((run) => executeCampaignRun(context, run)),
  );
  for (const result of simultaneous) {
    if (result.status === "fulfilled") summary.concurrent.push(result.value);
    else summary.errors.push(result.reason.message);
  }
  if (summary.errors.length)
    throw new Error("Prova concorrente reprovada; todos os filhos aguardados");
  const [first, second] = summary.concurrent;
  if (
    first.run_id === second.run_id ||
    first.project === second.project ||
    Math.max(Date.parse(first.started_at), Date.parse(second.started_at)) >=
      Math.min(Date.parse(first.finished_at), Date.parse(second.finished_at))
  )
    throw new Error(
      "Jobs não demonstraram IDs/projetos distintos e sobreposição temporal",
    );
  await saveProgress();
  for (const run of plan.comparison) {
    if (interrupted)
      throw new Error(
        "Campanha interrompida; nenhum novo ambiente será iniciado",
      );
    summary.comparison.push(await executeCampaignRun(context, run));
    await saveProgress();
  }
  for (const run of [...summary.comparison, ...summary.concurrent]) {
    const remaining = execFileSync(
      "docker",
      [
        "ps",
        "-aq",
        "--filter",
        `label=com.docker.compose.project=${run.project}`,
      ],
      { encoding: "utf8" },
    ).trim();
    if (remaining) throw new Error(`Recursos ainda ativos em ${run.id}`);
  }
  summary.status = "passed";
} catch (error) {
  summary.status = "failed";
  summary.errors.push(error.message);
} finally {
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
  await saveProgress();
}
process.exitCode = summary.status === "passed" ? 0 : 1;
