import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createSelfHostingToolingEnvironment,
  installSelfHostingTooling,
  removeSelfHostingTooling,
  resolveTrustedNpmCli,
  runSelfHostingGate,
  verifySelfHostingTooling,
} from "../scripts/release/self-hosting-gate-runner.mjs";

const expectedCommands = [
  ["ci", "--ignore-scripts", "--no-audit", "--fund=false"],
  ["run", "lint"],
  ["run", "typecheck"],
  ["run", "build"],
  ["run", "test:built"],
  ["run", "deploy:check:built"],
  ["audit"],
];

test("runs the complete gate as an exact sequence of direct trusted npm invocations", async (t) => {
  const workspace = await createWorkspace(t, "sequence");
  const calls = [];
  let environment;
  let runtimeRoot;
  const trustedNpmCli = await createFakeNpmCli(t, workspace);
  const resolvedNodeExecutable = await realpath(process.execPath);
  const runtimeParent = await realpath(path.dirname(workspace));

  const result = await runSelfHostingGate({
    cwd: workspace,
    variables: {
      FUNDOSMART_DEPLOY_ENVIRONMENT: "production",
      FUNDOSMART_RELEASE_SHA: "a".repeat(40),
    },
    hostEnvironment: baseHostEnvironment(),
    resolveNpmCli: async () => trustedNpmCli,
    spawnProcess: async (details) => {
      calls.push(details);
      environment ??= details.environment;
      runtimeRoot ??= path.dirname(details.environment.HOME);
      assert.equal((await lstat(details.environment.HOME)).isDirectory(), true);
      assert.equal((await lstat(details.environment.NPM_CONFIG_CACHE)).isDirectory(), true);
      assert.equal(
        await readFile(details.environment.NPM_CONFIG_USERCONFIG, "utf8"),
        "fund=false\nignore-scripts=true\nupdate-notifier=false\nprogress=false\ncolor=false\n",
      );
      assert.equal(await readFile(details.environment.NPM_CONFIG_GLOBALCONFIG, "utf8"), "\n");
    },
  });

  assert.deepEqual(calls.map(({ argumentsList }) => argumentsList.slice(1)), expectedCommands);
  assert.deepEqual(
    calls.map(({ executable, argumentsList }) => [executable, argumentsList[0]]),
    expectedCommands.map(() => [resolvedNodeExecutable, trustedNpmCli]),
  );
  assert.equal(result.commandCount, expectedCommands.length);
  assert.equal(environment.FUNDOSMART_DEPLOY_ENVIRONMENT, "production");
  assert.equal(environment.FUNDOSMART_RELEASE_SHA, "a".repeat(40));
  assert.equal(environment.CI, "true");
  assert.equal(environment.NPM_CONFIG_IGNORE_SCRIPTS, "true");
  assert.equal(environment.NPM_CONFIG_NODE_OPTIONS, "");
  assert.equal(isInside(workspace, environment.HOME), false);
  assert.equal(isInside(runtimeRoot, environment.HOME), true);
  assert.equal(isInside(runtimeRoot, environment.TEMP), true);
  assert.equal(samePath(path.dirname(runtimeRoot), runtimeParent), true);
  assert.equal(path.basename(runtimeRoot).startsWith("fs-g-"), true);
  assert.ok(path.basename(runtimeRoot).length <= 16);
  await assert.rejects(lstat(runtimeRoot), { code: "ENOENT" });
});

