import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  SelfHostingGateWorkspaceError,
  createSelfHostingGateWorkspace,
  publishGateDist,
  removeSelfHostingGateWorkspace,
} from "../scripts/release/self-hosting-gate-workspace.mjs";

const execFileAsync = promisify(execFile);

test("materializes the exact release tree instead of skip-worktree bytes or ignored local secrets", async () => {
  const fixture = await createFixture("exact-head");
  let workspace;
  try {
    await runGit(fixture.repositoryPath, ["update-index", "--skip-worktree", "--", "source.txt"]);
    await writeFile(path.join(fixture.repositoryPath, "source.txt"), "checkout-only bytes\n");
    await mkdir(path.join(fixture.repositoryPath, ".wrangler"), { recursive: true });
    await writeFile(
      path.join(fixture.repositoryPath, ".wrangler", "production.secrets.env"),
      "FUNDSMART_LOCAL_SECRET=must-not-leak\n",
    );
    await writeFile(
      path.join(fixture.repositoryPath, ".env.production.local"),
      "FUNDSMART_LOCAL_ENV=must-not-leak\n",
    );
    assert.equal(
      await runGit(fixture.repositoryPath, ["status", "--porcelain=v1", "--untracked-files=all"]),
      "",
    );

    workspace = await createSelfHostingGateWorkspace({
      cwd: fixture.repositoryPath,
      releaseSha: fixture.releaseSha,
    });

    assert.equal(path.dirname(workspace.rootPath), fixture.rootPath);
    assert.equal(await readFile(path.join(workspace.workspacePath, "source.txt"), "utf8"), "HEAD bytes\n");
    assert.equal(
      await runGit(workspace.workspacePath, ["rev-parse", "--verify", "HEAD^{commit}"]),
      fixture.releaseSha,
    );
    assert.equal(await runGit(workspace.workspacePath, ["rev-parse", "--abbrev-ref", "HEAD"]), "HEAD");
    if (process.platform !== "win32") {
      assert.notEqual(
        (await lstat(path.join(workspace.workspacePath, "nested", "tracked.txt"))).mode & 0o111,
        0,
      );
    }
    assert.equal(
      await runGit(workspace.workspacePath, ["status", "--porcelain=v1", "--untracked-files=all"]),
      "",
    );
    await assert.rejects(lstat(path.join(workspace.workspacePath, ".wrangler")), { code: "ENOENT" });
    await assert.rejects(lstat(path.join(workspace.workspacePath, ".env.production.local")), { code: "ENOENT" });

    await mkdir(path.join(workspace.workspacePath, "dist"), { recursive: true });
    await writeFile(path.join(workspace.workspacePath, "dist", "ignored.txt"), "generated\n");
    await mkdir(path.join(workspace.workspacePath, ".wrangler"), { recursive: true });
    await writeFile(path.join(workspace.workspacePath, ".wrangler", "local.log"), "local\n");
    const workspacePath = workspace.workspacePath;
    await removeSelfHostingGateWorkspace(workspace);
    workspace = undefined;

    await assert.rejects(lstat(workspacePath), { code: "ENOENT" });
    assert.doesNotMatch(
      await runGit(fixture.repositoryPath, ["worktree", "list", "--porcelain"]),
      new RegExp(escapeRegExp(workspacePath), process.platform === "win32" ? "iu" : "u"),
    );
  } finally {
    if (workspace) await removeSelfHostingGateWorkspace(workspace).catch(() => undefined);
    await rm(fixture.rootPath, { recursive: true, force: true });
  }
});

