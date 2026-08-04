import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  SelfHostingWranglerCommandError,
  parseSelfHostingWranglerCommand,
  validateSelfHostingWranglerCommand,
} from "../scripts/release/self-hosting-wrangler-command.mjs";

const variables = {
  FUNDOSMART_DATA_JURISDICTION: "",
  FUNDOSMART_D1_DATABASE_NAME: "fundosmart-community-staging",
  FUNDOSMART_R2_BUCKET_NAME: "fundosmart-community-staging-files",
};
const versionId = "123e4567-e89b-42d3-a456-426614174000";
const bookmark = "00000000-0000000a-00004e1c-0000000000000000";

function validate(wranglerArguments, overrides = {}) {
  return validateSelfHostingWranglerCommand({ variables, wranglerArguments, ...overrides });
}

function expected(normalizedArguments, overrides = {}) {
  return {
    normalizedArguments,
    requiresBuild: false,
    requiresSecrets: false,
    mutating: false,
    destructive: false,
    productionConfirmationRequired: false,
    ...overrides,
  };
}

test("accepts and classifies every documented self-hosting Wrangler command", () => {
  const cases = [
    [["whoami"], expected(["whoami"])],
    [
      ["d1", "create", variables.FUNDOSMART_D1_DATABASE_NAME, "--location", "wnam"],
      expected(["d1", "create", variables.FUNDOSMART_D1_DATABASE_NAME, "--location", "wnam"], {
        mutating: true,
        productionConfirmationRequired: true,
      }),
    ],
    [
      ["r2", "bucket", "create", variables.FUNDOSMART_R2_BUCKET_NAME, "--location", "weur"],
      expected(["r2", "bucket", "create", variables.FUNDOSMART_R2_BUCKET_NAME, "--location", "weur"], {
        mutating: true,
        productionConfirmationRequired: true,
      }),
    ],
    [
      ["r2", "bucket", "info", variables.FUNDOSMART_R2_BUCKET_NAME],
      expected(["r2", "bucket", "info", variables.FUNDOSMART_R2_BUCKET_NAME]),
    ],
    [["d1", "info", "DB"], expected(["d1", "info", "DB"], { requiresBuild: true })],
    [
      ["d1", "export", "DB", "--remote", "--output", "../fundosmart-backups/pre-release.sql"],
      expected(["d1", "export", "DB", "--remote", "--output", "../fundosmart-backups/pre-release.sql"], {
        requiresBuild: true,
        mutating: true,
        productionConfirmationRequired: true,
      }),
    ],
    [
      ["d1", "migrations", "list", "DB", "--remote"],
      expected(["d1", "migrations", "list", "DB", "--remote"], { requiresBuild: true }),
    ],
    [
      ["d1", "migrations", "apply", "DB", "--remote"],
      expected(["d1", "migrations", "apply", "DB", "--remote"], {
        requiresBuild: true,
        mutating: true,
        productionConfirmationRequired: true,
      }),
    ],
    [
      ["d1", "time-travel", "info", "DB", "--json"],
      expected(["d1", "time-travel", "info", "DB", "--json"], { requiresBuild: true }),
    ],
    [
      ["d1", "time-travel", "restore", "DB", "--bookmark", bookmark],
      expected(["d1", "time-travel", "restore", "DB", "--bookmark", bookmark], {
        requiresBuild: true,
        mutating: true,
        destructive: true,
        productionConfirmationRequired: true,
      }),
    ],
    [
      ["versions", "list", "--json"],
      expected(["versions", "list", "--json"], { requiresBuild: true }),
    ],
    [
      ["deployments", "status", "--json"],
      expected(["deployments", "status", "--json"], { requiresBuild: true }),
    ],
    [
      ["deploy", "--strict", "--message", "FundoSmart Community staging release"],
      expected(["deploy", "--strict", "--message", "FundoSmart Community staging release"], {
        requiresBuild: true,
        requiresSecrets: true,
        mutating: true,
        productionConfirmationRequired: true,
      }),
    ],
    [
      ["secret", "list", "--format", "json"],
      expected(["secret", "list", "--format", "json"], { requiresBuild: true }),
    ],
    ...["CDSE_CLIENT_ID", "CDSE_CLIENT_SECRET"].map((secret) => [
      ["secret", "delete", secret],
      expected(["secret", "delete", secret], {
        requiresBuild: true,
        mutating: true,
        destructive: true,
        productionConfirmationRequired: true,
      }),
    ]),
    [
      ["rollback", versionId, "-m", "Rollback por smoke fallido", "-y"],
      expected(["rollback", versionId, "--message", "Rollback por smoke fallido", "--yes"], {
        requiresBuild: true,
        mutating: true,
        destructive: true,
        productionConfirmationRequired: true,
      }),
    ],
  ];

  for (const [wranglerArguments, result] of cases) {
    assert.deepEqual(validate(wranglerArguments), result, wranglerArguments.join(" "));
  }
});

