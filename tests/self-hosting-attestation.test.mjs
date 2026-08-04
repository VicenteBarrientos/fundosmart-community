import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  SELF_HOSTING_ATTESTATION_SCHEMA,
  SelfHostingAttestationError,
  createDistSnapshot,
  createSelfHostingAttestation,
  digestDistTree,
  readSelfHostingAttestation,
  removeDistSnapshot,
  verifySelfHostingAttestation,
  verifyGitTrackedTree,
  writeSelfHostingAttestation,
} from "../scripts/release/self-hosting-attestation.mjs";

const execFileAsync = promisify(execFile);

test("round-trips an exact environment attestation and a complete disposable dist snapshot", async () => {
  const fixture = await createFixture("roundtrip");
  let snapshot;
  try {
    const attestation = await createSelfHostingAttestation({
      releaseSha: fixture.releaseSha,
      environment: "production",
      envFile: fixture.envFile,
      secretsFile: fixture.secretsFile,
      distPath: fixture.distPath,
      configRelativePath: "server/wrangler.json",
      ...migrationInputs(fixture),
    });
    assert.equal(attestation.schema, SELF_HOSTING_ATTESTATION_SCHEMA);
    assert.equal(attestation.releaseSha, fixture.releaseSha);
    assert.equal(attestation.environment, "production");
    assert.equal(attestation.fileCount, 3);
    assert.equal(attestation.migrationsFileCount, 2);
    assert.equal(attestation.migrationsRelativePath, "drizzle");
    assert.match(attestation.envSha256, /^[0-9a-f]{64}$/u);
    assert.match(attestation.secretsSha256, /^[0-9a-f]{64}$/u);
    assert.match(attestation.artifactSha256, /^[0-9a-f]{64}$/u);
    assert.match(attestation.migrationsSha256, /^[0-9a-f]{64}$/u);

    const [envBytes, secretsBytes] = await Promise.all([
      readFile(fixture.envFile),
      readFile(fixture.secretsFile),
    ]);
    assert.deepEqual(await createSelfHostingAttestation({
      releaseSha: fixture.releaseSha,
      environment: "production",
      envBytes,
      secretsBytes,
      distPath: fixture.distPath,
      ...migrationInputs(fixture),
    }), attestation);

    const outputPath = path.join(fixture.rootPath, ".wrangler", "production.attestation.json");
    await writeSelfHostingAttestation({ attestation, outputPath });
    await writeSelfHostingAttestation({ attestation, outputPath });
    assert.deepEqual(await readSelfHostingAttestation({ attestationPath: outputPath }), attestation);
    const rejectedOutputPath = path.join(fixture.rootPath, ".wrangler", "occupied");
    await mkdir(rejectedOutputPath);
    await assert.rejects(
      writeSelfHostingAttestation({ attestation, outputPath: rejectedOutputPath }),
      /Could not atomically write/u,
    );
    assert.equal((await lstat(rejectedOutputPath)).isDirectory(), true);
    assert.deepEqual(await verifySelfHostingAttestation({
      attestationPath: outputPath,
      releaseSha: fixture.releaseSha,
      environment: "production",
      envBytes,
      secretsBytes,
      distPath: fixture.distPath,
      ...migrationInputs(fixture),
    }), attestation);
    assert.deepEqual(await verifySelfHostingAttestation({
      attestationPath: outputPath,
      releaseSha: fixture.releaseSha,
      environment: "production",
      envFile: fixture.envFile,
      distPath: fixture.distPath,
      ...migrationInputs(fixture),
    }), attestation);
    if (process.platform !== "win32") {
      assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
    }

    snapshot = await createDistSnapshot({
      distPath: fixture.distPath,
      temporaryParent: fixture.rootPath,
    });
    assert.equal(snapshot.artifactSha256, attestation.artifactSha256);
    assert.equal(snapshot.fileCount, attestation.fileCount);
    assert.equal((await stat(path.join(snapshot.distPath, "empty", "nested"))).isDirectory(), true);
    assert.deepEqual(
      await readFile(path.join(snapshot.distPath, "assets", "payload.bin")),
      Buffer.from([0, 255, 1, 128, 10]),
    );
    assert.deepEqual(await verifySelfHostingAttestation({
      attestation,
      releaseSha: fixture.releaseSha,
      environment: "production",
      envFile: fixture.envFile,
      secretsFile: fixture.secretsFile,
      distPath: snapshot.distPath,
      ...migrationInputs(fixture),
    }), attestation);

    await removeDistSnapshot(snapshot);
    await assert.rejects(lstat(snapshot.rootPath), { code: "ENOENT" });
    await assert.rejects(
      removeDistSnapshot(snapshot),
      (error) => error instanceof SelfHostingAttestationError && /not an active dist snapshot/u.test(error.message),
    );
    snapshot = undefined;
  } finally {
    if (snapshot) await removeDistSnapshot(snapshot).catch(() => undefined);
    await rm(fixture.rootPath, { recursive: true, force: true });
  }
});