test("materializes blobs without executing configured Git filters or exposing host secrets", async () => {
  const fixture = await createFixture("filter-environment");
  let workspace;
  const filterScriptPath = path.join(fixture.rootPath, "capture-filter-environment.mjs");
  const capturedEnvironmentPath = path.join(fixture.rootPath, "captured-filter-environment.json");
  const sensitiveEnvironment = {
    NODE_OPTIONS: "--trace-warnings",
    npm_config_userconfig: path.join(fixture.rootPath, "private-npmrc"),
    CLOUDFLARE_API_TOKEN: "cloudflare-secret-must-not-leak",
    AWS_SECRET_ACCESS_KEY: "aws-secret-must-not-leak",
    FUNDSMART_TEST_SECRET: "generic-secret-must-not-leak",
  };
  const previousEnvironment = new Map(
    Object.keys(sensitiveEnvironment).map((key) => [key, process.env[key]]),
  );
  try {
    await writeFile(filterScriptPath, [
      "import { writeFileSync } from \"node:fs\";",
      "const chunks = [];",
      "for await (const chunk of process.stdin) chunks.push(chunk);",
      "writeFileSync(process.argv[2], JSON.stringify(process.env), \"utf8\");",
      "process.stdout.write(Buffer.concat(chunks));",
      "",
    ].join("\n"));
    await writeFile(
      path.join(fixture.repositoryPath, ".gitattributes"),
      "* -text\nfiltered.txt filter=capture\n",
    );
    await writeFile(path.join(fixture.repositoryPath, "filtered.txt"), "filtered bytes from HEAD\n");
    await runGit(fixture.repositoryPath, ["add", "--", ".gitattributes", "filtered.txt"]);
    await runGit(fixture.repositoryPath, [
      "-c",
      "user.name=FundoSmart Gate Test",
      "-c",
      "user.email=gate-test@fundosmart.invalid",
      "commit",
      "--quiet",
      "-m",
      "add checkout filter fixture",
    ]);
    const releaseSha = await runGit(fixture.repositoryPath, ["rev-parse", "--verify", "HEAD^{commit}"]);
    const filterCommand = [process.execPath, filterScriptPath, capturedEnvironmentPath]
      .map(quoteGitFilterArgument)
      .join(" ");
    await runGit(fixture.repositoryPath, ["config", "filter.capture.clean", filterCommand]);
    await runGit(fixture.repositoryPath, ["config", "filter.capture.smudge", filterCommand]);
    await runGit(fixture.repositoryPath, ["config", "filter.capture.required", "true"]);
    for (const [key, value] of Object.entries(sensitiveEnvironment)) process.env[key] = value;

    workspace = await createSelfHostingGateWorkspace({
      cwd: fixture.repositoryPath,
      releaseSha,
      temporaryParent: fixture.workspaceParent,
    });
    assert.equal(
      await readFile(path.join(workspace.workspacePath, "filtered.txt"), "utf8"),
      "filtered bytes from HEAD\n",
    );
    await assert.rejects(lstat(capturedEnvironmentPath), { code: "ENOENT" });
  } finally {
    for (const [key, value] of previousEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (workspace) await removeSelfHostingGateWorkspace(workspace).catch(() => undefined);
    await rm(fixture.rootPath, { recursive: true, force: true });
  }
});

test("worktree cleanup fails closed through Git and remains retryable after a lock is released", async () => {
  const fixture = await createFixture("locked-cleanup");
  let workspace;
  try {
    workspace = await createSelfHostingGateWorkspace({
      cwd: fixture.repositoryPath,
      releaseSha: fixture.releaseSha,
      temporaryParent: fixture.workspaceParent,
    });
    await runGit(fixture.repositoryPath, [
      "worktree",
      "lock",
      "--reason",
      "gate cleanup test",
      workspace.workspacePath,
    ]);
    await assert.rejects(
      removeSelfHostingGateWorkspace(workspace),
      (error) => error instanceof SelfHostingGateWorkspaceError
        && /sanitized Git workspace command failed/u.test(error.message),
    );
    assert.equal((await lstat(workspace.workspacePath)).isDirectory(), true);

    await runGit(fixture.repositoryPath, ["worktree", "unlock", workspace.workspacePath]);
    const workspacePath = workspace.workspacePath;
    await removeSelfHostingGateWorkspace(workspace);
    workspace = undefined;
    await assert.rejects(lstat(workspacePath), { code: "ENOENT" });
  } finally {
    if (workspace) {
      await runGit(fixture.repositoryPath, ["worktree", "unlock", workspace.workspacePath]).catch(() => undefined);
      await removeSelfHostingGateWorkspace(workspace).catch(() => undefined);
    }
    await rm(fixture.rootPath, { recursive: true, force: true });
  }
});

test("publishes only an active workspace dist and transactionally replaces the canonical dist", async () => {
  const fixture = await createFixture("publish");
  let workspace;
  try {
    workspace = await createSelfHostingGateWorkspace({
      cwd: fixture.repositoryPath,
      releaseSha: fixture.releaseSha,
      temporaryParent: fixture.workspaceParent,
    });
    const sourceDistPath = path.join(workspace.workspacePath, "dist");
    await mkdir(path.join(sourceDistPath, "server"), { recursive: true });
    await mkdir(path.join(sourceDistPath, "client"), { recursive: true });
    await writeFile(path.join(sourceDistPath, "server", "index.js"), "export default 'new';\n");
    await writeFile(path.join(sourceDistPath, "client", "asset.txt"), "new asset\n");

    const canonicalDistPath = path.join(fixture.repositoryPath, "dist");
    await mkdir(canonicalDistPath);
    await writeFile(path.join(canonicalDistPath, "old.txt"), "old artifact\n");

    await assert.rejects(
      publishGateDist({ cwd: fixture.repositoryPath, sourceDistPath: fixture.repositoryPath }),
      (error) => error instanceof SelfHostingGateWorkspaceError
        && /active gate workspace/u.test(error.message),
    );

    if (process.platform !== "win32") {
      const executablePath = path.join(workspace.workspacePath, "nested", "tracked.txt");
      await chmod(executablePath, 0o644);
      await assert.rejects(
        publishGateDist({ cwd: fixture.repositoryPath, sourceDistPath }),
        (error) => error instanceof SelfHostingGateWorkspaceError
          && /release executable mode/u.test(error.message),
      );
      assert.equal(await readFile(path.join(canonicalDistPath, "old.txt"), "utf8"), "old artifact\n");
      await chmod(executablePath, 0o755);
    }

    await runGit(workspace.workspacePath, ["update-index", "--skip-worktree", "--", "source.txt"]);
    await writeFile(path.join(workspace.workspacePath, "source.txt"), "changed after build\n");
    await assert.rejects(
      publishGateDist({ cwd: fixture.repositoryPath, sourceDistPath }),
      (error) => error instanceof SelfHostingGateWorkspaceError
        && /Tracked gate workspace file source\.txt changed/u.test(error.message),
    );
    assert.equal(await readFile(path.join(canonicalDistPath, "old.txt"), "utf8"), "old artifact\n");
    await writeFile(path.join(workspace.workspacePath, "source.txt"), "HEAD bytes\n");
    await runGit(workspace.workspacePath, ["update-index", "--no-skip-worktree", "--", "source.txt"]);

    const published = await publishGateDist({
      cwd: fixture.repositoryPath,
      sourceDistPath,
    });
    assert.equal(published.distPath, canonicalDistPath);
    assert.match(published.artifactSha256, /^[0-9a-f]{64}$/u);
    assert.equal(published.fileCount, 2);
    assert.equal(Object.hasOwn(published, "rollbackPath"), false);
    assert.equal(
      await readFile(path.join(canonicalDistPath, "server", "index.js"), "utf8"),
      "export default 'new';\n",
    );
    assert.equal(await readFile(path.join(canonicalDistPath, "client", "asset.txt"), "utf8"), "new asset\n");
    await assert.rejects(lstat(path.join(canonicalDistPath, "old.txt")), { code: "ENOENT" });
    assert.equal(
      await readFile(path.join(sourceDistPath, "server", "index.js"), "utf8"),
      "export default 'new';\n",
    );
    assert.deepEqual(await transientPublicationPaths(fixture.rootPath), []);
  } finally {
    if (workspace) await removeSelfHostingGateWorkspace(workspace).catch(() => undefined);
    await rm(fixture.rootPath, { recursive: true, force: true });
  }
});

test("fails closed with exact recovery paths when a published rollback cannot be cleaned", async (context) => {
  const fixture = await createFixture("rollback-retained");
  let workspace;
  try {
    const outsidePath = path.join(fixture.rootPath, "rollback-link-target");
    await mkdir(outsidePath);
    await writeFile(path.join(outsidePath, "outside.txt"), "must survive\n");
    const probePath = path.join(fixture.rootPath, "link-probe");
    try {
      await symlink(outsidePath, probePath, process.platform === "win32" ? "junction" : "dir");
      await rm(probePath, { recursive: true, force: true });
    } catch (error) {
      if (error?.code === "EPERM" || error?.code === "EACCES") {
        context.skip("The test environment does not permit creating a directory link.");
        return;
      }
      throw error;
    }

    workspace = await createSelfHostingGateWorkspace({
      cwd: fixture.repositoryPath,
      releaseSha: fixture.releaseSha,
      temporaryParent: fixture.workspaceParent,
    });
    const sourceDistPath = path.join(workspace.workspacePath, "dist");
    await mkdir(sourceDistPath);
    await writeFile(path.join(sourceDistPath, "new.txt"), "new artifact\n");
    await writeFile(path.join(sourceDistPath, "large.bin"), Buffer.alloc(32 * 1024 * 1024, 0x61));
    const canonicalDistPath = path.join(fixture.repositoryPath, "dist");
    await mkdir(canonicalDistPath);
    await writeFile(path.join(canonicalDistPath, "old.txt"), "old artifact\n");

    const publication = publishGateDist({
      cwd: fixture.repositoryPath,
      sourceDistPath,
    }).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await waitForEntryPrefix(fixture.rootPath, "fundosmart-dist-snapshot-");
    await symlink(
      outsidePath,
      path.join(canonicalDistPath, "linked-after-validation"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const outcome = await publication;
    assert.equal(outcome.value, undefined);
    assert.equal(outcome.error instanceof SelfHostingGateWorkspaceError, true);
    assert.match(outcome.error.message, /rollback verification failed/iu);
    assert.equal(outcome.error.recoveryPaths.canonicalDistPath, canonicalDistPath);
    assert.match(
      outcome.error.recoveryPaths.rollbackPath,
      new RegExp(`^${escapeRegExp(fixture.rootPath)}[\\\\/]+\\.fundosmart-dist-rollback-`, "iu"),
    );
    assert.equal(await readFile(path.join(canonicalDistPath, "old.txt"), "utf8"), "old artifact\n");
    await assert.rejects(lstat(path.join(canonicalDistPath, "new.txt")), { code: "ENOENT" });
    assert.equal(
      await readFile(path.join(outcome.error.recoveryPaths.stagingPath, "new.txt"), "utf8"),
      "new artifact\n",
    );
    assert.equal(
      await readFile(path.join(outcome.error.recoveryPaths.rollbackPath, "old.txt"), "utf8"),
      "old artifact\n",
    );
    assert.equal(await readFile(path.join(outsidePath, "outside.txt"), "utf8"), "must survive\n");
  } finally {
    if (workspace) await removeSelfHostingGateWorkspace(workspace).catch(() => undefined);
    await rm(fixture.rootPath, { recursive: true, force: true });
  }
});

test("never succeeds with a digest for canonical bytes changed after the atomic rename", async () => {
  const fixture = await createFixture("canonical-race");
  let workspace;
  try {
    workspace = await createSelfHostingGateWorkspace({
      cwd: fixture.repositoryPath,
      releaseSha: fixture.releaseSha,
      temporaryParent: fixture.workspaceParent,
    });
    const sourceDistPath = path.join(workspace.workspacePath, "dist");
    await mkdir(sourceDistPath);
    await writeFile(path.join(sourceDistPath, "new.txt"), "new artifact\n");
    await writeFile(path.join(sourceDistPath, "large.bin"), Buffer.alloc(16 * 1024 * 1024, 0x63));
    const canonicalDistPath = path.join(fixture.repositoryPath, "dist");
    await mkdir(path.join(canonicalDistPath, "nested"), { recursive: true });
    await mkdir(path.join(canonicalDistPath, "empty", "deep"), { recursive: true });
    await writeFile(path.join(canonicalDistPath, "old.txt"), "old artifact\n");
    await writeFile(path.join(canonicalDistPath, "nested", "old.bin"), Buffer.from([0, 255, 1, 128]));
    if (process.platform !== "win32") {
      await chmod(path.join(canonicalDistPath, "nested", "old.bin"), 0o750);
    }

    const publication = publishGateDist({
      cwd: fixture.repositoryPath,
      sourceDistPath,
    }).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    const rollbackEntry = await waitForEntryPrefix(fixture.rootPath, ".fundosmart-dist-rollback-");
    await waitForPathAbsent(path.join(fixture.rootPath, rollbackEntry));
    await waitForFileContents(path.join(canonicalDistPath, "new.txt"), "new artifact\n");
    await writeFile(path.join(canonicalDistPath, "new.txt"), "changed after rename\n");
    const outcome = await publication;

    assert.equal(outcome.value, undefined);
    assert.equal(outcome.error instanceof SelfHostingGateWorkspaceError, true);
    assert.match(outcome.error.message, /prior dist was restored/u);
    assert.equal(outcome.error.recoveryPaths.canonicalDistPath, canonicalDistPath);
    assert.match(outcome.error.recoveryPaths.stagingPath, /\.fundosmart-dist-staging-/u);
    assert.equal(await readFile(path.join(canonicalDistPath, "old.txt"), "utf8"), "old artifact\n");
    assert.deepEqual(
      await readFile(path.join(canonicalDistPath, "nested", "old.bin")),
      Buffer.from([0, 255, 1, 128]),
    );
    assert.equal((await lstat(path.join(canonicalDistPath, "empty", "deep"))).isDirectory(), true);
    if (process.platform !== "win32") {
      assert.equal((await lstat(path.join(canonicalDistPath, "nested", "old.bin"))).mode & 0o777, 0o750);
    }
    assert.equal(
      await readFile(path.join(outcome.error.recoveryPaths.stagingPath, "new.txt"), "utf8"),
      "changed after rename\n",
    );
    assert.deepEqual(
      await transientPublicationPaths(fixture.rootPath),
      [path.basename(outcome.error.recoveryPaths.stagingPath)],
    );
  } finally {
    if (workspace) await removeSelfHostingGateWorkspace(workspace).catch(() => undefined);
    await rm(fixture.rootPath, { recursive: true, force: true });
  }
});

test("retains the exact rollback when verified recovery preparation is obstructed", async () => {
  const fixture = await createFixture("recovery-preparation-obstructed");
  let workspace;
  try {
    workspace = await createSelfHostingGateWorkspace({
      cwd: fixture.repositoryPath,
      releaseSha: fixture.releaseSha,
      temporaryParent: fixture.workspaceParent,
    });
    const sourceDistPath = path.join(workspace.workspacePath, "dist");
    await mkdir(sourceDistPath);
    await writeFile(path.join(sourceDistPath, "new.txt"), "new artifact\n");
    const canonicalDistPath = path.join(fixture.repositoryPath, "dist");
    await mkdir(canonicalDistPath);
    await writeFile(path.join(canonicalDistPath, "a-large.bin"), Buffer.alloc(16 * 1024 * 1024, 0x65));
    await writeFile(path.join(canonicalDistPath, "z-late.txt"), "old artifact\n");

    const publication = publishGateDist({
      cwd: fixture.repositoryPath,
      sourceDistPath,
    }).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    const recoveryEntry = await waitForEntryPrefix(fixture.rootPath, ".fundosmart-dist-recovery-");
    const recoveryPath = path.join(fixture.rootPath, recoveryEntry);
    await mkdir(path.join(recoveryPath, "z-late.txt"));
    const outcome = await publication;

    assert.equal(outcome.value, undefined);
    assert.equal(outcome.error instanceof SelfHostingGateWorkspaceError, true);
    assert.match(outcome.error.message, /recovery tree.*rollback was retained/iu);
    assert.equal(outcome.error.recoveryPaths.canonicalDistPath, canonicalDistPath);
    assert.equal(outcome.error.recoveryPaths.recoveryStagingPath, recoveryPath);
    assert.match(outcome.error.recoveryPaths.rollbackPath, /\.fundosmart-dist-rollback-/u);
    assert.equal(await readFile(path.join(canonicalDistPath, "new.txt"), "utf8"), "new artifact\n");
    assert.equal(
      await readFile(path.join(outcome.error.recoveryPaths.rollbackPath, "z-late.txt"), "utf8"),
      "old artifact\n",
    );
    assert.equal(
      (await lstat(path.join(outcome.error.recoveryPaths.rollbackPath, "a-large.bin"))).size,
      16 * 1024 * 1024,
    );
    assert.equal((await lstat(path.join(recoveryPath, "z-late.txt"))).isDirectory(), true);
  } finally {
    if (workspace) await removeSelfHostingGateWorkspace(workspace).catch(() => undefined);
    await rm(fixture.rootPath, { recursive: true, force: true });
  }
});

test("rejects linked dist content before touching the canonical artifact or leaving staging behind", async (context) => {
  const fixture = await createFixture("linked-dist");
  let workspace;
  try {
    workspace = await createSelfHostingGateWorkspace({
      cwd: fixture.repositoryPath,
      releaseSha: fixture.releaseSha,
      temporaryParent: fixture.workspaceParent,
    });
    const sourceDistPath = path.join(workspace.workspacePath, "dist");
    await mkdir(sourceDistPath);
    await writeFile(path.join(sourceDistPath, "safe.txt"), "safe artifact\n");
    const outsidePath = path.join(fixture.rootPath, "outside");
    await mkdir(outsidePath);
    await writeFile(path.join(outsidePath, "secret.txt"), "outside secret\n");
    try {
      await symlink(
        outsidePath,
        path.join(sourceDistPath, "linked-outside"),
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch (error) {
      if (error?.code === "EPERM" || error?.code === "EACCES") {
        context.skip("The test environment does not permit creating a directory link.");
        return;
      }
      throw error;
    }

    const canonicalDistPath = path.join(fixture.repositoryPath, "dist");
    await mkdir(canonicalDistPath);
    await writeFile(path.join(canonicalDistPath, "old.txt"), "old artifact\n");

    await assert.rejects(
      publishGateDist({ cwd: fixture.repositoryPath, sourceDistPath }),
      /symbolic link|contains a link/iu,
    );
    assert.equal(await readFile(path.join(canonicalDistPath, "old.txt"), "utf8"), "old artifact\n");
    assert.equal(await readFile(path.join(outsidePath, "secret.txt"), "utf8"), "outside secret\n");
    assert.deepEqual(await transientPublicationPaths(fixture.rootPath), []);
  } finally {
    if (workspace) await removeSelfHostingGateWorkspace(workspace).catch(() => undefined);
    await rm(fixture.rootPath, { recursive: true, force: true });
  }
});

test("rejects a release SHA that is not the source checkout's real HEAD", async () => {
  const fixture = await createFixture("wrong-sha");
  try {
    await assert.rejects(
      createSelfHostingGateWorkspace({
        cwd: fixture.repositoryPath,
        releaseSha: "0".repeat(fixture.releaseSha.length),
        temporaryParent: fixture.workspaceParent,
      }),
      (error) => error instanceof SelfHostingGateWorkspaceError
        && /must equal the real HEAD/u.test(error.message),
    );
    assert.deepEqual(await readdir(fixture.workspaceParent), []);
  } finally {
    await rm(fixture.rootPath, { recursive: true, force: true });
  }
});

test("rejects tracked Wrangler state and local environment files before creating a worktree", async () => {
  const fixture = await createFixture("tracked-local-state");
  try {
    await mkdir(path.join(fixture.repositoryPath, ".wrangler"));
    await writeFile(path.join(fixture.repositoryPath, ".wrangler", "tracked-secret.env"), "SECRET=tracked\n");
    await writeFile(path.join(fixture.repositoryPath, ".env.production.local"), "SECRET=tracked-too\n");
    await runGit(fixture.repositoryPath, [
      "add",
      "--force",
      "--",
      ".wrangler/tracked-secret.env",
      ".env.production.local",
    ]);
    await runGit(fixture.repositoryPath, [
      "-c",
      "user.name=FundoSmart Gate Test",
      "-c",
      "user.email=gate-test@fundosmart.invalid",
      "commit",
      "--quiet",
      "-m",
      "track forbidden local state",
    ]);
    const releaseSha = await runGit(fixture.repositoryPath, ["rev-parse", "--verify", "HEAD^{commit}"]);

    await assert.rejects(
      createSelfHostingGateWorkspace({
        cwd: fixture.repositoryPath,
        releaseSha,
        temporaryParent: fixture.workspaceParent,
      }),
      (error) => error instanceof SelfHostingGateWorkspaceError
        && /forbidden local state/u.test(error.message),
    );
    assert.deepEqual(await readdir(fixture.workspaceParent), []);
  } finally {
    await rm(fixture.rootPath, { recursive: true, force: true });
  }
});

test("refuses publication after the source checkout advances beyond the workspace release", async () => {
  const fixture = await createFixture("source-head-changed");
  let workspace;
  try {
    workspace = await createSelfHostingGateWorkspace({
      cwd: fixture.repositoryPath,
      releaseSha: fixture.releaseSha,
      temporaryParent: fixture.workspaceParent,
    });
    const sourceDistPath = path.join(workspace.workspacePath, "dist");
    await mkdir(sourceDistPath);
    await writeFile(path.join(sourceDistPath, "new.txt"), "new artifact\n");
    const canonicalDistPath = path.join(fixture.repositoryPath, "dist");
    await mkdir(canonicalDistPath);
    await writeFile(path.join(canonicalDistPath, "old.txt"), "old artifact\n");

    await writeFile(path.join(fixture.repositoryPath, "later.txt"), "later release\n");
    await runGit(fixture.repositoryPath, ["add", "--", "later.txt"]);
    await runGit(fixture.repositoryPath, [
      "-c",
      "user.name=FundoSmart Gate Test",
      "-c",
      "user.email=gate-test@fundosmart.invalid",
      "commit",
      "--quiet",
      "-m",
      "advance source checkout",
    ]);

    await assert.rejects(
      publishGateDist({ cwd: fixture.repositoryPath, sourceDistPath }),
      (error) => error instanceof SelfHostingGateWorkspaceError
        && /source checkout HEAD changed/u.test(error.message),
    );
    assert.equal(await readFile(path.join(canonicalDistPath, "old.txt"), "utf8"), "old artifact\n");
    assert.deepEqual(await transientPublicationPaths(fixture.rootPath), []);
  } finally {
    if (workspace) await removeSelfHostingGateWorkspace(workspace).catch(() => undefined);
    await rm(fixture.rootPath, { recursive: true, force: true });
  }
});

test("rolls back when the source HEAD advances while the artifact snapshot is being staged", async () => {
  const fixture = await createFixture("source-head-race");
  let workspace;
  try {
    workspace = await createSelfHostingGateWorkspace({
      cwd: fixture.repositoryPath,
      releaseSha: fixture.releaseSha,
      temporaryParent: fixture.workspaceParent,
    });
    const sourceDistPath = path.join(workspace.workspacePath, "dist");
    await mkdir(sourceDistPath);
    await writeFile(path.join(sourceDistPath, "new.txt"), "new artifact\n");
    await writeFile(path.join(sourceDistPath, "large.bin"), Buffer.alloc(16 * 1024 * 1024, 0x62));
    const canonicalDistPath = path.join(fixture.repositoryPath, "dist");
    await mkdir(canonicalDistPath);
    await writeFile(path.join(canonicalDistPath, "old.txt"), "old artifact\n");
    const releaseTree = await runGit(fixture.repositoryPath, [
      "rev-parse",
      "--verify",
      `${fixture.releaseSha}^{tree}`,
    ]);
    const nextSha = await runGit(fixture.repositoryPath, [
      "-c",
      "user.name=FundoSmart Gate Test",
      "-c",
      "user.email=gate-test@fundosmart.invalid",
      "commit-tree",
      releaseTree,
      "-p",
      fixture.releaseSha,
      "-m",
      "next release identity",
    ]);

    const publication = publishGateDist({
      cwd: fixture.repositoryPath,
      sourceDistPath,
    }).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await waitForEntryPrefix(fixture.rootPath, "fundosmart-dist-snapshot-");
    await runGit(fixture.repositoryPath, ["update-ref", "HEAD", nextSha, fixture.releaseSha]);
    const outcome = await publication;

    assert.equal(outcome.value, undefined);
    assert.equal(outcome.error instanceof SelfHostingGateWorkspaceError, true);
    assert.match(outcome.error.message, /source checkout HEAD changed/u);
    assert.equal(await readFile(path.join(canonicalDistPath, "old.txt"), "utf8"), "old artifact\n");
    assert.deepEqual(await transientPublicationPaths(fixture.rootPath), []);
  } finally {
    if (workspace) await removeSelfHostingGateWorkspace(workspace).catch(() => undefined);
    await rm(fixture.rootPath, { recursive: true, force: true });
  }
});

async function createFixture(label) {
  const rootPath = await mkdtemp(path.join(tmpdir(), `fundosmart-gate-${label}-`));
  const repositoryPath = path.join(rootPath, "repository");
  const workspaceParent = path.join(rootPath, "workspaces");
  await mkdir(repositoryPath);
  await mkdir(workspaceParent);
  await runGit(repositoryPath, ["init", "--quiet"]);
  await writeFile(path.join(repositoryPath, ".gitattributes"), "* -text\n");
  await writeFile(
    path.join(repositoryPath, ".gitignore"),
    "/dist/\n/.wrangler/\n.env*.local\n",
  );
  await writeFile(path.join(repositoryPath, "source.txt"), "HEAD bytes\n");
  await mkdir(path.join(repositoryPath, "nested"));
  await writeFile(path.join(repositoryPath, "nested", "tracked.txt"), "tracked bytes\n");
  await runGit(repositoryPath, ["add", "--", ".gitattributes", ".gitignore", "source.txt", "nested/tracked.txt"]);
  await runGit(repositoryPath, ["update-index", "--chmod=+x", "--", "nested/tracked.txt"]);
  await runGit(repositoryPath, [
    "-c",
    "user.name=FundoSmart Gate Test",
    "-c",
    "user.email=gate-test@fundosmart.invalid",
    "commit",
    "--quiet",
    "-m",
    "gate fixture",
  ]);
  const releaseSha = await runGit(repositoryPath, ["rev-parse", "--verify", "HEAD^{commit}"]);
  return { rootPath, repositoryPath, workspaceParent, releaseSha };
}

async function runGit(cwd, argumentsList) {
  const { stdout } = await execFileAsync("git", argumentsList, {
    cwd,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  });
  return stdout.replace(/\r?\n$/u, "");
}

async function transientPublicationPaths(rootPath) {
  const entries = await readdir(rootPath);
  return entries
    .filter((entry) => entry.startsWith(".fundosmart-dist-")
      || entry.startsWith("fundosmart-dist-snapshot-"))
    .sort();
}

async function waitForEntryPrefix(parentPath, prefix) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const entry = (await readdir(parentPath)).find((candidate) => candidate.startsWith(prefix));
    if (entry) return entry;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`Timed out waiting for a ${prefix} entry under ${parentPath}.`);
}

async function waitForPathAbsent(filePath) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await lstat(filePath);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`Timed out waiting for ${filePath} to disappear.`);
}

async function waitForFileContents(filePath, expectedContents) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      if (await readFile(filePath, "utf8") === expectedContents) return;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`Timed out waiting for expected contents at ${filePath}.`);
}

function quoteGitFilterArgument(value) {
  return `'${value.replaceAll("\\", "/").replaceAll("'", "'\\''")}'`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