test("normalizes allowed flag order and aliases without accepting additional surface", () => {
  assert.deepEqual(
    validate(["d1", "export", "--output", "backup.sql", "DB", "--remote"]).normalizedArguments,
    ["d1", "export", "DB", "--remote", "--output", "backup.sql"],
  );
  assert.deepEqual(
    validate(["deploy", "--message", "release 123", "--strict"]).normalizedArguments,
    ["deploy", "--strict", "--message", "release 123"],
  );
  assert.deepEqual(
    parseSelfHostingWranglerCommand({
      variables,
      wranglerArguments: ["rollback", "--yes", versionId, "--message", "rollback 123"],
    }).normalizedArguments,
    ["rollback", versionId, "--message", "rollback 123", "--yes"],
  );
});

test("pins D1 and R2 creation plus R2 lookup to the configured location mode", () => {
  const jurisdictionVariables = {
    ...variables,
    FUNDOSMART_DATA_JURISDICTION: "eu",
  };
  assert.deepEqual(
    validateSelfHostingWranglerCommand({
      variables: jurisdictionVariables,
      wranglerArguments: [
        "d1",
        "create",
        variables.FUNDOSMART_D1_DATABASE_NAME,
        "--jurisdiction",
        "eu",
      ],
    }),
    expected([
      "d1",
      "create",
      variables.FUNDOSMART_D1_DATABASE_NAME,
      "--jurisdiction",
      "eu",
    ], {
      mutating: true,
      productionConfirmationRequired: true,
    }),
  );
  assert.deepEqual(
    validateSelfHostingWranglerCommand({
      variables: { ...variables, FUNDOSMART_DATA_JURISDICTION: "fedramp" },
      wranglerArguments: [
        "r2",
        "bucket",
        "create",
        variables.FUNDOSMART_R2_BUCKET_NAME,
        "--jurisdiction",
        "fedramp",
      ],
    }).normalizedArguments,
    [
      "r2",
      "bucket",
      "create",
      variables.FUNDOSMART_R2_BUCKET_NAME,
      "--jurisdiction",
      "fedramp",
    ],
  );
  assert.deepEqual(
    validateSelfHostingWranglerCommand({
      variables: jurisdictionVariables,
      wranglerArguments: [
        "r2",
        "bucket",
        "create",
        variables.FUNDOSMART_R2_BUCKET_NAME,
        "--jurisdiction",
        "eu",
      ],
    }),
    expected([
      "r2",
      "bucket",
      "create",
      variables.FUNDOSMART_R2_BUCKET_NAME,
      "--jurisdiction",
      "eu",
    ], {
      mutating: true,
      productionConfirmationRequired: true,
    }),
  );
  assert.deepEqual(
    validateSelfHostingWranglerCommand({
      variables: jurisdictionVariables,
      wranglerArguments: [
        "r2",
        "bucket",
        "info",
        variables.FUNDOSMART_R2_BUCKET_NAME,
        "--jurisdiction",
        "eu",
      ],
    }),
    expected([
      "r2",
      "bucket",
      "info",
      variables.FUNDOSMART_R2_BUCKET_NAME,
      "--jurisdiction",
      "eu",
    ]),
  );

  for (const wranglerArguments of [
    ["d1", "create", variables.FUNDOSMART_D1_DATABASE_NAME, "--jurisdiction", "eu"],
    ["r2", "bucket", "create", variables.FUNDOSMART_R2_BUCKET_NAME, "--jurisdiction", "eu"],
  ]) {
    assert.throws(() => validate(wranglerArguments), /requires --location/u);
  }
  assert.throws(
    () => validate([
      "r2",
      "bucket",
      "info",
      variables.FUNDOSMART_R2_BUCKET_NAME,
      "--jurisdiction",
      "eu",
    ]),
    /must omit --jurisdiction/u,
  );
  for (const wranglerArguments of [
    ["d1", "create", variables.FUNDOSMART_D1_DATABASE_NAME, "--location", "weur"],
    ["r2", "bucket", "create", variables.FUNDOSMART_R2_BUCKET_NAME, "--location", "weur"],
    [
      "d1",
      "create",
      variables.FUNDOSMART_D1_DATABASE_NAME,
      "--location",
      "weur",
      "--jurisdiction",
      "eu",
    ],
  ]) {
    assert.throws(
      () => validateSelfHostingWranglerCommand({ variables: jurisdictionVariables, wranglerArguments }),
      /must not use --location/u,
    );
  }
  assert.throws(
    () => validateSelfHostingWranglerCommand({
      variables: jurisdictionVariables,
      wranglerArguments: ["d1", "create", variables.FUNDOSMART_D1_DATABASE_NAME],
    }),
    /requires --jurisdiction eu/u,
  );
  assert.throws(
    () => validateSelfHostingWranglerCommand({
      variables: jurisdictionVariables,
      wranglerArguments: ["r2", "bucket", "info", variables.FUNDOSMART_R2_BUCKET_NAME],
    }),
    /requires --jurisdiction eu/u,
  );
  assert.throws(
    () => validateSelfHostingWranglerCommand({
      variables: jurisdictionVariables,
      wranglerArguments: [
        "r2",
        "bucket",
        "info",
        variables.FUNDOSMART_R2_BUCKET_NAME,
        "--jurisdiction",
        "fedramp",
      ],
    }),
    /must exactly match/u,
  );
  assert.throws(
    () => validateSelfHostingWranglerCommand({
      variables: jurisdictionVariables,
      wranglerArguments: [
        "d1",
        "create",
        variables.FUNDOSMART_D1_DATABASE_NAME,
        "--jurisdiction",
        "fedramp",
      ],
    }),
    /must exactly match/u,
  );
  assert.throws(
    () => validateSelfHostingWranglerCommand({
      variables: { ...variables, FUNDOSMART_DATA_JURISDICTION: "weur" },
      wranglerArguments: [
        "d1",
        "create",
        variables.FUNDOSMART_D1_DATABASE_NAME,
        "--jurisdiction",
        "eu",
      ],
    }),
    /must be empty, eu or fedramp/u,
  );
});

