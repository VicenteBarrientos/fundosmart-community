import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { createSelfHostingSecrets } from "../scripts/release/create-self-hosting-secrets.mjs";
import { readStrictDotEnvFile } from "../scripts/release/self-hosting-env-files.mjs";

const execFileAsync = promisify(execFile);

test("creates independent secrets only as a regular ignored file directly under .wrangler", async () => {
  const fixture = await createRepositoryFixture({ ignoreWrangler: true });
  let call = 0;
  const outputPath = path.join(fixture.rootPath, ".wrangler", "community.production.secrets.env");
  try {
    assert.deepEqual(await createSelfHostingSecrets({
      cwd: fixture.rootPath,
      outputPath,
      randomBytesImpl: (length) => Buffer.alloc(length, ++call),
    }), { outputPath });

    const [wranglerStats, outputStats, loaded] = await Promise.all([
      lstat(path.dirname(outputPath)),
      lstat(outputPath),
      readStrictDotEnvFile(outputPath, { label: "generated secrets file" }),
    ]);
    assert.equal(wranglerStats.isDirectory(), true);
    assert.equal(wranglerStats.isSymbolicLink(), false);
    assert.equal(outputStats.isFile(), true);
    assert.equal(outputStats.isSymbolicLink(), false);
    const generated = [
      loaded.values.OFFLINE_SESSION_SECRET,
      loaded.values.ASSISTANT_CONFIRMATION_SECRET,
      loaded.values.AI_KEYS_ENCRYPTION_SECRET,
    ];
    assert.equal(new Set(generated).size, 3);
    for (const value of generated) assert.equal(Buffer.from(value, "base64url").byteLength, 32);
    assert.equal(Object.hasOwn(loaded.values, "CDSE_CLIENT_ID"), false);
    assert.equal(Object.hasOwn(loaded.values, "CDSE_CLIENT_SECRET"), false);
    assert.equal(await gitSucceeds(fixture.rootPath, ["check-ignore", "--quiet", "--", outputPath]), true);

    await assert.rejects(
      createSelfHostingSecrets({ cwd: fixture.rootPath, outputPath }),
      /Refusing to overwrite/u,
    );
  } finally {
    await rm(fixture.rootPath, { recursive: true, force: true });
  }
});

test("rejects outputs outside, nested below or not ignored by the repository", async () => {
  const fixture = await createRepositoryFixture({ ignoreWrangler: true });
  const unprotected = await createRepositoryFixture({ ignoreWrangler: false });
  try {
    await assert.rejects(
      createSelfHostingSecrets({
        cwd: fixture.rootPath,
        outputPath: path.join(fixture.rootPath, "community.production.secrets.env"),
      }),
      /direct .* inside .*\.wrangler/u,
    );
    await assert.rejects(
      createSelfHostingSecrets({
        cwd: fixture.rootPath,
        outputPath: path.join(fixture.rootPath, ".wrangler", "nested", "community.production.secrets.env"),
      }),
      /direct .* inside .*\.wrangler/u,
    );
    await assert.rejects(
      createSelfHostingSecrets({
        cwd: unprotected.rootPath,
        outputPath: path.join(unprotected.rootPath, ".wrangler", "community.production.secrets.env"),
      }),
      /not guaranteed to be ignored/u,
    );
  } finally {
    await Promise.all([
      rm(fixture.rootPath, { recursive: true, force: true }),
      rm(unprotected.rootPath, { recursive: true, force: true }),
    ]);
  }
});

test("rejects a tracked output and a linked .wrangler directory", async () => {
  const trackedFixture = await createRepositoryFixture({ ignoreWrangler: true });
  const linkedFixture = await createRepositoryFixture({ ignoreWrangler: true });
  const linkedTarget = await mkdtemp(path.join(tmpdir(), "fundosmart-linked-wrangler-target-"));
  try {
    const trackedPath = path.join(trackedFixture.rootPath, ".wrangler", "community.production.secrets.env");
    await mkdir(path.dirname(trackedPath));
    await writeFile(trackedPath, "tracked placeholder\n");
    await runGit(trackedFixture.rootPath, ["add", "--force", "--", trackedPath]);
    await runGit(trackedFixture.rootPath, ["commit", "--quiet", "-m", "tracked unsafe path"]);
    await assert.rejects(
      createSelfHostingSecrets({ cwd: trackedFixture.rootPath, outputPath: trackedPath }),
      /tracked by Git/u,
    );

    const linkedPath = path.join(linkedFixture.rootPath, ".wrangler");
    await symlink(linkedTarget, linkedPath, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(
      createSelfHostingSecrets({
        cwd: linkedFixture.rootPath,
        outputPath: path.join(linkedPath, "community.production.secrets.env"),
      }),
      /must be a real directory/u,
    );
  } finally {
    await Promise.all([
      rm(trackedFixture.rootPath, { recursive: true, force: true }),
      rm(linkedFixture.rootPath, { recursive: true, force: true }),
      rm(linkedTarget, { recursive: true, force: true }),
    ]);
  }
});

test("rejects weak or duplicate random-source output without creating a secrets file", async () => {
  const fixture = await createRepositoryFixture({ ignoreWrangler: true });
  const outputPath = path.join(fixture.rootPath, ".wrangler", "community.production.secrets.env");
  try {
    await assert.rejects(
      createSelfHostingSecrets({
        cwd: fixture.rootPath,
        outputPath,
        randomBytesImpl: () => Buffer.alloc(31),
      }),
      /exactly 32 random bytes/u,
    );
    await assert.rejects(
      createSelfHostingSecrets({
        cwd: fixture.rootPath,
        outputPath,
        randomBytesImpl: (length) => Buffer.alloc(length, 7),
      }),
      /duplicate secrets/u,
    );
    await assert.rejects(lstat(outputPath), { code: "ENOENT" });
  } finally {
    await rm(fixture.rootPath, { recursive: true, force: true });
  }
});

async function createRepositoryFixture({ ignoreWrangler }) {
  const rootPath = await mkdtemp(path.join(tmpdir(), "fundosmart-secrets-fixture-"));
  await writeFile(path.join(rootPath, ".gitignore"), ignoreWrangler ? "/.wrangler/\n" : "# no secrets ignore\n");
  await runGit(rootPath, ["init", "--quiet"]);
  await runGit(rootPath, ["config", "user.name", "FundoSmart tests"]);
  await runGit(rootPath, ["config", "user.email", "tests@fundosmart.invalid"]);
  await runGit(rootPath, ["config", "commit.gpgsign", "false"]);
  await runGit(rootPath, ["add", "--", ".gitignore"]);
  await runGit(rootPath, ["commit", "--quiet", "-m", "secrets fixture"]);
  return { rootPath };
}

async function gitSucceeds(cwd, argumentsList) {
  try {
    await runGit(cwd, argumentsList);
    return true;
  } catch {
    return false;
  }
}

async function runGit(cwd, argumentsList) {
  const { stdout } = await execFileAsync("git", argumentsList, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  return stdout;
}
