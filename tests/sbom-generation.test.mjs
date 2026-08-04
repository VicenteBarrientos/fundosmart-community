import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { hashLocalComponentDirectory } from "../scripts/release/generate-sbom.mjs";
import {
  componentPath,
  normalizeSbom,
  serializeSbom,
} from "../scripts/release/sbom-policy.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

test("the checked-in SBOM is a canonical, complete and closed lockfile graph", async () => {
  const [manifestSource, lockfileSource, sbomSource] = await Promise.all([
    source("package.json"),
    source("package-lock.json"),
    source("sbom.cdx.json"),
  ]);
  const manifest = JSON.parse(manifestSource);
  const lockfile = JSON.parse(lockfileSource);
  const sbom = JSON.parse(sbomSource);

  assert.equal(serializeSbom(sbom), sbomSource);
  assert.equal(sbom.bomFormat, "CycloneDX");
  assert.equal(sbom.specVersion, "1.5");
  assert.equal(sbom.version, 1);
  assert.equal(sbom.metadata.timestamp, undefined);
  assert.deepEqual(sbom.metadata.tools, [{ name: "cli", vendor: "npm", version: "10.9.3" }]);
  assert.match(
    sbom.serialNumber,
    /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  );
  assert.equal(sbom.metadata.component.name, manifest.name);
  assert.equal(sbom.metadata.component.version, manifest.version);
  assert.equal(sbom.metadata.component.purl, `pkg:npm/fundosmart-community@${manifest.version}`);

  const metadataProperties = new Map(sbom.metadata.properties.map((property) => [property.name, property.value]));
  assert.equal(metadataProperties.get("fundosmart:sbom:normalizer-version"), "1");
  assert.equal(metadataProperties.get("fundosmart:sbom:optional-policy"), "full-lockfile");
  assert.equal(
    metadataProperties.get("fundosmart:sbom:lockfile-sha256"),
    createHash("sha256").update(lockfileSource, "utf8").digest("hex"),
  );

  const expectedPaths = Object.entries(lockfile.packages)
    .filter(([packagePath, metadata]) => packagePath !== "" && metadata.link !== true)
    .map(([packagePath]) => packagePath)
    .sort(compareOrdinal);
  const actualPaths = sbom.components.map(componentPath).sort(compareOrdinal);
  assert.deepEqual(actualPaths, expectedPaths);

  const componentRefs = sbom.components.map((component) => component["bom-ref"]);
  const expectedRefs = new Set([sbom.metadata.component["bom-ref"], ...componentRefs]);
  assert.equal(new Set(componentRefs).size, componentRefs.length);
  assert.equal(sbom.dependencies.length, expectedRefs.size);
  assert.equal(new Set(sbom.dependencies.map((dependency) => dependency.ref)).size, expectedRefs.size);

  const graph = new Map();
  for (const dependency of sbom.dependencies) {
    assert.equal(expectedRefs.has(dependency.ref), true, dependency.ref);
    assert.equal(new Set(dependency.dependsOn).size, dependency.dependsOn.length, dependency.ref);
    assert.equal(dependency.dependsOn.includes(dependency.ref), false, dependency.ref);
    for (const target of dependency.dependsOn) {
      assert.equal(expectedRefs.has(target), true, `${dependency.ref} -> ${target}`);
    }
    graph.set(dependency.ref, dependency.dependsOn);
  }

  const reached = new Set([sbom.metadata.component["bom-ref"]]);
  const pending = [...reached];
  while (pending.length > 0) {
    for (const target of graph.get(pending.pop()) ?? []) {
      if (!reached.has(target)) {
        reached.add(target);
        pending.push(target);
      }
    }
  }
  assert.equal(reached.size, expectedRefs.size);
});

