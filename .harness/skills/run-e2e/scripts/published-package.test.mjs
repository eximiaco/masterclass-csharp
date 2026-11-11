import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { preparePublishedPackage } from "../../../../contexts/core/frontend/e2e/identity/published-package.mjs";
import { prepareControlledRun } from "../../../../contexts/core/frontend/e2e/identity/controller.mjs";

async function namedPublishedFixture(work) {
  const root = await mkdtemp(path.join(tmpdir(), "published-nuget-"));
  const bytes = Buffer.from("named-published-package-fake");
  const relative = "packages/ftc.shared.3.0.9.nupkg";
  const manifest = {
    schema_version: 1,
    origin: "published",
    version: "3.0.9",
    package: {
      path: relative,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
    assembly: { sha256: "a".repeat(64) },
  };
  await mkdir(path.join(root, "packages"));
  await writeFile(path.join(root, relative), bytes);
  const save = () =>
    writeFile(path.join(root, "manifest.json"), JSON.stringify(manifest));
  try {
    await save();
    await work({ root, bytes, manifest, save });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("staging preserva bytes publicados e reutiliza apenas cache idêntico", () =>
  namedPublishedFixture(async ({ root, bytes }) => {
    const first = await preparePublishedPackage(root, "manifest.json");
    assert.equal(first.origin, "published");
    assert.equal(first.version, "3.0.9");
    assert.deepEqual(
      await readFile(path.join(root, first.package.path)),
      bytes,
    );
    assert.deepEqual(
      await preparePublishedPackage(root, "manifest.json"),
      first,
    );
  }));

test("schema, origem local e versão não estável são recusados sem fallback", async () => {
  for (const change of [
    { schema_version: 2 },
    { origin: "local-source" },
    { version: "3.0.9-local.test" },
  ])
    await namedPublishedFixture(async ({ root, manifest, save }) => {
      Object.assign(manifest, change);
      await save();
      await assert.rejects(
        preparePublishedPackage(root, "manifest.json"),
        /schema_version|SemVer/,
      );
    });
});

test("hash divergente e identidade do arquivo inválida bloqueiam artefato", async () => {
  for (const change of [
    { sha256: "b".repeat(64) },
    { path: "packages/other.nupkg" },
  ])
    await namedPublishedFixture(async ({ root, manifest, save }) => {
      Object.assign(manifest.package, change);
      await save();
      await assert.rejects(
        preparePublishedPackage(root, "manifest.json"),
        /Hash|Pacote inválido/,
      );
    });
});

test("escape, manifest com link e nupkg com link são recusados", async () => {
  await namedPublishedFixture(async ({ root, manifest, save }) => {
    await assert.rejects(
      preparePublishedPackage(root, "../manifest.json"),
      /Traversal/,
    );
    await symlink(
      path.join(root, "manifest.json"),
      path.join(root, "manifest-link.json"),
    );
    await assert.rejects(
      preparePublishedPackage(root, "manifest-link.json"),
      /link/,
    );
    const packagePath = path.join(root, manifest.package.path);
    await writeFile(path.join(root, "actual.nupkg"), "bytes");
    await rm(packagePath);
    await symlink(path.join(root, "actual.nupkg"), packagePath);
    await save();
    await assert.rejects(
      preparePublishedPackage(root, "manifest.json"),
      /link/,
    );
  });
});

test("colisão no cache preserva arquivo divergente e falha", () =>
  namedPublishedFixture(async ({ root }) => {
    const first = await preparePublishedPackage(root, "manifest.json");
    const target = path.join(root, first.package.path);
    await writeFile(target, "existing-foreign-bytes");
    await assert.rejects(
      preparePublishedPackage(root, "manifest.json"),
      /Colisão/,
    );
    assert.equal(await readFile(target, "utf8"), "existing-foreign-bytes");
  }));

test("feed com link bloqueia staging sem gravar no destino alheio", () =>
  namedPublishedFixture(async ({ root }) => {
    await mkdir(path.join(root, "outside"));
    await symlink(path.join(root, "outside"), path.join(root, ".harness"));
    await assert.rejects(
      preparePublishedPackage(root, "manifest.json"),
      /Feed controlado/,
    );
  }));

test("reuso exige mesmo artefato published e recusa runtime local", () =>
  namedPublishedFixture(async ({ root, manifest }) => {
    const canonicalRoot = await realpath(root);
    const outDir = path.join(canonicalRoot, "controlled");
    const runtime = path.join(outDir, "runtime");
    await mkdir(runtime, { recursive: true });
    const marker = {
      schema_version: 1,
      owner: "run-e2e-controlled",
      repoRoot: canonicalRoot,
      id: "run-native123",
      project: "ftc-e2e-controlled-run-native123",
      outDir,
      runtime,
    };
    const versions = {
      shared: {
        origin: "local-source",
        version: manifest.version,
        nupkg_sha256: manifest.package.sha256,
        assembly_sha256: manifest.assembly.sha256,
      },
    };
    await writeFile(
      path.join(runtime, "ownership.json"),
      JSON.stringify(marker),
    );
    await writeFile(path.join(runtime, "credentials.json"), "{}");
    const writeVersions = () =>
      writeFile(path.join(runtime, "versions.json"), JSON.stringify(versions));
    await writeVersions();
    const previousRun = process.env.FTC_E2E_CONTROLLED_RUN;
    const previousManifest = process.env.FTC_E2E_SHARED_PACKAGE_MANIFEST;
    process.env.FTC_E2E_CONTROLLED_RUN = runtime;
    process.env.FTC_E2E_SHARED_PACKAGE_MANIFEST = "manifest.json";
    try {
      await assert.rejects(
        prepareControlledRun(root, { noStack: true }),
        /difere/,
      );
      versions.shared.origin = "published";
      await writeVersions();
      const result = await prepareControlledRun(root, { noStack: true });
      assert.deepEqual(result.versions, versions);
    } finally {
      if (previousRun === undefined) delete process.env.FTC_E2E_CONTROLLED_RUN;
      else process.env.FTC_E2E_CONTROLLED_RUN = previousRun;
      if (previousManifest === undefined)
        delete process.env.FTC_E2E_SHARED_PACKAGE_MANIFEST;
      else process.env.FTC_E2E_SHARED_PACKAGE_MANIFEST = previousManifest;
    }
  }));