test("a fake npm on the host PATH never wins over the active Node installation", async (t) => {
  const container = await createWorkspace(t, "path");
  const workspace = path.join(container, "workspace");
  const fakeBin = path.join(container, "fake-bin");
  await Promise.all([mkdir(workspace), mkdir(fakeBin)]);
  await writeFile(
    path.join(fakeBin, process.platform === "win32" ? "npm.cmd" : "npm"),
    process.platform === "win32" ? "@exit /b 91\r\n" : "#!/bin/sh\nexit 91\n",
    { mode: 0o755 },
  );
  const trustedNpmCli = await createFakeNpmCli(t, container);
  const resolvedNodeExecutable = await realpath(process.execPath);
  const calls = [];
  const fakeComSpec = path.join(fakeBin, "cmd.exe");
  const hostileTemp = path.join(workspace, "hostile-temp");
  const runtimeParent = await realpath(path.dirname(workspace));

  await runSelfHostingGate({
    cwd: workspace,
    hostEnvironment: {
      ...baseHostEnvironment(),
      PATH: [fakeBin, hostPath()].filter(Boolean).join(path.delimiter),
      ComSpec: fakeComSpec,
      TEMP: hostileTemp,
      TMP: hostileTemp,
      TMPDIR: hostileTemp,
    },
    resolveNpmCli: async () => trustedNpmCli,
    spawnProcess: async (details) => calls.push(details),
  });

  assert.equal(calls.length, expectedCommands.length);
  assert.deepEqual(
    calls.map(({ executable, argumentsList }) => [executable, argumentsList[0], ...argumentsList.slice(1)]),
    expectedCommands.map((command) => [resolvedNodeExecutable, trustedNpmCli, ...command]),
  );
  for (const call of calls) {
    const runtimeRoot = path.dirname(call.environment.HOME);
    const pathEntries = call.environment.PATH.split(path.delimiter);
    assert.equal(pathEntries[0], path.join(workspace, "node_modules", ".bin"));
    assert.equal(pathEntries[1], path.dirname(resolvedNodeExecutable));
    assert.ok(pathEntries.indexOf(fakeBin) > 1);
    assert.equal(isInside(fakeBin, call.argumentsList[0]), false);
    assert.equal(isInside(workspace, runtimeRoot), false);
    assert.equal(isInside(hostileTemp, runtimeRoot), false);
    assert.equal(samePath(path.dirname(runtimeRoot), runtimeParent), true);
    assert.equal(isInside(runtimeRoot, call.environment.TEMP), true);
    if (process.platform === "win32") {
      assert.notEqual(call.environment.COMSPEC, fakeComSpec);
      assert.equal(call.environment.COMSPEC, call.environment.NPM_CONFIG_SCRIPT_SHELL);
      assert.equal(
        call.environment.COMSPEC.toLowerCase(),
        path.join(call.environment.SYSTEMROOT, "System32", "cmd.exe").toLowerCase(),
      );
    }
  }
  await assert.rejects(lstat(path.dirname(calls[0].environment.HOME)), { code: "ENOENT" });
});

test("every failed phase stops the exact sequence and removes the isolated runtime", async (t) => {
  const workspace = await createWorkspace(t, "failures");
  const trustedNpmCli = await createFakeNpmCli(t, workspace);
  const runtimeParent = await realpath(path.dirname(workspace));

  for (let failureIndex = 0; failureIndex < expectedCommands.length; failureIndex += 1) {
    const calls = [];
    let runtimeRoot;
    await assert.rejects(
      runSelfHostingGate({
        cwd: workspace,
        hostEnvironment: baseHostEnvironment(),
        resolveNpmCli: async () => trustedNpmCli,
        spawnProcess: async ({ argumentsList, environment }) => {
          calls.push(argumentsList.slice(1));
          runtimeRoot ??= path.dirname(environment.HOME);
          if (calls.length - 1 === failureIndex) throw new Error(`failure-${failureIndex}`);
        },
      }),
      new RegExp(`npm ${escapeRegExp(expectedCommands[failureIndex].join(" "))}`, "u"),
    );
    assert.deepEqual(calls, expectedCommands.slice(0, failureIndex + 1));
    assert.equal(isInside(workspace, runtimeRoot), false);
    assert.equal(samePath(path.dirname(runtimeRoot), runtimeParent), true);
    await assert.rejects(lstat(runtimeRoot), { code: "ENOENT" });
  }
});