test("fails closed for unknown commands and dangerous neighboring Wrangler commands", () => {
  for (const wranglerArguments of [
    ["delete"],
    ["dev"],
    ["d1", "delete", variables.FUNDOSMART_D1_DATABASE_NAME],
    ["d1", "execute", "DB", "--remote", "--command", "DROP TABLE users"],
    ["r2", "bucket", "delete", variables.FUNDOSMART_R2_BUCKET_NAME],
    ["r2", "object", "put", `${variables.FUNDOSMART_R2_BUCKET_NAME}/payload`],
    ["secret", "put", "AUTH_ORIGIN"],
    ["versions", "view", versionId],
    ["deployments", "view"],
  ]) {
    assert.throws(() => validate(wranglerArguments), SelfHostingWranglerCommandError, wranglerArguments.join(" "));
  }
});

test("rejects every caller-controlled target or configuration override", () => {
  const overrides = [
    ["-c", "other.json"],
    ["--config", "other.json"],
    ["-e", "other"],
    ["--env", "other"],
    ["--cwd", ".."],
    ["--env-file", ".env.other"],
    ["--profile", "other"],
    ["--name", "other-worker"],
    ["--route", "other.example.com"],
    ["--routes", "other.example.com"],
    ["--domain", "other.example.com"],
    ["--assets", "other-assets"],
    ["--var", "AUTH_ORIGIN:https://attacker.example"],
    ["--vars", "AUTH_ORIGIN:https://attacker.example"],
    ["--triggers", "* * * * *"],
    ["--secrets-file", "attacker.env"],
  ];

  for (const override of overrides) {
    assert.throws(
      () => validate(["deploy", "--strict", "--message", "release", ...override]),
      (error) => error instanceof SelfHostingWranglerCommandError && /controlled by the self-hosting wrapper/u.test(error.message),
      override[0],
    );
  }
});

test("rejects flag=value syntax, duplicate flags and unexpected arguments", () => {
  for (const wranglerArguments of [
    ["d1", "create", variables.FUNDOSMART_D1_DATABASE_NAME, "--location=wnam"],
    ["deploy", "--strict", "--message=release"],
    ["d1", "export", "DB", "--remote", "--output=backup.sql"],
    ["deploy", "--strict", "--strict", "--message", "release"],
    ["deploy", "--strict", "--message", "release", "--message", "release-again"],
    ["rollback", versionId, "-m", "rollback", "--message", "again", "-y"],
    ["d1", "export", "DB", "--remote", "--remote", "--output", "backup.sql"],
    ["whoami", "extra"],
    ["d1", "info", "DB", "extra"],
    ["versions", "list", "--json", "extra"],
    ["secret", "list", "--format", "json", "extra"],
  ]) {
    assert.throws(() => validate(wranglerArguments), SelfHostingWranglerCommandError, wranglerArguments.join(" "));
  }
});

