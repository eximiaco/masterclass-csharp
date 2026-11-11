import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createCampaignPlan,
  CampaignTargets,
  assertCampaignRun,
  captureCampaignInputs,
  readDockerResourceStats,
  prepareCampaignDirectories,
} from "./lib/permission-campaign.mjs";

function completeReport() {
  return {
    environment: "controlled",
    verdict: "passed",
    teardown: { status: "ok" },
    stats: { workers: 1, expected: 20, unexpected: 0, flaky: 0, skipped: 0 },
    run_errors: [],
    tests: Array.from({ length: 20 }, () => ({ status: "expected" })),
  };
}
function nativeReport() {
  return {
    suites: [
      {
        specs: Array.from({ length: 20 }, () => ({
          tests: [
            { status: "expected", results: [{ status: "passed", retry: 0 }] },
          ],
        })),
      },
    ],
  };
}

test("plano fixa dez ambientes por condição alternada e dois jobs separados", () => {
  const plan = createCampaignPlan();
  assert.equal(plan.comparison.length, 20);
  assert.deepEqual(
    plan.comparison.map((run) => run.workers),
    Array.from({ length: 20 }, (_, i) => (i % 2 ? 3 : 1)),
  );
  assert.equal(plan.concurrent.length, 2);
  assert.equal(
    new Set([...plan.comparison, ...plan.concurrent].map((run) => run.id)).size,
    22,
  );
  assert.equal(CampaignTargets.length, 6);
});
test("report completo passa; retry oculto no reporter nativo reprova", () => {
  assert.doesNotThrow(() =>
    assertCampaignRun(completeReport(), 1, nativeReport()),
  );
  const native = nativeReport();
  native.suites[0].specs[0].tests[0].results[0].retry = 1;
  assert.throws(
    () => assertCampaignRun(completeReport(), 1, native),
    /uma tentativa/,
  );
});
test("skip, flaky, infra, contagem e teardown não aprovam campanha", () => {
  for (const mutate of [
    (r) => {
      r.stats.skipped = 1;
    },
    (r) => {
      r.stats.flaky = 1;
    },
    (r) => {
      r.verdict = "infra-error";
    },
    (r) => {
      r.stats.expected = 19;
    },
    (r) => {
      r.teardown.status = "error";
    },
    (r) => {
      r.stats.workers = 3;
    },
    (r) => {
      r.tests[0].status = "unexpected";
    },
  ]) {
    const report = completeReport();
    mutate(report);
    assert.throws(
      () => assertCampaignRun(report, 1, nativeReport()),
      /Campanha exige/,
    );
  }
});
test("hash detecta mudança de fonte/config, ignora outputs/documentação fora dos inputs", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "permission-campaign-"));
  try {
    execFileSync("git", ["init", "--quiet", root]);
    mkdirSync(path.join(root, "contexts/core/frontend"), { recursive: true });
    writeFileSync(
      path.join(root, "contexts/core/frontend/vite.config.ts"),
      "export default {}",
    );
    const before = await captureCampaignInputs(root);
    writeFileSync(
      path.join(root, "contexts/core/frontend/README.md"),
      "documentação",
    );
    assert.equal((await captureCampaignInputs(root)).sha256, before.sha256);
    writeFileSync(
      path.join(root, "contexts/core/frontend/vite.config.ts"),
      'export default {base:"/"}',
    );
    assert.notEqual((await captureCampaignInputs(root)).sha256, before.sha256);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hash inclui todos os frontends consumidos e configuração raiz de restore", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "campaign-build-inputs-"));
  try {
    execFileSync("git", ["init", "--quiet", root]);
    let previous = (await captureCampaignInputs(root)).sha256;
    for (const name of [
      "contexts/shared/frontend/package-lock.json",
      "contexts/identity/frontend/src/App.tsx",
      "contexts/collect/frontend/vite.config.ts",
      "nuget.config",
      "package-lock.json",
    ]) {
      mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
      writeFileSync(path.join(root, name), "changed-input");
      const current = (await captureCampaignInputs(root)).sha256;
      assert.notEqual(current, previous, name);
      previous = current;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("amostragem distingue teardown próprio de falha Docker inesperada", () => {
  const containers = [{ ID: "abc123" }, { ID: "def456" }];
  const removingContainer = () => {
    throw Object.assign(new Error("docker"), {
      stderr: "Error response from daemon: No such container: abc123",
      stdout:
        '{"Name":"remaining","CPUPerc":"1.2%","MemUsage":"20MiB / 12GiB"}\n',
    });
  };
  const sample = readDockerResourceStats(containers, removingContainer);
  assert.equal(sample.stats.length, 1);
  assert.deepEqual(sample.retired, ["abc123"]);
  const brokenDaemon = () => {
    throw Object.assign(new Error("daemon unavailable"), {
      stderr: "Cannot connect to Docker daemon",
    });
  };
  assert.throws(
    () => readDockerResourceStats(containers, brokenDaemon),
    /daemon unavailable/,
  );
});

test("destinos já existentes ou aninhados são recusados sem sobrescrever prova", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "campaign-paths-"));
  try {
    const out = path.join(root, "runtime");
    const evidence = path.join(root, "evidence");
    await prepareCampaignDirectories(out, evidence);
    writeFileSync(path.join(evidence, "sentinel"), "existing-proof");
    await assert.rejects(prepareCampaignDirectories(out, evidence), /EEXIST/);
    assert.equal(
      readFileSync(path.join(evidence, "sentinel"), "utf8"),
      "existing-proof",
    );
    await assert.rejects(
      prepareCampaignDirectories(out, path.join(out, "evidence")),
      /independentes/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("EOF simples/múltiplo/misto exige retirada comprovada; daemon e streams ativos reprovam", () => {
  const containers = [{ ID: "abc123" }, { ID: "def456" }];
  for (const stderr of [
    "EOF",
    "EOF\nEOF\nEOF",
    "EOF\nError response from daemon: No such container: abc123",
  ]) {
    const exitingContainer = (_program, args) => {
      if (args[0] === "ps") return "def456ffffffff\n";
      throw Object.assign(new Error("stats EOF"), { stderr, stdout: "" });
    };
    const sample = readDockerResourceStats(containers, exitingContainer);
    assert.equal(sample.stats.length, 0);
    assert(sample.retired.includes("abc123"));
    const unexplainedEof = (_program, args) => {
      if (args[0] === "ps") return "abc123ffffffff\ndef456ffffffff\n";
      throw Object.assign(new Error("stats EOF"), { stderr, stdout: "" });
    };
    assert.throws(
      () => readDockerResourceStats(containers, unexplainedEof),
      /stats EOF/,
    );
  }
});