test("the artifact digest is independent of creation order and binds normalized paths as well as bytes", async () => {
  const left = await mkdtemp(path.join(tmpdir(), "fundosmart-attestation-left-"));
  const right = await mkdtemp(path.join(tmpdir(), "fundosmart-attestation-right-"));
  try {
    await writeTree(left, [
      ["z-last.txt", "same-z"],
      ["nested/a-first.txt", "same-a"],
    ]);
    await writeTree(right, [
      ["nested/a-first.txt", "same-a"],
      ["z-last.txt", "same-z"],
    ]);
    const leftDigest = await digestDistTree({ distPath: left });
    const rightDigest = await digestDistTree({ distPath: right });
    assert.deepEqual(leftDigest, rightDigest);

    await rm(path.join(right, "z-last.txt"));
    await writeFile(path.join(right, "renamed.txt"), "same-z");
    assert.notEqual(
      (await digestDistTree({ distPath: right })).artifactSha256,
      leftDigest.artifactSha256,
    );
  } finally {
    await Promise.all([
      rm(left, { recursive: true, force: true }),
      rm(right, { recursive: true, force: true }),
    ]);
  }
});

test("the migration digest is identical for the checkout and a complete snapshot of its Git tree", async () => {
  const fixture = await createFixture("git-snapshot");
  let snapshot;
  try {
    const original = await verifyGitTrackedTree({
      gitCwd: fixture.rootPath,
      treePath: fixture.migrationsPath,
      gitRelativePath: "drizzle",
      releaseSha: fixture.releaseSha,
    });
    snapshot = await createDistSnapshot({
      distPath: fixture.migrationsPath,
      temporaryParent: fixture.rootPath,
    });
    const copied = await verifyGitTrackedTree({
      gitCwd: fixture.rootPath,
      treePath: snapshot.distPath,
      gitRelativePath: "drizzle",
      releaseSha: fixture.releaseSha,
    });
    assert.deepEqual(copied, original);
    assert.equal(original.fileCount, 2);
    assert.match(original.treeSha256, /^[0-9a-f]{64}$/u);
  } finally {
    if (snapshot) await removeDistSnapshot(snapshot).catch(() => undefined);
    await rm(fixture.rootPath, { recursive: true, force: true });
  }
});

test("Git verification rejects an ignored extra migration even when status reports a clean tree", async () => {
  const fixture = await createFixture("git-ignored-extra");
  try {
    const excludeOutput = await runGit(fixture.rootPath, ["rev-parse", "--git-path", "info/exclude"]);
    const excludePath = path.resolve(fixture.rootPath, excludeOutput.trim());
    await writeFile(excludePath, "drizzle/9999_ignored.sql\n", { flag: "a" });
    await writeFile(path.join(fixture.migrationsPath, "9999_ignored.sql"), "DROP TABLE test;\n");
    assert.equal(
      await runGit(fixture.rootPath, ["status", "--porcelain=v1", "--untracked-files=all", "--", "drizzle"]),
      "",
    );
    await assert.rejects(
      verifyGitTrackedTree({
        gitCwd: fixture.rootPath,
        treePath: fixture.migrationsPath,
        gitRelativePath: "drizzle",
        releaseSha: fixture.releaseSha,
      }),
      (error) => error instanceof SelfHostingAttestationError && /extra: 9999_ignored\.sql/u.test(error.message),
    );
  } finally {
    await rm(fixture.rootPath, { recursive: true, force: true });
  }
});