test("the full lockfile policy includes sharp and every locked platform package", async () => {
  const [manifest, lockfile, sbom, notices] = await Promise.all([
    json("package.json"),
    json("package-lock.json"),
    json("sbom.cdx.json"),
    source("THIRD_PARTY_NOTICES.md"),
  ]);
  const byPath = new Map(sbom.components.map((component) => [componentPath(component), component]));
  const sharp = byPath.get("node_modules/sharp");
  assert.equal(sharp?.version, lockfile.packages["node_modules/sharp"].version);
  assert.equal(manifest.devDependencies.sharp, sharp.version);

  const rootNode = sbom.dependencies.find((dependency) => dependency.ref === sbom.metadata.component["bom-ref"]);
  assert.equal(rootNode.dependsOn.includes(sharp["bom-ref"]), true);

  const expectedImagePaths = Object.keys(lockfile.packages)
    .filter((packagePath) => packagePath.startsWith("node_modules/@img/"))
    .sort(compareOrdinal);
  const actualImagePaths = [...byPath.keys()]
    .filter((packagePath) => packagePath.startsWith("node_modules/@img/"))
    .sort(compareOrdinal);
  assert.deepEqual(actualImagePaths, expectedImagePaths);

  for (const packagePath of expectedImagePaths.filter((packagePath) => packagePath.includes("/sharp-libvips-"))) {
    assert.equal(byPath.get(packagePath).licenses[0].license.id, "LGPL-3.0-or-later");
  }
  for (const packagePath of expectedImagePaths) {
    const declaredLicense = lockfile.packages[packagePath].license;
    const evidence = byPath.get(packagePath).licenses[0];
    if (/\s(?:AND|OR)\s/u.test(declaredLicense)) {
      assert.equal(evidence.expression, declaredLicense, packagePath);
    } else {
      assert.equal(evidence.license.id, declaredLicense, packagePath);
    }
  }

  assert.match(notices, /sharp[\s\S]+Apache-2\.0[\s\S]+libvips[\s\S]+LGPL-3\.0-or-later/u);
  assert.match(notices, /full lockfile inventory/u);
  assert.doesNotMatch(notices, /omits optional packages/u);
});

test("license repairs are exact, retained and fail closed", async () => {
  const [sbom, jstsEvidence, splaytreeEvidence, notices] = await Promise.all([
    json("sbom.cdx.json"),
    source("third_party_licenses/JSTS-EDL-1.0.txt"),
    source("third_party_licenses/splaytree-ts-BSD-3-Clause.txt"),
    source("THIRD_PARTY_NOTICES.md"),
  ]);
  const byPath = new Map(sbom.components.map((component) => [componentPath(component), component]));

  for (const packagePath of ["node_modules/@turf/jsts", "node_modules/jsts"]) {
    assert.deepEqual(byPath.get(packagePath).licenses, [
      {
        license: {
          name: "Eclipse Distribution License 1.0",
          url: "https://raw.githubusercontent.com/bjornharrtell/jsts/2.7.1/LICENSE_EDLv1.txt",
        },
      },
    ]);
  }
  assert.deepEqual(byPath.get("node_modules/splaytree-ts").licenses, [
    { license: { id: "BSD-3-Clause" } },
  ]);
  assert.equal(
    createHash("sha256").update(jstsEvidence, "utf8").digest("hex"),
    "e67a91b5489cd78292d2654f1b587fe68296e28df7c766b9b675614fbdce4fd1",
  );
  assert.equal(
    createHash("sha256").update(splaytreeEvidence, "utf8").digest("hex"),
    "6c46be0e869f8f3f6a47fbf58cedcbb5caace58f2340a1c48cef2b845bf14570",
  );
  assert.match(notices, /\(EDL-1\.0 OR EPL-1\.0\)/u);
  for (const component of sbom.components) {
    assert.equal(Array.isArray(component.licenses) && component.licenses.length > 0, true, componentPath(component));
  }
});