test("pins resource names, D1 binding targets and create locations", () => {
  for (const wranglerArguments of [
    ["d1", "create", "other-database", "--location", "wnam"],
    ["r2", "bucket", "create", "other-bucket", "--location", "wnam"],
    ["r2", "bucket", "info", "other-bucket"],
    ["d1", "info", variables.FUNDOSMART_D1_DATABASE_NAME],
    ["d1", "migrations", "list", "db", "--remote"],
    ["d1", "time-travel", "info", "DB2", "--json"],
    ["d1", "create", variables.FUNDOSMART_D1_DATABASE_NAME],
    ["d1", "create", variables.FUNDOSMART_D1_DATABASE_NAME, "--location", "moon"],
    ["r2", "bucket", "create", variables.FUNDOSMART_R2_BUCKET_NAME, "--location", "automatic"],
  ]) {
    assert.throws(() => validate(wranglerArguments), SelfHostingWranglerCommandError, wranglerArguments.join(" "));
  }

  assert.throws(
    () => validateSelfHostingWranglerCommand({
      variables: { FUNDOSMART_D1_DATABASE_NAME: "  " },
      wranglerArguments: ["d1", "create", "database", "--location", "wnam"],
    }),
    /FUNDOSMART_D1_DATABASE_NAME/u,
  );
});

test("requires remote, machine-readable and wrapper-owned release safeguards", () => {
  for (const wranglerArguments of [
    ["d1", "export", "DB", "--output", "backup.sql"],
    ["d1", "export", "DB", "--remote"],
    ["d1", "export", "DB", "--remote", "--output", "backup.json"],
    ["d1", "migrations", "list", "DB"],
    ["d1", "migrations", "apply", "DB"],
    ["d1", "time-travel", "info", "DB"],
    ["versions", "list"],
    ["deployments", "status"],
    ["secret", "list"],
    ["secret", "list", "--format", "text"],
    ["deploy", "--message", "release"],
    ["deploy", "--strict"],
    ["deploy", "--strict", "--message", "   "],
  ]) {
    assert.throws(() => validate(wranglerArguments), SelfHostingWranglerCommandError, wranglerArguments.join(" "));
  }
});

test("limits destructive commands to literal reviewed targets", () => {
  for (const wranglerArguments of [
    ["secret", "delete", "AUTH_ORIGIN"],
    ["secret", "delete", "CDSE_CLIENT_ID", "CDSE_CLIENT_SECRET"],
    ["d1", "time-travel", "restore", "DB"],
    ["d1", "time-travel", "restore", "DB", "--bookmark", "PREVIOUS_D1_BOOKMARK"],
    ["d1", "time-travel", "restore", "DB", "--bookmark", "bookmark with spaces"],
    ["rollback", "PREVIOUS_VERSION_ID", "-m", "rollback", "-y"],
    ["rollback", versionId, "-y"],
    ["rollback", versionId, "-m", "rollback"],
    ["rollback", versionId, "-m", "rollback", "-y", "extra"],
  ]) {
    assert.throws(() => validate(wranglerArguments), SelfHostingWranglerCommandError, wranglerArguments.join(" "));
  }
});

test("rejects malformed argument vectors and never executes a child process", async () => {
  for (const wranglerArguments of [undefined, null, [], [""], ["whoami\n"]]) {
    assert.throws(
      () => validateSelfHostingWranglerCommand({ variables, wranglerArguments }),
      SelfHostingWranglerCommandError,
    );
  }
  assert.throws(
    () => validateSelfHostingWranglerCommand({ variables, wranglerArguments: ["whoami", 123] }),
    SelfHostingWranglerCommandError,
  );
  for (const control of ["\t", "\u001b", "\u007f", "\u0085"]) {
    assert.throws(
      () => validate(["deploy", "--strict", "--message", `release${control}candidate`]),
      (error) => error instanceof SelfHostingWranglerCommandError && /control characters/u.test(error.message),
    );
  }

  const source = await readFile(new URL("../scripts/release/self-hosting-wrangler-command.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /node:child_process|\bspawn\s*\(|\bexec(?:File)?\s*\(|\bfork\s*\(/u);
});