test("Git verification rejects skip-worktree byte changes and missing tracked migrations", async () => {
  const modifiedFixture = await createFixture("git-skip-worktree");
  const missingFixture = await createFixture("git-missing");
  try {
    await runGit(modifiedFixture.rootPath, ["update-index", "--skip-worktree", "drizzle/0000_test.sql"]);
    await writeFile(
      path.join(modifiedFixture.migrationsPath, "0000_test.sql"),
      "DROP TABLE test;\n",
    );
    assert.equal(
      await runGit(modifiedFixture.rootPath, ["status", "--porcelain=v1", "--", "drizzle"]),
      "",
    );
    await assert.rejects(
      verifyGitTrackedTree({
        gitCwd: modifiedFixture.rootPath,
        treePath: modifiedFixture.migrationsPath,
        gitRelativePath: "drizzle",
        releaseSha: modifiedFixture.releaseSha,
      }),
      (error) => error instanceof SelfHostingAttestationError && /does not match its blob/u.test(error.message),
    );

    await rm(path.join(missingFixture.migrationsPath, "meta", "journal.json"));
    await assert.rejects(
      verifyGitTrackedTree({
        gitCwd: missingFixture.rootPath,
        treePath: missingFixture.migrationsPath,
        gitRelativePath: "drizzle",
        releaseSha: missingFixture.releaseSha,
      }),
      (error) => error instanceof SelfHostingAttestationError && /missing: meta\/journal\.json/u.test(error.message),
    );
  } finally {
    await Promise.all([
      rm(modifiedFixture.rootPath, { recursive: true, force: true }),
      rm(missingFixture.rootPath, { recursive: true, force: true }),
    ]);
  }
});

test("verification fails closed after artifact or environment mutation and omits an unrequested secrets digest", async () => {
  const fixture = await createFixture("mutation");
  try {
    const attestation = await createSelfHostingAttestation({
      releaseSha: fixture.releaseSha,
      environment: "staging",
      envFile: fixture.envFile,
      distPath: fixture.distPath,
      ...migrationInputs(fixture),
    });
    assert.equal(Object.hasOwn(attestation, "secretsSha256"), false);

    const assetPath = path.join(fixture.distPath, "assets", "app.js");
    await writeFile(assetPath, "export const ready = false;\n");
    await assert.rejects(
      verifySelfHostingAttestation({
        attestation,
        releaseSha: fixture.releaseSha,
        environment: "staging",
        envFile: fixture.envFile,
        distPath: fixture.distPath,
        ...migrationInputs(fixture),
      }),
      (error) => error instanceof SelfHostingAttestationError && /artifactSha256 does not match/u.test(error.message),
    );

    await writeFile(assetPath, "export const ready = true;\n");
    await writeFile(fixture.envFile, "FUNDOSMART_DEPLOY_ENVIRONMENT=production\nFUNDOSMART_WORKER_NAME=mutated\n");
    await assert.rejects(
      verifySelfHostingAttestation({
        attestation,
        releaseSha: fixture.releaseSha,
        environment: "staging",
        envFile: fixture.envFile,
        distPath: fixture.distPath,
        ...migrationInputs(fixture),
      }),
      (error) => error instanceof SelfHostingAttestationError && /envSha256 does not match/u.test(error.message),
    );
  } finally {
    await rm(fixture.rootPath, { recursive: true, force: true });
  }
});

test("reading rejects non-canonical or schema-expanded JSON", async () => {
  const fixture = await createFixture("strict-json");
  try {
    const attestation = await createSelfHostingAttestation({
      releaseSha: fixture.releaseSha,
      environment: "production",
      envFile: fixture.envFile,
      distPath: fixture.distPath,
      ...migrationInputs(fixture),
    });
    const outputPath = path.join(fixture.rootPath, "attestation.json");
    await writeSelfHostingAttestation({ attestation, outputPath });

    await writeFile(outputPath, `${JSON.stringify({ ...attestation, extra: true }, null, 2)}\n`);
    await assert.rejects(
      readSelfHostingAttestation({ attestationPath: outputPath }),
      (error) => error instanceof SelfHostingAttestationError && /fields do not exactly match/u.test(error.message),
    );

    const reordered = {
      environment: attestation.environment,
      schema: attestation.schema,
      releaseSha: attestation.releaseSha,
      envSha256: attestation.envSha256,
      artifactSha256: attestation.artifactSha256,
      fileCount: attestation.fileCount,
      configRelativePath: attestation.configRelativePath,
      migrationsSha256: attestation.migrationsSha256,
      migrationsFileCount: attestation.migrationsFileCount,
      migrationsRelativePath: attestation.migrationsRelativePath,
    };
    await writeFile(outputPath, `${JSON.stringify(reordered, null, 2)}\n`);
    await assert.rejects(
      readSelfHostingAttestation({ attestationPath: outputPath }),
      (error) => error instanceof SelfHostingAttestationError && /not in canonical JSON form/u.test(error.message),
    );
  } finally {
    await rm(fixture.rootPath, { recursive: true, force: true });
  }
});

