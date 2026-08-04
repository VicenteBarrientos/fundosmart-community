import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { promisify, TextDecoder } from "node:util";

import {
  createDistSnapshot,
  digestDistTree,
  removeDistSnapshot,
} from "./self-hosting-attestation.mjs";

const RELEASE_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const GIT_OUTPUT_LIMIT = 32 * 1024 * 1024;
const RECOVERY_MAX_BYTES = 256 * 1024 * 1024;
const RECOVERY_MAX_ENTRIES = 100_000;
const ALLOWED_INHERITED_ENVIRONMENT_KEYS = Object.freeze([
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "COMSPEC",
  "TEMP",
  "TMP",
]);
const activeWorkspaces = new Map();
const execFileAsync = promisify(execFile);

export class SelfHostingGateWorkspaceError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "SelfHostingGateWorkspaceError";
  }
}

export async function createSelfHostingGateWorkspace({
  cwd = process.cwd(),
  releaseSha,
  temporaryParent,
} = {}) {
  const repositoryPath = await resolveGitRepositoryRoot(cwd);
  const canonicalReleaseSha = normalizeReleaseSha(releaseSha);
  const headSha = await readGitCommit(repositoryPath, "HEAD");
  if (headSha !== canonicalReleaseSha) {
    throw new SelfHostingGateWorkspaceError(
      "The gate workspace release SHA must equal the real HEAD of the source checkout.",
    );
  }
  const objectFormat = await readGitObjectFormat(repositoryPath);
  const expectedFiles = await readGitManifest(repositoryPath, canonicalReleaseSha, objectFormat);
  requireNoLocalStatePaths(expectedFiles);

  const requestedTemporaryParent = temporaryParent === undefined
    ? path.dirname(repositoryPath)
    : temporaryParent;
  const temporaryParentPath = await resolveExactDirectory(
    requestedTemporaryParent,
    "gate workspace temporary parent",
  );
  if (isPathInside(repositoryPath, temporaryParentPath)) {
    throw new SelfHostingGateWorkspaceError("The gate workspace temporary parent must be outside the repository.");
  }

  const rootPath = await mkdtemp(path.join(temporaryParentPath, "fundosmart-gate-workspace-"));
  const workspacePath = path.join(rootPath, "checkout");
  const hooksPath = path.join(rootPath, "empty-hooks");
  await chmod(rootPath, 0o700);
  await mkdir(hooksPath, { mode: 0o700 });

  let registered = false;
  try {
    await runGitBuffer(repositoryPath, [
      "-c",
      `core.hooksPath=${hooksPath}`,
      "worktree",
      "add",
      "--detach",
      "--no-checkout",
      workspacePath,
      canonicalReleaseSha,
    ]);
    registered = true;
    await materializeReleaseTree({
      repositoryPath,
      workspacePath,
      releaseSha: canonicalReleaseSha,
      objectFormat,
      expectedFiles,
    });
    await verifyMaterializedWorkspace({
      repositoryPath,
      workspacePath,
      releaseSha: canonicalReleaseSha,
      objectFormat,
      expectedFiles,
    });

    const workspace = Object.freeze({
      rootPath,
      workspacePath,
      repositoryPath,
      releaseSha: canonicalReleaseSha,
    });
    activeWorkspaces.set(workspacePath, {
      workspace,
      registered: true,
    });
    return workspace;
  } catch (error) {
    const cleanupErrors = [];
    let registrationKnown = registered;
    if (!registrationKnown) {
      try {
        registered = await isRegisteredWorktree(repositoryPath, workspacePath);
        registrationKnown = true;
      } catch (inspectionError) {
        cleanupErrors.push(inspectionError);
      }
    }
    const gitRemovalWasRequired = registered;
    if (registered) {
      try {
        await runGitBuffer(repositoryPath, ["worktree", "remove", "--force", workspacePath]);
        registered = false;
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    let workspaceRemovalConfirmed = false;
    if (registrationKnown && !registered) {
      try {
        workspaceRemovalConfirmed = !gitRemovalWasRequired || !(await pathExists(workspacePath));
        if (gitRemovalWasRequired && !workspaceRemovalConfirmed) {
          cleanupErrors.push(new SelfHostingGateWorkspaceError(
            "Git registration is gone but the failed gate workspace still exists; refusing raw cleanup.",
          ));
        }
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (workspaceRemovalConfirmed) {
      try {
        await rm(rootPath, { recursive: true, force: true });
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        `Gate workspace creation failed and cleanup did not complete at ${workspacePath}.`,
      );
    }
    throw error;
  }
}

export async function removeSelfHostingGateWorkspace(workspace) {
  const state = requireActiveWorkspace(workspace);
  if (state.registered) {
    await runGitBuffer(state.workspace.repositoryPath, [
      "worktree",
      "remove",
      "--force",
      state.workspace.workspacePath,
    ]);
    state.registered = false;
  }
  if (await pathExists(state.workspace.workspacePath)) {
    throw new SelfHostingGateWorkspaceError(
      "Git reported successful worktree removal but the workspace path still exists; refusing raw recursive cleanup.",
    );
  }
  await rm(state.workspace.rootPath, { recursive: true, force: true });
  activeWorkspaces.delete(state.workspace.workspacePath);
  return true;
}

export async function publishGateDist({ cwd = process.cwd(), sourceDistPath } = {}) {
  const repositoryPath = await resolveGitRepositoryRoot(cwd);
  const resolvedSourcePath = resolveRequiredPath(sourceDistPath, "gate dist source path");
  const state = [...activeWorkspaces.values()].find((candidate) => (
    sameResolvedPath(
      path.resolve(candidate.workspace.workspacePath, "dist"),
      resolvedSourcePath,
    )
  ));
  if (!state || !state.registered || !sameResolvedPath(state.workspace.repositoryPath, repositoryPath)) {
    throw new SelfHostingGateWorkspaceError(
      "sourceDistPath must be the dist directory of an active gate workspace for this repository.",
    );
  }

  const workspaceRealPath = await resolveExactDirectory(
    state.workspace.workspacePath,
    "active gate workspace",
  );
  await verifyActiveWorkspaceForPublish({
    repositoryPath,
    workspaceRealPath,
    releaseSha: state.workspace.releaseSha,
  });
  const sourceRealPath = await resolveExactDirectory(resolvedSourcePath, "gate dist source");
  if (!sameResolvedPath(sourceRealPath, resolvedSourcePath)
    || path.basename(sourceRealPath).toLowerCase() !== "dist") {
    throw new SelfHostingGateWorkspaceError("The gate dist source must be an exact, non-linked dist directory.");
  }
  if (!sameResolvedPath(path.dirname(sourceRealPath), workspaceRealPath)) {
    throw new SelfHostingGateWorkspaceError("The gate dist source must be directly inside its active workspace.");
  }

  const canonicalDistPath = path.join(repositoryPath, "dist");
  const existingDist = await inspectOptionalDirectory(canonicalDistPath, "canonical dist");
  let previousDistRecovery;
  if (existingDist) {
    await validateRegularTree(canonicalDistPath, "canonical dist");
    previousDistRecovery = await capturePreviousDist(canonicalDistPath);
  }

  const repositoryParent = path.dirname(repositoryPath);
  const stagingPath = path.join(repositoryParent, `.fundosmart-dist-staging-${randomUUID()}`);
  const rollbackPath = path.join(repositoryParent, `.fundosmart-dist-rollback-${randomUUID()}`);
  const recoveryStagingPath = path.join(
    repositoryParent,
    `.fundosmart-dist-recovery-${randomUUID()}`,
  );
  await requireAbsentPath(stagingPath, "dist staging path");
  await requireAbsentPath(rollbackPath, "dist rollback path");
  await requireAbsentPath(recoveryStagingPath, "dist recovery staging path");

  let snapshot;
  let publishedArtifact;
  let stagingPrepared = false;
  try {
    snapshot = await createDistSnapshot({
      distPath: sourceRealPath,
      temporaryParent: repositoryParent,
    });
    publishedArtifact = Object.freeze({
      artifactSha256: snapshot.artifactSha256,
      fileCount: snapshot.fileCount,
    });
    await rename(snapshot.distPath, stagingPath);
    stagingPrepared = true;
    await removeDistSnapshot(snapshot);
    snapshot = undefined;
    const stagedArtifact = await digestDistTree({ distPath: stagingPath });
    if (!samePublishedArtifact(stagedArtifact, publishedArtifact)) {
      throw new SelfHostingGateWorkspaceError(
        "The staged gate dist no longer matches its stable source snapshot.",
      );
    }
    await requireRepositoryReleaseHead(
      repositoryPath,
      state.workspace.releaseSha,
      "The source checkout HEAD changed while the gate dist was staged.",
    );
  } catch (error) {
    const cleanupErrors = [];
    if (snapshot) {
      try {
        await removeDistSnapshot(snapshot);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (stagingPrepared) {
      try {
        await validateRegularTree(stagingPath, "dist staging tree");
        await rm(stagingPath, { recursive: true, force: true });
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError([error, ...cleanupErrors], "Gate dist staging or cleanup failed.");
    }
    throw error;
  }

  let rollbackCreated = false;
  let canonicalPublished = false;
  let recoveryPrepared = false;
  try {
    if (existingDist) {
      await rename(canonicalDistPath, rollbackPath);
      rollbackCreated = true;
    }
    await rename(stagingPath, canonicalDistPath);
    stagingPrepared = false;
    canonicalPublished = true;
    const canonicalArtifact = await digestDistTree({ distPath: canonicalDistPath });
    if (!samePublishedArtifact(canonicalArtifact, publishedArtifact)) {
      throw new SelfHostingGateWorkspaceError(
        "The canonical gate dist changed during transactional publication.",
      );
    }
    await requireRepositoryReleaseHead(
      repositoryPath,
      state.workspace.releaseSha,
      "The source checkout HEAD changed during transactional dist publication.",
    );
  } catch (publishError) {
    const recoveryErrors = [];
    if (canonicalPublished) {
      try {
        await rename(canonicalDistPath, stagingPath);
        canonicalPublished = false;
        stagingPrepared = true;
      } catch (quarantineError) {
        recoveryErrors.push(quarantineError);
      }
    }
    if (!canonicalPublished && rollbackCreated) {
      let rollbackMoved = false;
      try {
        await rename(rollbackPath, canonicalDistPath);
        rollbackMoved = true;
        rollbackCreated = false;
        if (previousDistRecovery) await verifyPreviousDist(canonicalDistPath, previousDistRecovery);
      } catch (rollbackError) {
        recoveryErrors.push(rollbackError);
        if (rollbackMoved) {
          try {
            await rename(canonicalDistPath, rollbackPath);
            rollbackCreated = true;
          } catch (quarantineRollbackError) {
            recoveryErrors.push(quarantineRollbackError);
          }
        }
      }
    }
    if (!recoveryErrors.length && stagingPrepared) {
      try {
        await validateRegularTree(stagingPath, "dist staging tree");
        await rm(stagingPath, { recursive: true, force: true });
        stagingPrepared = false;
      } catch (cleanupError) {
        recoveryErrors.push(cleanupError);
      }
    }
    if (recoveryErrors.length > 0) {
      const recoveryStagingRetained = await pathExists(recoveryStagingPath);
      const aggregate = new AggregateError(
        [publishError, ...recoveryErrors],
        "Publishing gate dist failed and automatic rollback did not complete.",
      );
      aggregate.recoveryPaths = Object.freeze({
        canonicalDistPath,
        rollbackPath: rollbackCreated ? rollbackPath : undefined,
        recoveryStagingPath: recoveryStagingRetained ? recoveryStagingPath : undefined,
        stagingPath: stagingPrepared ? stagingPath : undefined,
      });
      throw aggregate;
    }
    throw publishError;
  }

  if (rollbackCreated) {
    try {
      await preparePreviousDistRecovery({
        recoveryStagingPath,
        recovery: previousDistRecovery,
      });
      recoveryPrepared = true;
    } catch (preparationError) {
      const errors = [preparationError];
      try {
        await verifyPreviousDist(rollbackPath, previousDistRecovery);
      } catch (rollbackVerificationError) {
        errors.push(rollbackVerificationError);
      }
      const recoveryStagingRetained = await pathExists(recoveryStagingPath);
      const error = errors.length === 1
        ? new SelfHostingGateWorkspaceError(
          "Could not prepare the verified prior-dist recovery tree; the exact rollback was retained.",
          { cause: preparationError },
        )
        : new AggregateError(
          errors,
          "Prior-dist recovery preparation failed and the rollback could not be reverified.",
        );
      error.recoveryPaths = Object.freeze({
        canonicalDistPath,
        recoveryStagingPath: recoveryStagingRetained ? recoveryStagingPath : undefined,
        rollbackPath,
      });
      throw error;
    }
  }

  if (rollbackCreated && recoveryPrepared) {
    try {
      await verifyPreviousDist(rollbackPath, previousDistRecovery);
    } catch (rollbackVerificationError) {
      const restorationErrors = [];
      try {
        await rename(canonicalDistPath, stagingPath);
        stagingPrepared = true;
        canonicalPublished = false;
      } catch (quarantineError) {
        restorationErrors.push(quarantineError);
      }
      if (!canonicalPublished) {
        try {
          await activatePreparedRecovery({
            canonicalDistPath,
            recoveryStagingPath,
            recovery: previousDistRecovery,
          });
          recoveryPrepared = false;
        } catch (restoreError) {
          restorationErrors.push(restoreError);
        }
      }
      if (restorationErrors.length > 0) {
        const aggregate = new AggregateError(
          [rollbackVerificationError, ...restorationErrors],
          "Rollback verification failed and the prepared prior dist could not be restored.",
        );
        aggregate.recoveryPaths = Object.freeze({
          canonicalDistPath,
          recoveryStagingPath: await pathExists(recoveryStagingPath)
            ? recoveryStagingPath
            : undefined,
          rollbackPath,
          stagingPath: stagingPrepared ? stagingPath : undefined,
        });
        throw aggregate;
      }
      const error = new SelfHostingGateWorkspaceError(
        "Rollback verification failed; the exact prior dist was restored and the candidate was quarantined.",
        { cause: rollbackVerificationError },
      );
      error.recoveryPaths = Object.freeze({
        canonicalDistPath,
        rollbackPath,
        stagingPath,
      });
      throw error;
    }
  }

  if (rollbackCreated) {
    try {
      await verifyPreviousDist(rollbackPath, previousDistRecovery);
      await rm(rollbackPath, { recursive: true, force: true });
      rollbackCreated = false;
    } catch (cleanupError) {
      const restorationErrors = [];
      try {
        await rename(canonicalDistPath, stagingPath);
        stagingPrepared = true;
        canonicalPublished = false;
      } catch (quarantineError) {
        restorationErrors.push(quarantineError);
      }
      if (!canonicalPublished) {
        try {
          await activatePreparedRecovery({
            canonicalDistPath,
            recoveryStagingPath,
            recovery: previousDistRecovery,
          });
          recoveryPrepared = false;
        } catch (restoreError) {
          restorationErrors.push(restoreError);
        }
      }
      if (restorationErrors.length > 0) {
        const aggregate = new AggregateError(
          [cleanupError, ...restorationErrors],
          "Rollback cleanup failed and the prior canonical dist could not be restored atomically.",
        );
        aggregate.recoveryPaths = Object.freeze({
          canonicalDistPath,
          recoveryStagingPath: await pathExists(recoveryStagingPath)
            ? recoveryStagingPath
            : undefined,
          rollbackPath,
          stagingPath: stagingPrepared ? stagingPath : undefined,
        });
        throw aggregate;
      }
      const error = new SelfHostingGateWorkspaceError(
        `Rollback cleanup failed at ${rollbackPath}; the prior dist was restored and the candidate is quarantined.`,
        { cause: cleanupError },
      );
      error.recoveryPaths = Object.freeze({
        canonicalDistPath,
        rollbackPath,
        stagingPath,
      });
      throw error;
    }
  }

  await requireFinalPublishedArtifact({
    canonicalDistPath,
    stagingPath,
    publishedArtifact,
    repositoryPath,
    releaseSha: state.workspace.releaseSha,
    previousDistRecovery,
    recoveryStagingPath,
    recoveryPrepared,
  });

  if (recoveryPrepared) {
    try {
      await verifyPreviousDist(recoveryStagingPath, previousDistRecovery);
      await rm(recoveryStagingPath, { recursive: true, force: true });
      recoveryPrepared = false;
    } catch (cleanupError) {
      const error = new SelfHostingGateWorkspaceError(
        `Published gate dist is valid, but verified recovery cleanup failed at ${recoveryStagingPath}.`,
        { cause: cleanupError },
      );
      error.recoveryPaths = Object.freeze({
        canonicalDistPath,
        recoveryStagingPath,
      });
      throw error;
    }
  }

  return Object.freeze({
    distPath: canonicalDistPath,
    artifactSha256: publishedArtifact.artifactSha256,
    fileCount: publishedArtifact.fileCount,
  });
}

function samePublishedArtifact(left, right) {
  return left.artifactSha256 === right.artifactSha256
    && left.fileCount === right.fileCount;
}

async function requireFinalPublishedArtifact({
  canonicalDistPath,
  stagingPath,
  publishedArtifact,
  repositoryPath,
  releaseSha,
  previousDistRecovery,
  recoveryStagingPath,
  recoveryPrepared,
}) {
  let verificationError;
  try {
    await requireRepositoryReleaseHead(
      repositoryPath,
      releaseSha,
      "The source checkout HEAD changed before publication completed.",
    );
    const finalArtifact = await digestDistTree({ distPath: canonicalDistPath });
    await requireRepositoryReleaseHead(
      repositoryPath,
      releaseSha,
      "The source checkout HEAD changed during final artifact verification.",
    );
    if (samePublishedArtifact(finalArtifact, publishedArtifact)) return;
    verificationError = new SelfHostingGateWorkspaceError(
      "The canonical gate dist changed before publication completed.",
    );
  } catch (error) {
    verificationError = error;
  }

  try {
    await rename(canonicalDistPath, stagingPath);
  } catch (quarantineError) {
    const aggregate = new AggregateError(
      [verificationError, quarantineError],
      "Final gate dist verification failed and the changed canonical artifact could not be quarantined.",
    );
    aggregate.recoveryPaths = Object.freeze({ canonicalDistPath });
    throw aggregate;
  }

  if (previousDistRecovery && recoveryPrepared) {
    try {
      await activatePreparedRecovery({
        canonicalDistPath,
        recoveryStagingPath,
        recovery: previousDistRecovery,
      });
    } catch (restoreError) {
      const aggregate = new AggregateError(
        [verificationError, restoreError],
        "Final gate dist verification failed and the prior canonical dist could not be restored.",
      );
      aggregate.recoveryPaths = Object.freeze({
        canonicalDistPath,
        recoveryStagingPath,
        stagingPath,
      });
      throw aggregate;
    }
    const error = new SelfHostingGateWorkspaceError(
      `Final gate dist verification failed; the prior dist was restored and the changed artifact is quarantined at ${stagingPath}.`,
      { cause: verificationError },
    );
    error.recoveryPaths = Object.freeze({
      canonicalDistPath,
      stagingPath,
    });
    throw error;
  }

  const error = new SelfHostingGateWorkspaceError(
    `Final gate dist verification failed; the changed artifact is quarantined at ${stagingPath}.`,
    { cause: verificationError },
  );
  error.recoveryPaths = Object.freeze({ stagingPath });
  throw error;
}

async function requireRepositoryReleaseHead(repositoryPath, releaseSha, message) {
  if (await readGitCommit(repositoryPath, "HEAD") !== releaseSha) {
    throw new SelfHostingGateWorkspaceError(message);
  }
}

async function materializeReleaseTree({
  repositoryPath,
  workspacePath,
  releaseSha,
  objectFormat,
  expectedFiles,
}) {
  await runGitBuffer(workspacePath, ["read-tree", "--reset", releaseSha]);
  for (const directoryPath of expectedDirectoryPaths(expectedFiles.map((file) => file.relativePath))) {
    await mkdir(path.join(workspacePath, ...directoryPath.split("/")), { mode: 0o700 });
  }
  for (const expected of expectedFiles) {
    const bytes = await runGitBuffer(repositoryPath, ["cat-file", "blob", expected.objectId]);
    if (gitBlobObjectId(bytes, objectFormat) !== expected.objectId) {
      throw new SelfHostingGateWorkspaceError(
        `Git returned bytes that do not match release blob ${expected.objectId}.`,
      );
    }
    const destinationPath = path.join(workspacePath, ...expected.relativePath.split("/"));
    let handle;
    try {
      handle = await open(
        destinationPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
        expected.mode === "100755" ? 0o755 : 0o644,
      );
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.chmod(expected.mode === "100755" ? 0o755 : 0o644);
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
}

async function verifyMaterializedWorkspace({
  repositoryPath,
  workspacePath,
  releaseSha,
  objectFormat,
  expectedFiles,
}) {
  const workspaceRealPath = await realpath(workspacePath);
  await verifyWorktreeGitMetadata({ repositoryPath, workspaceRealPath });
  const reportedRoot = await runGitText(workspacePath, ["rev-parse", "--show-toplevel"]);
  const workspaceHead = await readGitCommit(workspacePath, "HEAD");
  const workspaceObjectFormat = await readGitObjectFormat(workspacePath);
  if (!sameResolvedPath(workspaceRealPath, await realpath(path.resolve(workspacePath, reportedRoot)))) {
    throw new SelfHostingGateWorkspaceError("The materialized gate checkout did not resolve to its own worktree root.");
  }
  if (workspaceHead !== releaseSha) {
    throw new SelfHostingGateWorkspaceError("The materialized gate checkout HEAD does not match releaseSha.");
  }
  if (await readGitHeadName(workspacePath) !== "HEAD") {
    throw new SelfHostingGateWorkspaceError("The materialized gate checkout HEAD is not detached.");
  }
  if (workspaceObjectFormat !== objectFormat) {
    throw new SelfHostingGateWorkspaceError("The materialized gate checkout uses an unexpected object format.");
  }

  const before = await collectWorkspaceTree(workspaceRealPath);
  requireExactWorkspaceStructure(before, expectedFiles);
  for (let index = 0; index < expectedFiles.length; index += 1) {
    const expected = expectedFiles[index];
    const actual = before.files[index];
    const bytes = await readStableRegularFile(actual.fullPath, actual.relativePath, expected.mode);
    if (gitBlobObjectId(bytes, objectFormat) !== expected.objectId) {
      throw new SelfHostingGateWorkspaceError(
        `Gate workspace file ${actual.relativePath} does not contain the bytes from ${releaseSha}.`,
      );
    }
  }

  const indexFiles = await readGitIndexManifest(workspacePath, objectFormat);
  const finalHead = await readGitCommit(workspacePath, "HEAD");
  const finalHeadName = await readGitHeadName(workspacePath);
  const sourceHead = await readGitCommit(repositoryPath, "HEAD");
  const after = await collectWorkspaceTree(workspaceRealPath);
  if (!sameTreeManifest(before, after)) {
    throw new SelfHostingGateWorkspaceError("The gate workspace changed while its release bytes were verified.");
  }
  if (finalHead !== releaseSha
    || finalHeadName !== "HEAD"
    || sourceHead !== releaseSha
    || !sameGitManifest(indexFiles, expectedFiles)) {
    throw new SelfHostingGateWorkspaceError("The materialized gate workspace is not clean at the exact release SHA.");
  }
}

async function verifyWorktreeGitMetadata({ repositoryPath, workspaceRealPath }) {
  const markerPath = path.join(workspaceRealPath, ".git");
  const markerBytes = await readStableRegularFile(markerPath, ".git metadata");
  let marker;
  try {
    marker = new TextDecoder("utf-8", { fatal: true }).decode(markerBytes);
  } catch (error) {
    throw new SelfHostingGateWorkspaceError("The gate worktree .git metadata is not valid UTF-8.", {
      cause: error,
    });
  }
  const match = /^gitdir: ([^\0\r\n]+)\r?\n$/u.exec(marker);
  if (!match) {
    throw new SelfHostingGateWorkspaceError("The gate worktree does not contain canonical .git metadata.");
  }

  const declaredGitDirectory = await realpath(path.resolve(workspaceRealPath, match[1]));
  const reportedGitDirectory = await realpath(path.resolve(
    workspaceRealPath,
    await runGitText(workspaceRealPath, ["rev-parse", "--git-dir"]),
  ));
  if (!sameResolvedPath(declaredGitDirectory, reportedGitDirectory)) {
    throw new SelfHostingGateWorkspaceError("The gate worktree .git metadata does not match Git's directory.");
  }

  const repositoryCommonDirectory = await realpath(path.resolve(
    repositoryPath,
    await runGitText(repositoryPath, ["rev-parse", "--git-common-dir"]),
  ));
  const workspaceCommonDirectory = await realpath(path.resolve(
    workspaceRealPath,
    await runGitText(workspaceRealPath, ["rev-parse", "--git-common-dir"]),
  ));
  if (!sameResolvedPath(repositoryCommonDirectory, workspaceCommonDirectory)) {
    throw new SelfHostingGateWorkspaceError("The gate worktree is not attached to the expected Git repository.");
  }
}

async function verifyActiveWorkspaceForPublish({ repositoryPath, workspaceRealPath, releaseSha }) {
  await verifyWorktreeGitMetadata({ repositoryPath, workspaceRealPath });
  const sourceHeadBefore = await readGitCommit(repositoryPath, "HEAD");
  if (sourceHeadBefore !== releaseSha) {
    throw new SelfHostingGateWorkspaceError("The source checkout HEAD changed before dist publication.");
  }
  const reportedRoot = await realpath(path.resolve(
    workspaceRealPath,
    await runGitText(workspaceRealPath, ["rev-parse", "--show-toplevel"]),
  ));
  if (!sameResolvedPath(reportedRoot, workspaceRealPath)) {
    throw new SelfHostingGateWorkspaceError("The active gate workspace no longer resolves to its registered root.");
  }
  const headBefore = await readGitCommit(workspaceRealPath, "HEAD");
  if (headBefore !== releaseSha) {
    throw new SelfHostingGateWorkspaceError("The active gate workspace HEAD changed before dist publication.");
  }
  if (await readGitHeadName(workspaceRealPath) !== "HEAD") {
    throw new SelfHostingGateWorkspaceError("The active gate workspace HEAD is no longer detached.");
  }

  const objectFormat = await readGitObjectFormat(workspaceRealPath);
  const expectedFiles = await readGitManifest(repositoryPath, releaseSha, objectFormat);
  for (const expected of expectedFiles) {
    const filePath = path.join(workspaceRealPath, ...expected.relativePath.split("/"));
    const bytes = await readStableRegularFile(filePath, expected.relativePath, expected.mode);
    if (gitBlobObjectId(bytes, objectFormat) !== expected.objectId) {
      throw new SelfHostingGateWorkspaceError(
        `Tracked gate workspace file ${expected.relativePath} changed before dist publication.`,
      );
    }
  }

  const headAfter = await readGitCommit(workspaceRealPath, "HEAD");
  const headNameAfter = await readGitHeadName(workspaceRealPath);
  const sourceHeadAfter = await readGitCommit(repositoryPath, "HEAD");
  if (headAfter !== releaseSha || headNameAfter !== "HEAD" || sourceHeadAfter !== releaseSha) {
    throw new SelfHostingGateWorkspaceError("The active gate workspace HEAD changed during dist verification.");
  }
}

async function collectWorkspaceTree(rootPath) {
  const rootStats = await requireDirectory(rootPath, "gate workspace root");
  const directories = [];
  const files = [];
  const normalizedPaths = new Set();

  async function visit(directoryPath, segments) {
    const beforeStats = await requireDirectory(directoryPath, "gate workspace directory");
    let entries = await readdir(directoryPath, { withFileTypes: true });
    entries = entries.sort((left, right) => compareUtf8(left.name, right.name));
    for (const entry of entries) {
      if (segments.length === 0 && entry.name === ".git") continue;
      const segment = normalizeFilesystemSegment(entry.name);
      const relativePath = [...segments, segment].join("/");
      if (normalizedPaths.has(relativePath)) {
        throw new SelfHostingGateWorkspaceError(`Gate workspace path collision at ${relativePath}.`);
      }
      normalizedPaths.add(relativePath);
      const fullPath = path.join(directoryPath, entry.name);
      const stats = await lstat(fullPath, { bigint: true });
      if (stats.isSymbolicLink()) {
        throw new SelfHostingGateWorkspaceError(`Gate workspace contains a link at ${relativePath}.`);
      }
      if (stats.isDirectory()) {
        directories.push({ fullPath, relativePath, stats });
        await visit(fullPath, [...segments, segment]);
      } else if (stats.isFile()) {
        files.push({ fullPath, relativePath, stats });
      } else {
        throw new SelfHostingGateWorkspaceError(`Gate workspace contains a special entry at ${relativePath}.`);
      }
    }
    const afterStats = await requireDirectory(directoryPath, "gate workspace directory");
    if (!sameStableStats(beforeStats, afterStats)) {
      throw new SelfHostingGateWorkspaceError("A gate workspace directory changed during traversal.");
    }
  }

  await visit(rootPath, []);
  directories.sort((left, right) => compareUtf8(left.relativePath, right.relativePath));
  files.sort((left, right) => compareUtf8(left.relativePath, right.relativePath));
  return { rootStats, directories, files };
}

async function validateRegularTree(rootPath, label) {
  const before = await collectRegularTreeForValidation(rootPath, label);
  const after = await collectRegularTreeForValidation(rootPath, label);
  if (!sameTreeManifest(before, after)) {
    throw new SelfHostingGateWorkspaceError(`The ${label} changed during validation.`);
  }
}

async function collectRegularTreeForValidation(rootPath, label) {
  const rootStats = await requireDirectory(rootPath, label);
  const directories = [];
  const files = [];

  async function visit(directoryPath, segments) {
    const directoryBefore = await requireDirectory(directoryPath, label);
    let entries = await readdir(directoryPath, { withFileTypes: true });
    entries = entries.sort((left, right) => compareUtf8(left.name, right.name));
    for (const entry of entries) {
      const segment = normalizeFilesystemSegment(entry.name);
      const relativePath = [...segments, segment].join("/");
      const fullPath = path.join(directoryPath, entry.name);
      const stats = await lstat(fullPath, { bigint: true });
      if (stats.isSymbolicLink()) {
        throw new SelfHostingGateWorkspaceError(`The ${label} contains a link at ${fullPath}.`);
      }
      if (stats.isDirectory()) {
        directories.push({ fullPath, relativePath, stats });
        await visit(fullPath, [...segments, segment]);
      } else if (stats.isFile()) {
        files.push({ fullPath, relativePath, stats });
      } else {
        throw new SelfHostingGateWorkspaceError(`The ${label} contains a special filesystem entry.`);
      }
    }
    const directoryAfter = await requireDirectory(directoryPath, label);
    if (!sameStableStats(directoryBefore, directoryAfter)) {
      throw new SelfHostingGateWorkspaceError(`The ${label} changed during validation.`);
    }
  }

  await visit(rootPath, []);
  directories.sort((left, right) => compareUtf8(left.relativePath, right.relativePath));
  files.sort((left, right) => compareUtf8(left.relativePath, right.relativePath));
  return { rootStats, directories, files };
}

async function capturePreviousDist(rootPath) {
  const before = await collectRegularTreeForValidation(rootPath, "canonical dist recovery source");
  const entryCount = before.directories.length + before.files.length;
  if (entryCount > RECOVERY_MAX_ENTRIES) {
    throw new SelfHostingGateWorkspaceError(
      `The previous canonical dist exceeds the ${RECOVERY_MAX_ENTRIES}-entry recovery limit.`,
    );
  }
  const totalBytes = before.files.reduce((total, file) => total + file.stats.size, 0n);
  if (totalBytes > BigInt(RECOVERY_MAX_BYTES)) {
    throw new SelfHostingGateWorkspaceError(
      `The previous canonical dist exceeds the ${RECOVERY_MAX_BYTES}-byte in-memory recovery limit.`,
    );
  }
  const artifactBefore = await digestDistTree({ distPath: rootPath });

  const directories = before.directories.map((directory) => Object.freeze({
    relativePath: directory.relativePath,
    mode: permissionMode(directory.stats),
  }));
  const files = [];
  for (const file of before.files) {
    const bytes = await readStableRegularFile(file.fullPath, `recovery file ${file.relativePath}`);
    if (BigInt(bytes.byteLength) !== file.stats.size) {
      throw new SelfHostingGateWorkspaceError(
        `Canonical dist recovery file ${file.relativePath} changed during capture.`,
      );
    }
    files.push(Object.freeze({
      relativePath: file.relativePath,
      mode: permissionMode(file.stats),
      bytes,
    }));
  }

  const after = await collectRegularTreeForValidation(rootPath, "canonical dist recovery source");
  const artifactAfter = await digestDistTree({ distPath: rootPath });
  if (!sameTreeManifest(before, after) || !samePublishedArtifact(artifactBefore, artifactAfter)) {
    throw new SelfHostingGateWorkspaceError("The previous canonical dist changed during recovery capture.");
  }
  return Object.freeze({
    rootMode: permissionMode(before.rootStats),
    directories: Object.freeze(directories),
    files: Object.freeze(files),
    artifact: artifactBefore,
  });
}

async function preparePreviousDistRecovery({ recoveryStagingPath, recovery }) {
  await requireAbsentPath(recoveryStagingPath, "canonical dist recovery staging path");
  await mkdir(recoveryStagingPath, { mode: 0o700 });
  try {
    const directories = [...recovery.directories].sort(compareRecoveryDepth);
    for (const directory of directories) {
      await mkdir(path.join(recoveryStagingPath, ...directory.relativePath.split("/")), { mode: 0o700 });
    }
    for (const file of recovery.files) {
      const destinationPath = path.join(recoveryStagingPath, ...file.relativePath.split("/"));
      let handle;
      try {
        handle = await open(
          destinationPath,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
          0o600,
        );
        await handle.writeFile(file.bytes);
        await handle.sync();
        await handle.chmod(file.mode);
      } finally {
        await handle?.close().catch(() => undefined);
      }
    }
    for (const directory of [...directories].reverse()) {
      await chmod(path.join(recoveryStagingPath, ...directory.relativePath.split("/")), directory.mode);
    }
    await chmod(recoveryStagingPath, recovery.rootMode);
    await verifyPreviousDist(recoveryStagingPath, recovery);
  } catch (error) {
    if (error instanceof SelfHostingGateWorkspaceError) throw error;
    throw new SelfHostingGateWorkspaceError("Could not restore the prior canonical dist exactly.", {
      cause: error,
    });
  }
}

async function activatePreparedRecovery({ canonicalDistPath, recoveryStagingPath, recovery }) {
  await requireAbsentPath(canonicalDistPath, "canonical dist recovery destination");
  await verifyPreviousDist(recoveryStagingPath, recovery);
  await rename(recoveryStagingPath, canonicalDistPath);
}

async function verifyPreviousDist(rootPath, recovery) {
  const restoredTree = await collectRegularTreeForValidation(rootPath, "restored canonical dist");
  if (!sameRecoveryTree(restoredTree, recovery)) {
    throw new SelfHostingGateWorkspaceError("The restored canonical dist structure or modes do not match.");
  }
  const restoredArtifact = await digestDistTree({ distPath: rootPath });
  if (!samePublishedArtifact(restoredArtifact, recovery.artifact)) {
    throw new SelfHostingGateWorkspaceError("The restored canonical dist digest does not match the prior dist.");
  }
  for (let index = 0; index < recovery.files.length; index += 1) {
    const expected = recovery.files[index];
    const actual = restoredTree.files[index];
    const bytes = await readStableRegularFile(actual.fullPath, `restored file ${actual.relativePath}`);
    if (!bytes.equals(expected.bytes)) {
      throw new SelfHostingGateWorkspaceError(
        `Restored canonical dist file ${actual.relativePath} does not match its prior bytes.`,
      );
    }
  }
}

function sameRecoveryTree(actual, recovery) {
  return permissionMode(actual.rootStats) === recovery.rootMode
    && actual.directories.length === recovery.directories.length
    && actual.files.length === recovery.files.length
    && actual.directories.every((directory, index) => (
      directory.relativePath === recovery.directories[index].relativePath
      && permissionMode(directory.stats) === recovery.directories[index].mode
    ))
    && actual.files.every((file, index) => (
      file.relativePath === recovery.files[index].relativePath
      && permissionMode(file.stats) === recovery.files[index].mode
    ));
}

function permissionMode(stats) {
  return Number(stats.mode & 0o777n);
}

function compareRecoveryDepth(left, right) {
  const depthDifference = left.relativePath.split("/").length - right.relativePath.split("/").length;
  return depthDifference || compareUtf8(left.relativePath, right.relativePath);
}

async function readGitManifest(repositoryPath, releaseSha, objectFormat) {
  const output = await runGitBuffer(repositoryPath, [
    "ls-tree",
    "-r",
    "-z",
    "--full-tree",
    releaseSha,
  ]);
  const records = splitNullRecords(output, "Git release manifest");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const entries = [];
  const paths = new Set();
  for (const record of records) {
    const separator = record.indexOf(0x09);
    if (separator < 0) throw new SelfHostingGateWorkspaceError("Git returned a malformed release entry.");
    const header = record.subarray(0, separator).toString("ascii");
    const match = /^(100644|100755) blob ([0-9a-f]+)$/u.exec(header);
    if (!match) {
      throw new SelfHostingGateWorkspaceError("The release tree may contain only regular tracked files.");
    }
    const [, mode, objectId] = match;
    const expectedLength = objectFormat === "sha1" ? 40 : 64;
    if (objectId.length !== expectedLength) {
      throw new SelfHostingGateWorkspaceError("Git returned an object ID with the wrong length.");
    }
    let relativePath;
    try {
      relativePath = decoder.decode(record.subarray(separator + 1));
    } catch (error) {
      throw new SelfHostingGateWorkspaceError("The release contains a non-UTF-8 path.", { cause: error });
    }
    const canonicalPath = normalizeRelativePath(relativePath);
    if (relativePath !== canonicalPath || paths.has(canonicalPath)) {
      throw new SelfHostingGateWorkspaceError(`The release contains a colliding path at ${relativePath}.`);
    }
    paths.add(canonicalPath);
    entries.push({ relativePath: canonicalPath, objectId, mode });
  }
  entries.sort((left, right) => compareUtf8(left.relativePath, right.relativePath));
  if (entries.length === 0) throw new SelfHostingGateWorkspaceError("The release tree contains no files.");
  return entries;
}

async function readGitIndexManifest(workspacePath, objectFormat) {
  const output = await runGitBuffer(workspacePath, ["ls-files", "--stage", "-z"]);
  const records = splitNullRecords(output, "Git index manifest");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const entries = [];
  for (const record of records) {
    const separator = record.indexOf(0x09);
    if (separator < 0) throw new SelfHostingGateWorkspaceError("Git returned a malformed index entry.");
    const header = record.subarray(0, separator).toString("ascii");
    const match = /^(100644|100755) ([0-9a-f]+) 0$/u.exec(header);
    if (!match) {
      throw new SelfHostingGateWorkspaceError("The gate worktree index contains an unsupported entry.");
    }
    const [, mode, objectId] = match;
    const expectedLength = objectFormat === "sha1" ? 40 : 64;
    if (objectId.length !== expectedLength) {
      throw new SelfHostingGateWorkspaceError("Git returned an index object ID with the wrong length.");
    }
    let relativePath;
    try {
      relativePath = decoder.decode(record.subarray(separator + 1));
    } catch (error) {
      throw new SelfHostingGateWorkspaceError("The Git index contains a non-UTF-8 path.", {
        cause: error,
      });
    }
    const canonicalPath = normalizeRelativePath(relativePath);
    if (relativePath !== canonicalPath) {
      throw new SelfHostingGateWorkspaceError(`The Git index contains a non-canonical path at ${relativePath}.`);
    }
    entries.push({ relativePath: canonicalPath, objectId, mode });
  }
  entries.sort((left, right) => compareUtf8(left.relativePath, right.relativePath));
  return entries;
}

function sameGitManifest(left, right) {
  return left.length === right.length && left.every((entry, index) => (
    entry.relativePath === right[index].relativePath
    && entry.objectId === right[index].objectId
    && entry.mode === right[index].mode
  ));
}

function requireNoLocalStatePaths(expectedFiles) {
  for (const { relativePath } of expectedFiles) {
    const segments = relativePath.split("/");
    const forbiddenSegment = segments.find((segment) => {
      const normalized = segment.toLowerCase();
      return normalized === ".wrangler"
        || (normalized.startsWith(".env") && normalized.endsWith(".local"));
    });
    if (forbiddenSegment) {
      throw new SelfHostingGateWorkspaceError(
        `The release tree contains forbidden local state at ${relativePath}.`,
      );
    }
  }
}

function requireExactWorkspaceStructure(actualTree, expectedFiles) {
  const actualFiles = actualTree.files.map((entry) => entry.relativePath);
  const expectedFilePaths = expectedFiles.map((entry) => entry.relativePath);
  const actualDirectories = actualTree.directories.map((entry) => entry.relativePath);
  const expectedDirectories = expectedDirectoryPaths(expectedFilePaths);
  if (!sameStringList(actualFiles, expectedFilePaths) || !sameStringList(actualDirectories, expectedDirectories)) {
    throw new SelfHostingGateWorkspaceError(
      "The materialized workspace contains missing, extra, ignored or local-only paths.",
    );
  }
}

function expectedDirectoryPaths(filePaths) {
  const directories = new Set();
  for (const filePath of filePaths) {
    const segments = filePath.split("/");
    for (let length = 1; length < segments.length; length += 1) {
      directories.add(segments.slice(0, length).join("/"));
    }
  }
  return [...directories].sort(compareUtf8);
}

async function readStableRegularFile(filePath, label, expectedGitMode) {
  const initialStats = await lstat(filePath, { bigint: true });
  if (initialStats.isSymbolicLink() || !initialStats.isFile()) {
    throw new SelfHostingGateWorkspaceError(`The gate workspace entry ${label} is not a regular file.`);
  }
  requireExpectedExecutableMode(initialStats, expectedGitMode, label);
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const openedStats = await handle.stat({ bigint: true });
    requireExpectedExecutableMode(openedStats, expectedGitMode, label);
    if (!sameStableStats(initialStats, openedStats)) {
      throw new SelfHostingGateWorkspaceError(`Gate workspace file ${label} changed before reading.`);
    }
    const bytes = await handle.readFile();
    const [handleAfter, pathAfter] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(filePath, { bigint: true }),
    ]);
    if (pathAfter.isSymbolicLink()
      || !pathAfter.isFile()
      || BigInt(bytes.byteLength) !== openedStats.size
      || !sameStableStats(openedStats, handleAfter)
      || !sameStableStats(openedStats, pathAfter)) {
      throw new SelfHostingGateWorkspaceError(`Gate workspace file ${label} changed while reading.`);
    }
    return bytes;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function requireExpectedExecutableMode(stats, expectedGitMode, label) {
  if (expectedGitMode === undefined || process.platform === "win32") return;
  const isExecutable = (stats.mode & 0o111n) !== 0n;
  const expectedExecutable = expectedGitMode === "100755";
  if (isExecutable !== expectedExecutable) {
    throw new SelfHostingGateWorkspaceError(
      `Gate workspace file ${label} does not have its release executable mode.`,
    );
  }
}

async function resolveGitRepositoryRoot(cwd) {
  const requestedPath = resolveRequiredPath(cwd, "Git repository root");
  const reportedRoot = await runGitText(requestedPath, ["rev-parse", "--show-toplevel"]);
  const [requestedRealPath, reportedRealPath] = await Promise.all([
    realpath(requestedPath),
    realpath(path.resolve(reportedRoot)),
  ]);
  if (!sameResolvedPath(requestedRealPath, reportedRealPath)) {
    throw new SelfHostingGateWorkspaceError("cwd must identify the exact Git repository root.");
  }
  return reportedRealPath;
}

async function resolveExactDirectory(value, label) {
  const resolvedPath = resolveRequiredPath(value, label);
  const stats = await lstat(resolvedPath);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new SelfHostingGateWorkspaceError(`The ${label} must be a regular directory.`);
  }
  const resolvedRealPath = await realpath(resolvedPath);
  if (!sameResolvedPath(resolvedPath, resolvedRealPath)) {
    throw new SelfHostingGateWorkspaceError(`The ${label} must not traverse links or junctions.`);
  }
  return resolvedRealPath;
}

async function inspectOptionalDirectory(directoryPath, label) {
  try {
    const stats = await lstat(directoryPath);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new SelfHostingGateWorkspaceError(`The ${label} must be a regular directory when it exists.`);
    }
    return stats;
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function requireDirectory(directoryPath, label) {
  const stats = await lstat(directoryPath, { bigint: true });
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new SelfHostingGateWorkspaceError(`The ${label} must be a regular directory.`);
  }
  return stats;
}

async function requireAbsentPath(filePath, label) {
  try {
    await lstat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new SelfHostingGateWorkspaceError(`The generated ${label} unexpectedly already exists.`);
}

function requireActiveWorkspace(workspace) {
  const workspacePath = workspace?.workspacePath;
  const state = typeof workspacePath === "string" ? activeWorkspaces.get(workspacePath) : undefined;
  if (!state || state.workspace !== workspace) {
    throw new SelfHostingGateWorkspaceError("Refusing to operate on an unknown or inactive gate workspace.");
  }
  return state;
}

async function readGitCommit(cwd, revision) {
  return normalizeReleaseSha(await runGitText(cwd, ["rev-parse", "--verify", `${revision}^{commit}`]));
}

async function readGitObjectFormat(cwd) {
  const value = await runGitText(cwd, ["rev-parse", "--show-object-format"]);
  if (value !== "sha1" && value !== "sha256") {
    throw new SelfHostingGateWorkspaceError(`Unsupported Git object format: ${value || "empty"}.`);
  }
  return value;
}

async function readGitHeadName(cwd) {
  return runGitText(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
}

async function isRegisteredWorktree(repositoryPath, workspacePath) {
  const output = await runGitBuffer(repositoryPath, ["worktree", "list", "--porcelain", "-z"]);
  if (output.length === 0 || output.at(-1) !== 0) {
    throw new SelfHostingGateWorkspaceError("Git returned a malformed worktree registry.");
  }
  let records;
  try {
    records = new TextDecoder("utf-8", { fatal: true }).decode(output).split("\0");
  } catch (error) {
    throw new SelfHostingGateWorkspaceError("Git returned a non-UTF-8 worktree registry.", {
      cause: error,
    });
  }
  const registeredPaths = records
    .filter((record) => record.startsWith("worktree "))
    .map((record) => path.resolve(record.slice("worktree ".length)));
  if (registeredPaths.length === 0) {
    throw new SelfHostingGateWorkspaceError("Git returned a worktree registry without a primary worktree.");
  }
  return registeredPaths.some((registeredPath) => sameResolvedPath(registeredPath, workspacePath));
}

async function runGitText(cwd, argumentsList) {
  const output = await runGitBuffer(cwd, argumentsList);
  let decoded;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(output);
  } catch (error) {
    throw new SelfHostingGateWorkspaceError("Git returned non-UTF-8 output.", { cause: error });
  }
  return decoded.replace(/\r?\n$/u, "");
}

async function runGitBuffer(cwd, argumentsList) {
  try {
    const { stdout } = await execFileAsync(
      "git",
      [
        "--no-replace-objects",
        "--literal-pathspecs",
        "-c",
        "core.fsmonitor=false",
        ...argumentsList,
      ],
      {
        cwd,
        encoding: "buffer",
        env: createSanitizedGitEnvironment(),
        maxBuffer: GIT_OUTPUT_LIMIT,
        windowsHide: true,
      },
    );
    return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
  } catch (error) {
    if (error instanceof SelfHostingGateWorkspaceError) throw error;
    throw new SelfHostingGateWorkspaceError("A sanitized Git workspace command failed.", { cause: error });
  }
}

function createSanitizedGitEnvironment(environment = process.env) {
  const sanitized = {};
  const environmentEntries = Object.entries(environment);
  for (const allowedKey of ALLOWED_INHERITED_ENVIRONMENT_KEYS) {
    const entry = environmentEntries.find(([key]) => (
      process.platform === "win32" ? key.toUpperCase() === allowedKey : key === allowedKey
    ));
    if (typeof entry?.[1] === "string") sanitized[allowedKey] = entry[1];
  }
  sanitized.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";
  sanitized.GIT_CONFIG_NOSYSTEM = "1";
  sanitized.GIT_ATTR_NOSYSTEM = "1";
  sanitized.GIT_NO_LAZY_FETCH = "1";
  sanitized.GIT_NO_REPLACE_OBJECTS = "1";
  sanitized.GIT_OPTIONAL_LOCKS = "0";
  sanitized.GIT_TERMINAL_PROMPT = "0";
  sanitized.LC_ALL = "C";
  return sanitized;
}

function splitNullRecords(buffer, label) {
  if (buffer.length === 0) return [];
  if (buffer.at(-1) !== 0) throw new SelfHostingGateWorkspaceError(`${label} is not NUL-terminated.`);
  const records = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0) continue;
    if (index === start) throw new SelfHostingGateWorkspaceError(`${label} contains an empty entry.`);
    records.push(buffer.subarray(start, index));
    start = index + 1;
  }
  return records;
}

function gitBlobObjectId(bytes, objectFormat) {
  const hash = createHash(objectFormat);
  hash.update(Buffer.from(`blob ${bytes.byteLength}\0`, "utf8"));
  hash.update(bytes);
  return hash.digest("hex");
}

function normalizeReleaseSha(value) {
  const releaseSha = String(value ?? "").trim().toLowerCase();
  if (!RELEASE_SHA.test(releaseSha)) {
    throw new SelfHostingGateWorkspaceError("releaseSha must be a full 40- or 64-character Git commit SHA.");
  }
  return releaseSha;
}

function normalizeRelativePath(value) {
  if (typeof value !== "string" || !value || value.includes("\0")) {
    throw new SelfHostingGateWorkspaceError("Git returned an invalid relative path.");
  }
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
    throw new SelfHostingGateWorkspaceError("Git returned an absolute release path.");
  }
  const portable = value.replaceAll("\\", "/");
  const segments = portable.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new SelfHostingGateWorkspaceError("Git returned a non-canonical release path.");
  }
  return segments.map((segment) => segment.normalize("NFC")).join("/");
}

function normalizeFilesystemSegment(value) {
  if (!value || value === "." || value === ".." || value.includes("/") || value.includes("\\") || value.includes("\0")) {
    throw new SelfHostingGateWorkspaceError("The workspace contains a non-portable path segment.");
  }
  const normalized = value.normalize("NFC");
  if (normalized !== value) {
    throw new SelfHostingGateWorkspaceError(`Workspace path segment ${value} is not Unicode-normalized.`);
  }
  return normalized;
}

function sameTreeManifest(left, right) {
  const leftEntries = [...left.directories, ...left.files];
  const rightEntries = [...right.directories, ...right.files];
  return sameStableStats(left.rootStats, right.rootStats)
    && leftEntries.length === rightEntries.length
    && leftEntries.every((entry, index) => entry.relativePath === rightEntries[index].relativePath
      && entry.stats.isDirectory() === rightEntries[index].stats.isDirectory()
      && sameStableStats(entry.stats, rightEntries[index].stats));
}

function sameStableStats(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function sameStringList(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function sameResolvedPath(left, right) {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function isPathInside(parentPath, candidatePath) {
  const relativePath = path.relative(parentPath, candidatePath);
  return relativePath === ""
    || (!path.isAbsolute(relativePath)
      && relativePath !== ".."
      && !relativePath.startsWith(`..${path.sep}`));
}

function resolveRequiredPath(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new SelfHostingGateWorkspaceError(`A ${label} is required.`);
  }
  return path.resolve(value);
}

async function pathExists(filePath) {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}
