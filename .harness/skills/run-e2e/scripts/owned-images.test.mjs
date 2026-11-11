import test from "node:test";
import assert from "node:assert/strict";
import { inspectOwnedImages, retireOwnedImages } from "./lib/owned-images.mjs";

const Project = "ftc-e2e-controlled-run-owned123";
const Tag = `${Project}-core-api:latest`;
const Inventory = [
  { tag: Tag, id: "sha256:owned", project: Project, layers: ["sha256:layer"] },
];
function namedDockerFake({
  owner = Project,
  id = "sha256:owned",
  used = false,
} = {}) {
  const calls = [];
  let removed = false;
  const invoke = (_program, args) => {
    calls.push(args);
    if (args[0] === "image" && args[1] === "ls") {
      if (args.includes("--filter"))
        return removed
          ? ""
          : JSON.stringify({
              Repository: `${Project}-core-api`,
              Tag: "latest",
            });
      return [
        JSON.stringify({ Repository: `${Project}-core-api`, Tag: "latest" }),
        JSON.stringify({ Repository: "foreign-image", Tag: "latest" }),
      ].join("\n");
    }
    if (args[0] === "image" && args[1] === "inspect")
      return JSON.stringify({
        Id: id,
        Config: { Labels: { "com.docker.compose.project": owner } },
        RootFS: { Layers: ["sha256:layer"] },
      });
    if (args[0] === "ps") return used ? "existing-container" : "";
    if (args[0] === "inspect") return "sha256:owned";
    if (args[0] === "image" && args[1] === "rm") {
      removed = true;
      return "Untagged";
    }
    throw new Error(`Chamada Docker inesperada: ${args.join(" ")}`);
  };
  return { invoke, calls };
}
test("inventário exige prefixo e label próprios; imagem alheia preservada", () => {
  const docker = namedDockerFake();
  assert.deepEqual(inspectOwnedImages(Project, docker.invoke), Inventory);
  assert.equal(docker.calls.filter((args) => args[1] === "inspect").length, 1);
});
test("retirada exata persiste intenção/removing/removed sem force, volumes ou prune", () => {
  const docker = namedDockerFake();
  const states = [];
  const receipt = retireOwnedImages(Project, Inventory, {
    invoke: docker.invoke,
    persist: (value) => states.push(structuredClone(value)),
  });
  assert.equal(receipt.entries[0].status, "removed");
  assert.deepEqual(
    states.slice(0, 3).map((state) => state.entries[0].status),
    ["planned", "removing", "removed"],
  );
  assert.deepEqual(
    docker.calls.filter((args) => args[1] === "rm"),
    [["image", "rm", Tag]],
  );
  assert(
    !docker.calls
      .flat()
      .some((arg) => ["--force", "prune", "volume"].includes(arg)),
  );
});
test("label divergente, hash alterado e container existente impedem retirada", () => {
  for (const options of [
    { owner: "foreign-project" },
    { id: "sha256:changed" },
    { used: true },
  ]) {
    const docker = namedDockerFake(options);
    assert.throws(
      () => retireOwnedImages(Project, Inventory, { invoke: docker.invoke }),
      /Ownership|alterada|usada/,
    );
    assert.equal(docker.calls.filter((args) => args[1] === "rm").length, 0);
  }
});
