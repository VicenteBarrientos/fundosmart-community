import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

async function exists(relativePath) {
  try {
    await access(path.join(root, relativePath));
    return true;
  } catch {
    return false;
  }
}

test("the community snapshot excludes private operations and customer fixtures", async () => {
  const excludedPaths = [
    ".codex",
    "AGENTS.md",
    ".github/workflows/deploy.yml",
    ".github/workflows/monitor.yml",
    "scripts/release/config.mjs",
    "scripts/release/deploy.mjs",
  ];

  for (const relativePath of excludedPaths) {
    assert.equal(await exists(relativePath), false, `${relativePath} must stay outside the public tree`);
  }
});

test("the default Worker configuration is local and installation-owned", async () => {
  const [vite, localD1, envExample, productionExample, deployBlock, preflight] = await Promise.all([
    readFile(path.join(root, "vite.config.ts"), "utf8"),
    readFile(path.join(root, "scripts/development/wrangler.local-d1.jsonc"), "utf8"),
    readFile(path.join(root, ".env.example"), "utf8"),
    readFile(path.join(root, ".env.production.example"), "utf8"),
    readFile(path.join(root, "scripts/release/direct-deploy-blocked.mjs"), "utf8"),
    readFile(path.join(root, "scripts/release/self-hosting-preflight.mjs"), "utf8"),
  ]);
  const configuration = `${vite}\n${localD1}\n${envExample}\n${productionExample}`;

  assert.match(configuration, /fundosmart-community/u);
  assert.doesNotMatch(configuration, /fundosmart-production|prod-fundosmart/iu);
  assert.doesNotMatch(configuration, /database_id\s*[:=]\s*["']?[0-9a-f]{8}-[0-9a-f-]{27,}/iu);
  assert.match(vite, /FUNDOSMART_ENABLE_REMOTE_AI === "true"/u);
  assert.match(vite, /FUNDOSMART_DEPLOY_ENVIRONMENT[\s\S]*\|\| "development"/u);
  assert.match(deployBlock, /Direct deployment is disabled in the community repository/u);
  assert.match(preflight, /DEV_AUTH_EMAIL/u);
  assert.match(preflight, /ASSISTANT_CONFIRMATION_SECRET must be canonical Base64URL/u);
  assert.match(preflight, /workers\.dev and preview URLs/u);
});

test("public project metadata and security links target the community repository", async () => {
  const [packageSource, security, issueConfig] = await Promise.all([
    readFile(path.join(root, "package.json"), "utf8"),
    readFile(path.join(root, "SECURITY.md"), "utf8"),
    readFile(path.join(root, ".github/ISSUE_TEMPLATE/config.yml"), "utf8"),
  ]);
  const metadata = JSON.parse(packageSource);

  assert.equal(metadata.name, "fundosmart-community");
  assert.equal(metadata.license, "AGPL-3.0-only");
  assert.equal(metadata.packageManager, "npm@10.9.3");
  assert.equal(metadata.repository.url, "git+https://github.com/VicenteBarrientos/fundosmart-community.git");
  assert.match(security, /fundosmart-community\/security\/advisories\/new/u);
  assert.match(issueConfig, /fundosmart-community\/security\/advisories\/new/u);
});

test("the locked dependency graph excludes use-restricted source-available licenses", async () => {
  const lock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
  const forbidden = /Hippocratic|Commons Clause|BUSL|SSPL|PolyForm|Prosperity|Elastic License|Fair Source/iu;
  const offenders = Object.entries(lock.packages ?? {})
    .filter(([packagePath, metadata]) => packagePath.startsWith("node_modules/") && forbidden.test(String(metadata.license ?? "")))
    .map(([packagePath, metadata]) => `${packagePath}: ${metadata.license}`);

  assert.deepEqual(offenders, []);
  assert.equal(lock.packages?.["node_modules/react-leaflet"], undefined);
  assert.equal(lock.packages?.["node_modules/@react-leaflet/core"], undefined);
});

test("the checked-in SBOM identifies this repository with a valid CycloneDX serial", async () => {
  const [manifest, sbom] = await Promise.all([
    readFile(path.join(root, "package.json"), "utf8").then(JSON.parse),
    readFile(path.join(root, "sbom.cdx.json"), "utf8").then(JSON.parse),
  ]);
  assert.match(sbom.serialNumber, /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu);
  assert.equal(sbom.metadata?.timestamp, undefined);
  assert.equal(sbom.metadata?.component?.name, "fundosmart-community");
  assert.equal(sbom.metadata?.component?.version, manifest.version);
  assert.equal(sbom.metadata?.component?.purl, `pkg:npm/fundosmart-community@${manifest.version}`);
  assert.equal(
    sbom.metadata?.properties?.find((property) => property.name === "fundosmart:sbom:optional-policy")?.value,
    "full-lockfile",
  );

  const components = new Map(sbom.components.map((component) => [
    component.properties.find((property) => property.name === "cdx:npm:package:path")?.value,
    component,
  ]));
  for (const packagePath of ["node_modules/@turf/jsts", "node_modules/jsts"]) {
    assert.equal(
      components.get(packagePath)?.licenses?.[0]?.license?.name,
      "Eclipse Distribution License 1.0",
      `${packagePath} must retain its upstream EDL license evidence`,
    );
  }
  assert.equal(
    components.get("node_modules/splaytree-ts")?.licenses?.[0]?.license?.id,
    "BSD-3-Clause",
  );
});

test("third-party build notices retain the licenses omitted or misspelled upstream", async () => {
  const notices = await readFile(path.join(root, "THIRD_PARTY_NOTICES.md"), "utf8");
  assert.match(notices, /caniuse-lite@1\.0\.30001793[\s\S]+CC-BY-4\.0/u);
  assert.match(notices, /jsts@2\.7\.1[\s\S]+@turf\/jsts@2\.7\.2[\s\S]+JSTS-EDL-1\.0\.txt/u);
  assert.match(notices, /splaytree-ts@1\.0\.2[\s\S]+BSD-3-Clause/u);
  assert.equal(await exists("third_party_licenses/JSTS-EDL-1.0.txt"), true);
  assert.equal(await exists("third_party_licenses/splaytree-ts-BSD-3-Clause.txt"), true);
});

test("public photography has first-party provenance and excludes the legacy unknown sources", async () => {
  assert.equal(await exists("ASSET_PROVENANCE.md"), true);
  assert.equal(await exists("assets/brand/fundosmart-community-hero-source.png"), true);
  assert.equal(await exists("public/landing/fundosmart-community-hero.webp"), true);
  assert.equal(await exists("public/landing/hero-volcan-osorno-vacas.jpg"), false);
  assert.equal(await exists("public/landing/pastoral-sur-chile.jpg"), false);
});