test("the local compatibility adapter has distinct identity and a reproducible source hash", async () => {
  const sbom = await json("sbom.cdx.json");
  const byPath = new Map(sbom.components.map((component) => [componentPath(component), component]));
  const adapter = byPath.get("vendor/brace-expansion-compat");
  const upstream = byPath.get("node_modules/brace-expansion-safe");
  assert.equal(adapter.purl, upstream.purl);
  assert.notEqual(adapter["bom-ref"], upstream["bom-ref"]);
  assert.deepEqual(adapter.hashes, [
    {
      alg: "SHA-256",
      content: await hashLocalComponentDirectory("vendor/brace-expansion-compat"),
    },
  ]);
  assert.equal(
    adapter.properties.some((property) => property.name === "fundosmart:sbom:local-component" && property.value === "true"),
    true,
  );

  const graph = new Map(sbom.dependencies.map((dependency) => [dependency.ref, dependency.dependsOn]));
  assert.equal(graph.get(sbom.metadata.component["bom-ref"]).includes(adapter["bom-ref"]), true);
  assert.equal(graph.get(adapter["bom-ref"]).includes(upstream["bom-ref"]), true);
  assert.equal(graph.get(adapter["bom-ref"]).includes(adapter["bom-ref"]), false);
});

test("normalization removes native entropy and resolves duplicate instances by path", () => {
  const fixture = duplicateFixture();
  const first = normalizeSbom(fixture);
  const secondInput = structuredClone(fixture);
  secondInput.rawSbom.serialNumber = "urn:uuid:ffffffff-ffff-4fff-bfff-ffffffffffff";
  secondInput.rawSbom.metadata.timestamp = "2099-12-31T23:59:59.999Z";
  secondInput.rawSbom.metadata.component.name = "a-different-checkout-directory";
  const second = normalizeSbom(secondInput);

  assert.equal(serializeSbom(first), serializeSbom(second));
  const byPath = new Map(first.components.map((component) => [componentPath(component), component]));
  assert.notEqual(
    byPath.get("node_modules/a/node_modules/x")["bom-ref"],
    byPath.get("node_modules/b/node_modules/x")["bom-ref"],
  );

  const graph = new Map(first.dependencies.map((dependency) => [dependency.ref, dependency.dependsOn]));
  assert.deepEqual(
    graph.get(byPath.get("node_modules/a")["bom-ref"]),
    [byPath.get("node_modules/a/node_modules/x")["bom-ref"]],
  );
  assert.deepEqual(
    graph.get(byPath.get("node_modules/b")["bom-ref"]),
    [byPath.get("node_modules/b/node_modules/x")["bom-ref"]],
  );
  assert.deepEqual(
    graph.get(byPath.get("vendor/shim")["bom-ref"]),
    [byPath.get("node_modules/safe")["bom-ref"]],
  );
});

test("normalization skips absent optional peers but rejects missing required edges and unsafe links", () => {
  const optionalPeerFixture = duplicateFixture();
  optionalPeerFixture.lockfile.packages["node_modules/a"].peerDependencies = { missing: "*" };
  optionalPeerFixture.lockfile.packages["node_modules/a"].peerDependenciesMeta = { missing: { optional: true } };
  assert.doesNotThrow(() => normalizeSbom(optionalPeerFixture));

  const missingFixture = duplicateFixture();
  missingFixture.lockfile.packages["node_modules/a"].dependencies = { missing: "1.0.0" };
  assert.throws(
    () => normalizeSbom(missingFixture),
    /Missing required dependency missing from node_modules\/a/u,
  );

  const unsafeLinkFixture = duplicateFixture();
  unsafeLinkFixture.lockfile.packages["node_modules/shim"].resolved = "../outside";
  assert.throws(
    () => normalizeSbom(unsafeLinkFixture),
    /Package path is not canonical/u,
  );
});