test("the gate environment propagates approved build values but no host credentials or secrets", async (t) => {
  const workspace = await createWorkspace(t, "environment");
  const trustedNpmCli = await createFakeNpmCli(t, workspace);
  const environments = [];
  const runtimeRoots = [];
  const hostileTemp = path.join(workspace, "hostile-temp");
  const runtimeParent = await realpath(path.dirname(workspace));
  const secretValues = [
    "cloudflare-token-must-not-propagate",
    "google-secret-must-not-propagate",
    "offline-secret-must-not-propagate",
    "node-option-must-not-propagate",
    "npm-execpath-must-not-propagate",
  ];
  const originalTemporaryEnvironment = Object.fromEntries(
    ["TEMP", "TMP", "TMPDIR"].map((key) => [key, process.env[key]]),
  );
  t.after(() => {
    for (const [key, value] of Object.entries(originalTemporaryEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  for (const key of ["TEMP", "TMP", "TMPDIR"]) process.env[key] = hostileTemp;

  for (let invocation = 0; invocation < 2; invocation += 1) {
    let environment;
    await runSelfHostingGate({
      cwd: workspace,
      variables: {
        CLOUDFLARE_ACCOUNT_ID: "1234567890abcdef1234567890abcdef",
        GOOGLE_CLIENT_SECRET: secretValues[1],
        OFFLINE_SESSION_SECRET: secretValues[2],
      },
      hostEnvironment: {
        ...baseHostEnvironment(),
        PATH: hostileTemp,
        TEMP: hostileTemp,
        TMP: hostileTemp,
        TMPDIR: hostileTemp,
        CLOUDFLARE_API_TOKEN: secretValues[0],
        CLOUDFLARE_API_KEY: "global-key-must-not-propagate",
        CLOUDFLARE_EMAIL: "owner@farm.example",
        GOOGLE_CLIENT_SECRET: secretValues[1],
        OFFLINE_SESSION_SECRET: secretValues[2],
        NODE_OPTIONS: secretValues[3],
        npm_execpath: secretValues[4],
        NPM_CONFIG_USERCONFIG: "attacker-controlled.npmrc",
        HOME: "attacker-controlled-home",
      },
      resolveNpmCli: async () => trustedNpmCli,
      spawnProcess: async (details) => { environment ??= details.environment; },
    });
    environments.push(environment);
    runtimeRoots.push(path.dirname(environment.HOME));
    await assert.rejects(lstat(runtimeRoots.at(-1)), { code: "ENOENT" });
  }

  assert.equal(new Set(runtimeRoots.map(normalizedPath)).size, 2);
  for (const [index, environment] of environments.entries()) {
    const runtimeRoot = runtimeRoots[index];
    assert.equal(environment.CLOUDFLARE_ACCOUNT_ID, "1234567890abcdef1234567890abcdef");
    assert.equal(isInside(workspace, environment.HOME), false);
    assert.equal(isInside(hostileTemp, environment.HOME), false);
    assert.equal(samePath(path.dirname(runtimeRoot), runtimeParent), true);
    assert.equal(isInside(runtimeRoot, environment.HOME), true);
    assert.equal(isInside(runtimeRoot, environment.TEMP), true);
    assert.equal(path.basename(runtimeRoot).startsWith("fs-g-"), true);
    assert.ok(path.basename(runtimeRoot).length <= 16);
    for (const key of [
      "CLOUDFLARE_API_TOKEN",
      "CLOUDFLARE_API_KEY",
      "CLOUDFLARE_EMAIL",
      "GOOGLE_CLIENT_SECRET",
      "OFFLINE_SESSION_SECRET",
      "NODE_OPTIONS",
      "NPM_EXECPATH",
    ]) {
      assert.equal(
        Object.keys(environment).some((candidate) => candidate.toUpperCase() === key),
        false,
        key,
      );
    }
    const serializedEnvironment = JSON.stringify(environment);
    for (const secret of secretValues) assert.equal(serializedEnvironment.includes(secret), false);
    assert.notEqual(environment.HOME, "attacker-controlled-home");
    assert.notEqual(environment.NPM_CONFIG_USERCONFIG, "attacker-controlled.npmrc");
  }
});

test("the trusted npm resolver enforces the exact project npm pin and Node minimum", async (t) => {
  const fixture = await createPinnedNpmFixture(t);
  assert.equal(
    await resolveTrustedNpmCli({
      cwd: fixture.workspacePath,
      nodeExecutable: fixture.nodeExecutable,
      nodeVersion: "22.13.0",
      candidateNpmRoots: [fixture.npmRoot],
    }),
    await realpath(fixture.npmCli),
  );

  await assert.rejects(
    resolveTrustedNpmCli({
      cwd: fixture.workspacePath,
      nodeExecutable: fixture.nodeExecutable,
      nodeVersion: "22.12.0",
      candidateNpmRoots: [fixture.npmRoot],
    }),
    /Node 22\.12\.0 is unsupported/u,
  );

  await writeFile(path.join(fixture.npmRoot, "package.json"), JSON.stringify({
    name: "npm",
    version: "11.6.1",
    bin: { npm: "bin/npm-cli.js" },
  }));
  await assert.rejects(
    resolveTrustedNpmCli({
      cwd: fixture.workspacePath,
      nodeExecutable: fixture.nodeExecutable,
      nodeVersion: "24.0.0",
      candidateNpmRoots: [fixture.npmRoot],
    }),
    /must bundle npm 10\.9\.3/u,
  );

  await writeFile(path.join(fixture.workspacePath, "package.json"), JSON.stringify({
    packageManager: "npm@^10.9.3",
    engines: { node: ">=22.13.0" },
  }));
  await assert.rejects(
    resolveTrustedNpmCli({
      cwd: fixture.workspacePath,
      nodeExecutable: fixture.nodeExecutable,
      nodeVersion: "24.0.0",
      candidateNpmRoots: [fixture.npmRoot],
    }),
    /packageManager exactly to npm@10\.9\.3/u,
  );
});

test("installs Wrangler only in the exact release workspace before credentials exist", async (t) => {
  const fixture = await createToolingWorkspaceFixture(t);
  const calls = [];
  let removedWorkspace = false;
  const token = "cloudflare-token-that-must-not-reach-npm";
  const fakeOriginalCli = path.join(
    fixture.sourcePath,
    "node_modules",
    "wrangler",
    "bin",
    "wrangler.js",
  );
  await mkdir(path.dirname(fakeOriginalCli), { recursive: true });
  await writeFile(fakeOriginalCli, "throw new Error('original checkout Wrangler executed');\n");

  const tooling = await installSelfHostingTooling({
    cwd: fixture.sourcePath,
    releaseSha: fixture.releaseSha,
    hostEnvironment: {
      ...baseHostEnvironment(),
      CLOUDFLARE_API_TOKEN: token,
      WRANGLER_CONFIG: "attacker-wrangler.toml",
      NODE_OPTIONS: "--import=attacker.mjs",
      npm_execpath: "attacker-npm.js",
    },
    createWorkspace: async () => fixture.workspace,
    removeWorkspace: async () => {
      removedWorkspace = true;
      await rm(fixture.workspace.rootPath, { recursive: true, force: true });
    },
    resolveNpmCli: async ({ cwd }) => {
      assert.equal(cwd, fixture.workspace.workspacePath);
      return fixture.npmCli;
    },
    spawnProcess: async (details) => {
      calls.push(details);
      assert.deepEqual(details.argumentsList, [
        fixture.npmCli,
        "ci",
        "--ignore-scripts",
        "--no-audit",
        "--fund=false",
      ]);
      for (const forbiddenKey of [
        "CLOUDFLARE_API_TOKEN",
        "WRANGLER_CONFIG",
        "NODE_OPTIONS",
        "NODE_PATH",
        "NPM_EXECPATH",
      ]) {
        assert.equal(
          Object.keys(details.environment).some((key) => key.toUpperCase() === forbiddenKey),
          false,
          forbiddenKey,
        );
      }
      assert.equal(JSON.stringify(details.environment).includes(token), false);
      await materializePinnedWrangler(fixture.workspace.workspacePath);
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(isInside(fixture.workspace.workspacePath, tooling.wranglerCli), true);
  assert.notEqual(tooling.wranglerCli, fakeOriginalCli);
  assert.equal(await readFile(tooling.wranglerCli, "utf8"), "export const pinned = true;\n");
  const untrustedToolingBin = path.join(
    fixture.workspace.workspacePath,
    "node_modules",
    ".bin",
  );
  const untrustedSourceBin = path.join(
    fixture.sourcePath,
    "node_modules",
    ".bin",
  );
  const hostileShimName = process.platform === "win32" ? "git.cmd" : "git";
  await Promise.all([
    mkdir(untrustedToolingBin, { recursive: true }),
    mkdir(untrustedSourceBin, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(untrustedToolingBin, hostileShimName), "hostile tooling shim\n"),
    writeFile(path.join(untrustedSourceBin, hostileShimName), "hostile source shim\n"),
  ]);
  const environment = await createSelfHostingToolingEnvironment({
    tooling,
    hostEnvironment: {
      ...baseHostEnvironment(),
      PATH: [untrustedToolingBin, untrustedSourceBin, hostPath()].join(path.delimiter),
      CLOUDFLARE_API_TOKEN: token,
      WRANGLER_CONFIG: "attacker-wrangler.toml",
      CF_API_TOKEN: "legacy-token",
      NODE_OPTIONS: "--import=attacker.mjs",
      NODE_PATH: "attacker-modules",
      npm_execpath: "attacker-npm.js",
    },
    accountId: "1234567890abcdef1234567890abcdef",
  });
  assert.equal(environment.CLOUDFLARE_API_TOKEN, token);
  assert.equal(environment.WRANGLER_CONFIG, undefined);
  assert.equal(environment.CF_API_TOKEN, undefined);
  assert.equal(environment.NODE_OPTIONS, undefined);
  assert.equal(environment.NODE_PATH, undefined);
  assert.equal(environment.npm_execpath, undefined);
  const toolingPathEntries = environment.PATH.split(path.delimiter);
  assert.equal(toolingPathEntries[0], path.dirname(tooling.nodeExecutable));
  assert.equal(toolingPathEntries.some((entry) => samePath(entry, untrustedToolingBin)), false);
  assert.equal(toolingPathEntries.some((entry) => samePath(entry, untrustedSourceBin)), false);
  assert.equal(
    toolingPathEntries
      .map((entry) => path.join(entry, hostileShimName))
      .some((candidate) => [untrustedToolingBin, untrustedSourceBin]
        .some((binPath) => samePath(candidate, path.join(binPath, hostileShimName)))),
    false,
  );
  await verifySelfHostingTooling(tooling);
  const wranglerRoot = path.dirname(path.dirname(tooling.wranglerCli));
  const runtimeCliPath = path.join(wranglerRoot, "wrangler-dist", "cli.js");
  const runtimeDependencyPath = path.join(
    fixture.workspace.workspacePath,
    "node_modules",
    "wrangler-runtime-fixture",
    "index.js",
  );
  const nestedAssetPath = path.join(wranglerRoot, "assets", "node_modules", "embedded.js");
  await writeFile(runtimeCliPath, "export const runtimePinned = false;\n");
  await assert.rejects(
    verifySelfHostingTooling(tooling),
    /Wrangler installation changed/u,
  );
  await writeFile(runtimeCliPath, "export const runtimePinned = true;\n");
  await verifySelfHostingTooling(tooling);
  await writeFile(nestedAssetPath, "export const embeddedPinned = false;\n");
  await assert.rejects(
    verifySelfHostingTooling(tooling),
    /Wrangler installation changed/u,
  );
  await writeFile(nestedAssetPath, "export const embeddedPinned = true;\n");
  await verifySelfHostingTooling(tooling);
  await writeFile(runtimeDependencyPath, "export const dependencyPinned = false;\n");
  await assert.rejects(
    verifySelfHostingTooling(tooling),
    /Wrangler installation changed/u,
  );
  await rm(path.dirname(runtimeDependencyPath), { recursive: true, force: true });
  await assert.rejects(
    verifySelfHostingTooling(tooling),
    /declared dependency wrangler-runtime-fixture .* is not installed/u,
  );
  const runtimeRoot = tooling.runtime.rootPath;
  await removeSelfHostingTooling(tooling);
  assert.equal(removedWorkspace, true);
  await assert.rejects(lstat(runtimeRoot), { code: "ENOENT" });
  await assert.rejects(lstat(fixture.workspace.rootPath), { code: "ENOENT" });
});

test("a failed tooling install removes its private runtime and exact workspace", async (t) => {
  const fixture = await createToolingWorkspaceFixture(t);
  let runtimeRoot;
  let removedWorkspace = false;
  await assert.rejects(
    installSelfHostingTooling({
      cwd: fixture.sourcePath,
      releaseSha: fixture.releaseSha,
      hostEnvironment: baseHostEnvironment(),
      createWorkspace: async () => fixture.workspace,
      removeWorkspace: async () => {
        removedWorkspace = true;
        await rm(fixture.workspace.rootPath, { recursive: true, force: true });
      },
      resolveNpmCli: async () => fixture.npmCli,
      spawnProcess: async ({ environment }) => {
        runtimeRoot = path.dirname(environment.HOME);
        throw new Error("simulated npm ci failure");
      },
    }),
    /tooling installation failed/u,
  );
  assert.equal(removedWorkspace, true);
  await assert.rejects(lstat(runtimeRoot), { code: "ENOENT" });
  await assert.rejects(lstat(fixture.workspace.rootPath), { code: "ENOENT" });
});

test("rejects links anywhere inside an installed tooling package", async (t) => {
  const fixture = await createToolingWorkspaceFixture(t);
  let removedWorkspace = false;
  await assert.rejects(
    installSelfHostingTooling({
      cwd: fixture.sourcePath,
      releaseSha: fixture.releaseSha,
      hostEnvironment: baseHostEnvironment(),
      createWorkspace: async () => fixture.workspace,
      removeWorkspace: async () => {
        removedWorkspace = true;
        await rm(fixture.workspace.rootPath, { recursive: true, force: true });
      },
      resolveNpmCli: async () => fixture.npmCli,
      spawnProcess: async () => {
        await materializePinnedWrangler(fixture.workspace.workspacePath);
        const wranglerRoot = path.join(
          fixture.workspace.workspacePath,
          "node_modules",
          "wrangler",
        );
        await symlink(
          path.join(wranglerRoot, "wrangler-dist"),
          path.join(wranglerRoot, "linked-runtime"),
          "junction",
        );
      },
    }),
    /installed tooling package contains a link/u,
  );
  assert.equal(removedWorkspace, true);
  await assert.rejects(lstat(fixture.workspace.rootPath), { code: "ENOENT" });
});

test("rejects a broken link instead of treating an optional peer as absent", async (t) => {
  const fixture = await createToolingWorkspaceFixture(t, { optionalPeer: true });
  const probeLink = path.join(fixture.containerPath, "broken-link-probe");
  try {
    await symlink(
      path.join(fixture.containerPath, "missing-probe-target"),
      probeLink,
      process.platform === "win32" ? "junction" : "dir",
    );
    assert.equal((await lstat(probeLink)).isSymbolicLink(), true);
    await rm(probeLink, { force: true });
  } catch (error) {
    if (["EACCES", "ENOSYS", "EPERM", "UNKNOWN"].includes(error?.code)) {
      t.skip(`This OS cannot create the broken-link fixture: ${error.code}.`);
      return;
    }
    throw error;
  }

  let removedWorkspace = false;
  await assert.rejects(
    installSelfHostingTooling({
      cwd: fixture.sourcePath,
      releaseSha: fixture.releaseSha,
      hostEnvironment: baseHostEnvironment(),
      createWorkspace: async () => fixture.workspace,
      removeWorkspace: async () => {
        removedWorkspace = true;
        await rm(fixture.workspace.rootPath, { recursive: true, force: true });
      },
      resolveNpmCli: async () => fixture.npmCli,
      spawnProcess: async () => {
        await materializePinnedWrangler(
          fixture.workspace.workspacePath,
          { optionalPeer: true },
        );
        await symlink(
          path.join(fixture.workspace.workspacePath, "missing-optional-peer-target"),
          path.join(
            fixture.workspace.workspacePath,
            "node_modules",
            "optional-peer-fixture",
          ),
          process.platform === "win32" ? "junction" : "dir",
        );
      },
    }),
    /optional-peer-fixture is not an exact regular directory/u,
  );
  assert.equal(removedWorkspace, true);
  await assert.rejects(lstat(fixture.workspace.rootPath), { code: "ENOENT" });
});

async function createWorkspace(t, label) {
  const workspace = await mkdtemp(path.join(tmpdir(), `fundosmart-gate-runner-${label}-`));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  return workspace;
}

async function createFakeNpmCli(t, parentPath) {
  const npmRoot = await mkdtemp(path.join(parentPath, "trusted-npm-"));
  const npmCli = path.join(npmRoot, "npm-cli.js");
  await writeFile(npmCli, "// trusted npm test fixture\n");
  t.after(() => rm(npmRoot, { recursive: true, force: true }));
  return realpath(npmCli);
}

async function createPinnedNpmFixture(t) {
  const containerPath = await mkdtemp(path.join(tmpdir(), "fundosmart-pinned-npm-"));
  const workspacePath = path.join(containerPath, "workspace");
  const nodeExecutable = path.join(containerPath, process.platform === "win32" ? "node.exe" : "node");
  const npmRoot = path.join(containerPath, "npm");
  const npmCli = path.join(npmRoot, "bin", "npm-cli.js");
  await Promise.all([
    mkdir(workspacePath),
    mkdir(path.dirname(npmCli), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(workspacePath, "package.json"), JSON.stringify({
      packageManager: "npm@10.9.3",
      engines: { node: ">=22.13.0" },
    })),
    writeFile(nodeExecutable, "test node executable\n"),
    writeFile(npmCli, "// pinned npm CLI\n"),
    writeFile(path.join(npmRoot, "package.json"), JSON.stringify({
      name: "npm",
      version: "10.9.3",
      bin: { npm: "bin/npm-cli.js" },
    })),
  ]);
  t.after(() => rm(containerPath, { recursive: true, force: true }));
  return { workspacePath, nodeExecutable, npmRoot, npmCli };
}

async function createToolingWorkspaceFixture(t, { optionalPeer = false } = {}) {
  const containerPath = await mkdtemp(path.join(tmpdir(), "fundosmart-tooling-install-"));
  const sourcePath = path.join(containerPath, "source");
  const rootPath = path.join(containerPath, "exact-workspace");
  const workspacePath = path.join(rootPath, "checkout");
  const npmCli = path.join(containerPath, "trusted-npm-cli.js");
  await Promise.all([
    mkdir(sourcePath),
    mkdir(workspacePath, { recursive: true }),
    writeFile(npmCli, "// trusted npm test fixture\n"),
  ]);
  await Promise.all([
    writeFile(path.join(workspacePath, ".gitignore"), "node_modules/\n"),
    writeFile(path.join(workspacePath, "package.json"), JSON.stringify({
      packageManager: "npm@10.9.3",
      engines: { node: ">=22.13.0" },
      devDependencies: { wrangler: "4.114.0" },
    })),
    writeFile(path.join(workspacePath, "package-lock.json"), JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { devDependencies: { wrangler: "4.114.0" } },
        "node_modules/wrangler": {
          version: "4.114.0",
          dependencies: { "wrangler-runtime-fixture": "1.0.0" },
          ...(optionalPeer ? {
            peerDependencies: { "optional-peer-fixture": "1.0.0" },
            peerDependenciesMeta: { "optional-peer-fixture": { optional: true } },
          } : {}),
        },
        "node_modules/wrangler/node_modules/wrangler-runtime-fixture": { version: "9.9.9" },
        "node_modules/wrangler-runtime-fixture": { version: "1.0.0" },
        ...(optionalPeer ? {
          "node_modules/optional-peer-fixture": { version: "1.0.0" },
        } : {}),
      },
    })),
  ]);
  runGit(workspacePath, ["init", "--initial-branch=main"]);
  runGit(workspacePath, ["config", "core.autocrlf", "false"]);
  runGit(workspacePath, ["add", "--", ".gitignore", "package.json", "package-lock.json"]);
  runGit(workspacePath, [
    "-c", "user.name=FundoSmart tests",
    "-c", "user.email=tests@fundosmart.invalid",
    "-c", "commit.gpgsign=false",
    "commit", "-m", "Exact tooling release",
  ]);
  const releaseSha = runGit(workspacePath, ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const workspace = Object.freeze({ rootPath, workspacePath, repositoryPath: sourcePath, releaseSha });
  t.after(() => rm(containerPath, { recursive: true, force: true }));
  return { containerPath, sourcePath, workspace, releaseSha, npmCli };
}

async function materializePinnedWrangler(workspacePath, { optionalPeer = false } = {}) {
  const wranglerRoot = path.join(workspacePath, "node_modules", "wrangler");
  const runtimeDependencyRoot = path.join(
    workspacePath,
    "node_modules",
    "wrangler-runtime-fixture",
  );
  await Promise.all([
    mkdir(path.join(wranglerRoot, "bin"), { recursive: true }),
    mkdir(path.join(wranglerRoot, "wrangler-dist"), { recursive: true }),
    mkdir(path.join(wranglerRoot, "assets", "node_modules"), { recursive: true }),
    mkdir(runtimeDependencyRoot, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(wranglerRoot, "package.json"), JSON.stringify({
      name: "wrangler",
      version: "4.114.0",
      bin: { wrangler: "./bin/wrangler.js" },
      main: "wrangler-dist/cli.js",
      dependencies: { "wrangler-runtime-fixture": "1.0.0" },
      ...(optionalPeer ? {
        peerDependencies: { "optional-peer-fixture": "1.0.0" },
        peerDependenciesMeta: { "optional-peer-fixture": { optional: true } },
      } : {}),
    })),
    writeFile(path.join(wranglerRoot, "bin", "wrangler.js"), "export const pinned = true;\n"),
    writeFile(
      path.join(wranglerRoot, "wrangler-dist", "cli.js"),
      "export const runtimePinned = true;\n",
    ),
    writeFile(
      path.join(wranglerRoot, "assets", "node_modules", "embedded.js"),
      "export const embeddedPinned = true;\n",
    ),
    writeFile(path.join(runtimeDependencyRoot, "package.json"), JSON.stringify({
      name: "wrangler-runtime-fixture",
      version: "1.0.0",
      main: "index.js",
    })),
    writeFile(
      path.join(runtimeDependencyRoot, "index.js"),
      "export const dependencyPinned = true;\n",
    ),
  ]);
}

function runGit(cwd, args, options = {}) {
  return execFileSync("git", args, {
    cwd,
    encoding: options.encoding,
    stdio: options.encoding ? ["ignore", "pipe", "pipe"] : "ignore",
  });
}

function baseHostEnvironment() {
  return Object.fromEntries([
    ["PATH", hostPath()],
    ["PATHEXT", process.env.PATHEXT],
    ["SYSTEMROOT", process.env.SystemRoot ?? process.env.SYSTEMROOT],
    ["WINDIR", process.env.WINDIR],
    ["LANG", process.env.LANG],
  ].filter(([, value]) => typeof value === "string"));
}

function hostPath() {
  return process.env.PATH ?? process.env.Path ?? "";
}

function isInside(parentPath, candidatePath) {
  const relativePath = path.relative(parentPath, candidatePath);
  return relativePath === ""
    || (!path.isAbsolute(relativePath)
      && relativePath !== ".."
      && !relativePath.startsWith(`..${path.sep}`));
}

function samePath(left, right) {
  return normalizedPath(left) === normalizedPath(right);
}

function normalizedPath(value) {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function escapeRegExp(value) {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