test("rejects traversal, absolute config paths and symbolic links in the dist tree", async (context) => {
  const fixture = await createFixture("unsafe-paths");
  try {
    for (const configRelativePath of ["server/../wrangler.json", "../wrangler.json", path.resolve("outside.json")]) {
      await assert.rejects(
        createSelfHostingAttestation({
          releaseSha: fixture.releaseSha,
          environment: "production",
          envFile: fixture.envFile,
          distPath: fixture.distPath,
          configRelativePath,
          ...migrationInputs(fixture),
        }),
        (error) => error instanceof SelfHostingAttestationError && /relative path|path segments|must not be absolute/u.test(error.message),
      );
    }

    const outsidePath = path.join(fixture.rootPath, "outside-directory");
    const linkPath = path.join(fixture.distPath, "assets", "linked-directory");
    await mkdir(outsidePath);
    await writeFile(path.join(outsidePath, "outside.txt"), "outside bytes");
    try {
      await symlink(outsidePath, linkPath, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (error?.code === "EPERM" || error?.code === "EACCES") {
        context.skip("This Windows host does not grant symbolic-link creation privileges.");
        return;
      }
      throw error;
    }
    await assert.rejects(
      digestDistTree({ distPath: fixture.distPath }),
      (error) => error instanceof SelfHostingAttestationError && /symbolic link/u.test(error.message),
    );
    await assert.rejects(
      createDistSnapshot({ distPath: fixture.distPath, temporaryParent: fixture.rootPath }),
      (error) => error instanceof SelfHostingAttestationError && /symbolic link/u.test(error.message),
    );
  } finally {
    await rm(fixture.rootPath, { recursive: true, force: true });
  }
});

async function createFixture(label) {
  const rootPath = await mkdtemp(path.join(tmpdir(), `fundosmart-attestation-${label}-`));
  const distPath = path.join(rootPath, "dist");
  const migrationsPath = path.join(rootPath, "drizzle");
  const envFile = path.join(rootPath, "deployment.env");
  const secretsFile = path.join(rootPath, "secrets.env");
  await Promise.all([
    writeTree(distPath, [
      ["server/wrangler.json", '{"name":"community-production"}\n'],
      ["assets/app.js", "export const ready = true;\n"],
      ["assets/payload.bin", Buffer.from([0, 255, 1, 128, 10])],
    ]),
    writeTree(migrationsPath, [
      ["0000_test.sql", "CREATE TABLE test (id INTEGER PRIMARY KEY);\n"],
      ["meta/journal.json", '{"version":"1"}\n'],
    ]),
    writeFile(envFile, "FUNDOSMART_DEPLOY_ENVIRONMENT=production\n"),
    writeFile(secretsFile, "OFFLINE_SESSION_SECRET=private-value\n", { mode: 0o600 }),
  ]);
  await mkdir(path.join(distPath, "empty", "nested"), { recursive: true });
  const releaseSha = await initializeGitFixture(rootPath);
  return { rootPath, distPath, migrationsPath, envFile, secretsFile, releaseSha };
}

function migrationInputs(fixture) {
  return {
    migrationsPath: fixture.migrationsPath,
    gitCwd: fixture.rootPath,
    migrationsRelativePath: "drizzle",
  };
}

async function initializeGitFixture(rootPath) {
  await runGit(rootPath, ["init", "--quiet"]);
  await runGit(rootPath, ["add", "--", "drizzle"]);
  await runGit(rootPath, [
    "-c",
    "user.name=FundoSmart tests",
    "-c",
    "user.email=tests@fundosmart.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  ]);
  return (await runGit(rootPath, ["rev-parse", "HEAD"])).trim();
}

async function runGit(cwd, argumentsList) {
  const { stdout } = await execFileAsync("git", argumentsList, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  return stdout;
}

async function writeTree(rootPath, entries) {
  for (const [relativePath, contents] of entries) {
    const filePath = path.join(rootPath, ...relativePath.split("/"));
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, contents);
  }
}