function duplicateFixture() {
  const manifest = {
    name: "fundosmart-community",
    version: "9.9.9",
    description: "Fixture",
    license: "AGPL-3.0-only",
    private: true,
    packageManager: "npm@10.9.3",
    dependencies: {
      a: "1.0.0",
      b: "1.0.0",
      shim: "file:vendor/shim",
    },
  };
  const packages = {
    "": {
      name: manifest.name,
      version: manifest.version,
      license: manifest.license,
      dependencies: { ...manifest.dependencies },
    },
    "node_modules/a": {
      version: "1.0.0",
      license: "MIT",
      inBundle: true,
      dependencies: { x: "1.0.0" },
    },
    "node_modules/a/node_modules/x": {
      version: "1.0.0",
      license: "MIT",
      inBundle: true,
    },
    "node_modules/b": {
      version: "1.0.0",
      license: "MIT",
      inBundle: true,
      dependencies: { x: "1.0.0" },
    },
    "node_modules/b/node_modules/x": {
      version: "1.0.0",
      license: "MIT",
      inBundle: true,
    },
    "node_modules/safe": {
      name: "x",
      version: "1.0.0",
      license: "MIT",
      inBundle: true,
    },
    "node_modules/shim": {
      resolved: "vendor/shim",
      link: true,
    },
    "vendor/shim": {
      name: "shim",
      version: "1.0.0",
      license: "MIT",
      dependencies: { safe: "npm:x@1.0.0" },
    },
  };
  const rawComponents = [
    rawComponent("node_modules/a", "a", "pkg:npm/a@1.0.0"),
    rawComponent("node_modules/a/node_modules/x", "x", "pkg:npm/x@1.0.0"),
    rawComponent("node_modules/b", "b", "pkg:npm/b@1.0.0"),
    rawComponent("node_modules/b/node_modules/x", "x", "pkg:npm/x@1.0.0"),
    rawComponent("node_modules/safe", "safe", "pkg:npm/x@1.0.0"),
    rawComponent("vendor/shim", "shim-target", "pkg:npm/x@1.0.0"),
  ];
  const rawSbom = {
    $schema: "http://cyclonedx.org/schema/bom-1.5.schema.json",
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    serialNumber: "urn:uuid:00000000-0000-4000-8000-000000000000",
    version: 1,
    metadata: {
      timestamp: "2000-01-01T00:00:00.000Z",
      lifecycles: [{ phase: "pre-build" }],
      tools: [{ vendor: "npm", name: "cli", version: "10.9.3" }],
      component: {
        "bom-ref": "checkout-name@9.9.9",
        type: "application",
        name: "checkout-name",
        version: manifest.version,
        purl: "pkg:npm/fundosmart-community@9.9.9",
      },
    },
    components: rawComponents,
    dependencies: [
      { ref: "root", dependsOn: ["a", "b", "shim"] },
      { ref: "a", dependsOn: ["x"] },
      { ref: "b", dependsOn: ["x"] },
      { ref: "shim", dependsOn: ["x"] },
      { ref: "x", dependsOn: [] },
      { ref: "x", dependsOn: [] },
      { ref: "x", dependsOn: [] },
    ],
  };
  return {
    rawSbom,
    manifest,
    lockfile: {
      name: manifest.name,
      version: manifest.version,
      lockfileVersion: 3,
      packages,
    },
    lockfileSha256: "0".repeat(64),
    localComponentHashes: new Map([["vendor/shim", "a".repeat(64)]]),
  };
}

function rawComponent(packagePath, name, purl) {
  return {
    "bom-ref": `${name}@1.0.0`,
    type: "library",
    name,
    version: "1.0.0",
    scope: "required",
    purl,
    properties: [
      { name: "cdx:npm:package:path", value: packagePath },
      ...(packagePath.startsWith("node_modules/")
        ? [{ name: "cdx:npm:package:bundled", value: "true" }]
        : []),
    ],
    externalReferences: [],
    licenses: [{ license: { id: "MIT" } }],
  };
}

function source(relativePath) {
  return readFile(path.join(root, relativePath), "utf8");
}

async function json(relativePath) {
  return JSON.parse(await source(relativePath));
}

function compareOrdinal(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
