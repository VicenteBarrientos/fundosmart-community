const ALLOWED_LOCATIONS = new Set(["apac", "eeur", "enam", "oc", "weur", "wnam"]);
const ALLOWED_JURISDICTIONS = new Set(["eu", "fedramp"]);
const ALLOWED_SECRET_DELETIONS = new Set(["CDSE_CLIENT_ID", "CDSE_CLIENT_SECRET"]);
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;
const WRAPPER_CONTROLLED_FLAGS = new Set([
  "-c",
  "-e",
  "--assets",
  "--config",
  "--cwd",
  "--domain",
  "--env",
  "--env-file",
  "--name",
  "--profile",
  "--route",
  "--routes",
  "--secrets-file",
  "--triggers",
  "--var",
  "--vars",
]);
const VERSION_ID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu;
const BOOKMARK = /^[a-z0-9][a-z0-9._:-]{0,511}$/iu;
const PLACEHOLDER = /^(?:<[^>]+>|previous[_-]|replace[_-]|todo\b)/iu;

export class SelfHostingWranglerCommandError extends Error {
  constructor(message) {
    super(message);
    this.name = "SelfHostingWranglerCommandError";
    this.code = "SELF_HOSTING_WRANGLER_COMMAND_REJECTED";
  }
}

export function validateSelfHostingWranglerCommand({
  wranglerArguments = [],
  variables = {},
} = {}) {
  const args = validateArgumentVector(wranglerArguments);
  rejectWrapperOverrides(args);

  if (args[0] === "whoami") {
    expectExactLength(args, 1, "whoami does not accept arguments or flags");
    return command(["whoami"]);
  }

  if (args[0] === "d1") return validateD1Command(args, variables);
  if (args[0] === "r2") return validateR2Command(args, variables);

  if (args[0] === "versions" && args[1] === "list") {
    const { options, positionals } = parseTail(args.slice(2), {
      "--json": { takesValue: false },
    });
    expectPositionals(positionals, [], "versions list");
    requireOption(options, "--json", "versions list requires --json");
    return command(["versions", "list", "--json"], { requiresBuild: true });
  }

  if (args[0] === "deployments" && args[1] === "status") {
    const { options, positionals } = parseTail(args.slice(2), {
      "--json": { takesValue: false },
    });
    expectPositionals(positionals, [], "deployments status");
    requireOption(options, "--json", "deployments status requires --json");
    return command(["deployments", "status", "--json"], { requiresBuild: true });
  }

  if (args[0] === "deploy") return validateDeploy(args);
  if (args[0] === "secret") return validateSecretCommand(args);
  if (args[0] === "rollback") return validateRollback(args);

  reject(`Unsupported Wrangler command: ${args.join(" ")}.`);
}

export const parseSelfHostingWranglerCommand = validateSelfHostingWranglerCommand;

function validateD1Command(args, variables) {
  if (args[1] === "create") {
    const { options, positionals } = parseTail(args.slice(2), {
      "--jurisdiction": { takesValue: true },
      "--location": { takesValue: true },
    });
    const expectedName = expectedResourceName(variables, "FUNDOSMART_D1_DATABASE_NAME");
    expectPositionals(positionals, [expectedName], "d1 create");
    const placement = requireResourcePlacement(options, variables, "d1 create");
    return command(["d1", "create", expectedName, ...placement], { mutating: true });
  }

  if (args[1] === "info") {
    const { positionals } = parseTail(args.slice(2), {});
    expectPositionals(positionals, ["DB"], "d1 info");
    return command(["d1", "info", "DB"], { requiresBuild: true });
  }

  if (args[1] === "export") {
    const { options, positionals } = parseTail(args.slice(2), {
      "--output": { takesValue: true },
      "--remote": { takesValue: false },
    });
    expectPositionals(positionals, ["DB"], "d1 export");
    requireOption(options, "--remote", "d1 export requires --remote");
    const output = requireOption(options, "--output", "d1 export requires --output");
    if (!isSqlOutput(output)) reject("d1 export --output must name a non-placeholder .sql file.");
    return command(["d1", "export", "DB", "--remote", "--output", output], {
      requiresBuild: true,
      mutating: true,
    });
  }

  if (args[1] === "migrations" && new Set(["list", "apply"]).has(args[2])) {
    const action = args[2];
    const { options, positionals } = parseTail(args.slice(3), {
      "--remote": { takesValue: false },
    });
    expectPositionals(positionals, ["DB"], `d1 migrations ${action}`);
    requireOption(options, "--remote", `d1 migrations ${action} requires --remote`);
    return command(["d1", "migrations", action, "DB", "--remote"], {
      requiresBuild: true,
      mutating: action === "apply",
    });
  }

  if (args[1] === "time-travel" && args[2] === "info") {
    const { options, positionals } = parseTail(args.slice(3), {
      "--json": { takesValue: false },
    });
    expectPositionals(positionals, ["DB"], "d1 time-travel info");
    requireOption(options, "--json", "d1 time-travel info requires --json");
    return command(["d1", "time-travel", "info", "DB", "--json"], { requiresBuild: true });
  }

  if (args[1] === "time-travel" && args[2] === "restore") {
    const { options, positionals } = parseTail(args.slice(3), {
      "--bookmark": { takesValue: true },
    });
    expectPositionals(positionals, ["DB"], "d1 time-travel restore");
    const bookmark = requireOption(
      options,
      "--bookmark",
      "d1 time-travel restore requires --bookmark",
    );
    if (!BOOKMARK.test(bookmark) || PLACEHOLDER.test(bookmark)) {
      reject("d1 time-travel restore requires a literal, non-placeholder bookmark.");
    }
    return command(["d1", "time-travel", "restore", "DB", "--bookmark", bookmark], {
      requiresBuild: true,
      mutating: true,
      destructive: true,
    });
  }

  reject(`Unsupported D1 command: ${args.join(" ")}.`);
}

function validateR2Command(args, variables) {
  if (args[1] !== "bucket") reject(`Unsupported R2 command: ${args.join(" ")}.`);
  const expectedName = expectedResourceName(variables, "FUNDOSMART_R2_BUCKET_NAME");

  if (args[2] === "create") {
    const { options, positionals } = parseTail(args.slice(3), {
      "--jurisdiction": { takesValue: true },
      "--location": { takesValue: true },
    });
    expectPositionals(positionals, [expectedName], "r2 bucket create");
    const placement = requireResourcePlacement(options, variables, "r2 bucket create");
    return command(["r2", "bucket", "create", expectedName, ...placement], { mutating: true });
  }

  if (args[2] === "info") {
    const { options, positionals } = parseTail(args.slice(3), {
      "--jurisdiction": { takesValue: true },
    });
    expectPositionals(positionals, [expectedName], "r2 bucket info");
    const jurisdiction = requireResourceJurisdiction(options, variables, "r2 bucket info");
    return command(["r2", "bucket", "info", expectedName, ...jurisdiction]);
  }

  reject(`Unsupported R2 bucket command: ${args.join(" ")}.`);
}

function validateDeploy(args) {
  const { options, positionals } = parseTail(args.slice(1), {
    "--message": { takesValue: true },
    "--strict": { takesValue: false },
  });
  expectPositionals(positionals, [], "deploy");
  requireOption(options, "--strict", "deploy requires --strict");
  const message = requireOption(options, "--message", "deploy requires --message");
  validateMessage(message, "deploy");
  return command(["deploy", "--strict", "--message", message], {
    requiresBuild: true,
    requiresSecrets: true,
    mutating: true,
  });
}

function validateSecretCommand(args) {
  if (args[1] === "list") {
    const { options, positionals } = parseTail(args.slice(2), {
      "--format": { takesValue: true },
    });
    expectPositionals(positionals, [], "secret list");
    const format = requireOption(options, "--format", "secret list requires --format json");
    if (format !== "json") reject("secret list only permits --format json.");
    return command(["secret", "list", "--format", "json"], { requiresBuild: true });
  }

  if (args[1] === "delete") {
    const { positionals } = parseTail(args.slice(2), {});
    if (positionals.length !== 1 || !ALLOWED_SECRET_DELETIONS.has(positionals[0])) {
      reject("secret delete is limited to CDSE_CLIENT_ID or CDSE_CLIENT_SECRET.");
    }
    return command(["secret", "delete", positionals[0]], {
      requiresBuild: true,
      mutating: true,
      destructive: true,
    });
  }

  reject(`Unsupported secret command: ${args.join(" ")}.`);
}

function validateRollback(args) {
  const { options, positionals } = parseTail(args.slice(1), {
    "--message": { aliases: ["-m"], takesValue: true },
    "--yes": { aliases: ["-y"], takesValue: false },
  });
  if (positionals.length !== 1 || !VERSION_ID.test(positionals[0]) || /^0+(?:-0+){4}$/u.test(positionals[0])) {
    reject("rollback requires one literal Worker version UUID.");
  }
  const message = requireOption(options, "--message", "rollback requires --message");
  validateMessage(message, "rollback");
  requireOption(options, "--yes", "rollback requires --yes for non-interactive execution");
  return command(["rollback", positionals[0], "--message", message, "--yes"], {
    requiresBuild: true,
    mutating: true,
    destructive: true,
  });
}

function validateArgumentVector(wranglerArguments) {
  if (!Array.isArray(wranglerArguments) || wranglerArguments.length === 0) {
    reject("A Wrangler command is required after --.");
  }
  for (const value of wranglerArguments) {
    if (typeof value !== "string" || value.length === 0 || CONTROL_CHARACTERS.test(value)) {
      reject("Wrangler arguments must be non-empty strings without C0, DEL or C1 control characters.");
    }
    if (/^--?[^=]+=/.test(value)) {
      reject(`Flag=value syntax is not permitted: ${value}.`);
    }
  }
  return [...wranglerArguments];
}

function rejectWrapperOverrides(args) {
  const override = args.find((value) => WRAPPER_CONTROLLED_FLAGS.has(value));
  if (override) reject(`${override} is controlled by the self-hosting wrapper and cannot be overridden.`);
}

function parseTail(tail, schema) {
  const aliases = new Map();
  for (const [flag, definition] of Object.entries(schema)) {
    aliases.set(flag, flag);
    for (const alias of definition.aliases ?? []) aliases.set(alias, flag);
  }

  const options = new Map();
  const positionals = [];
  for (let index = 0; index < tail.length; index += 1) {
    const token = tail[index];
    if (!token.startsWith("-")) {
      positionals.push(token);
      continue;
    }
    const canonical = aliases.get(token);
    if (!canonical) reject(`Unexpected Wrangler flag: ${token}.`);
    if (options.has(canonical)) reject(`Duplicate Wrangler flag: ${canonical}.`);
    const definition = schema[canonical];
    if (!definition.takesValue) {
      options.set(canonical, true);
      continue;
    }
    const value = tail[index + 1];
    if (typeof value !== "string" || value.length === 0 || value.startsWith("-")) {
      reject(`${token} requires one explicit value.`);
    }
    options.set(canonical, value);
    index += 1;
  }
  return { options, positionals };
}

function expectedResourceName(variables, key) {
  const value = variables?.[key];
  if (typeof value !== "string" || !value || value !== value.trim()) {
    reject(`${key} must be a non-empty exact resource name before running this command.`);
  }
  return value;
}

function requireLocation(options, label) {
  const location = requireOption(options, "--location", `${label} requires --location`);
  if (!ALLOWED_LOCATIONS.has(location)) {
    reject(`${label} location must be one of: ${[...ALLOWED_LOCATIONS].join(", ")}.`);
  }
  return location;
}

function requireResourcePlacement(options, variables, label) {
  const configured = variables?.FUNDOSMART_DATA_JURISDICTION;
  if (configured === undefined || configured === "") {
    if (options.has("--jurisdiction")) {
      reject(`${label} requires --location when FUNDOSMART_DATA_JURISDICTION is empty.`);
    }
    return ["--location", requireLocation(options, label)];
  }
  if (typeof configured !== "string"
    || configured !== configured.trim()
    || CONTROL_CHARACTERS.test(configured)
    || !ALLOWED_JURISDICTIONS.has(configured)) {
    reject("FUNDOSMART_DATA_JURISDICTION must be empty, eu or fedramp.");
  }
  if (options.has("--location")) {
    reject(`${label} must not use --location when FUNDOSMART_DATA_JURISDICTION is configured.`);
  }
  const jurisdiction = requireOption(
    options,
    "--jurisdiction",
    `${label} requires --jurisdiction ${configured}`,
  );
  if (jurisdiction !== configured) {
    reject(`${label} --jurisdiction must exactly match FUNDOSMART_DATA_JURISDICTION.`);
  }
  return ["--jurisdiction", jurisdiction];
}

function requireResourceJurisdiction(options, variables, label) {
  const configured = variables?.FUNDOSMART_DATA_JURISDICTION;
  if (configured === undefined || configured === "") {
    if (options.has("--jurisdiction")) {
      reject(`${label} must omit --jurisdiction when FUNDOSMART_DATA_JURISDICTION is empty.`);
    }
    return [];
  }
  if (typeof configured !== "string"
    || configured !== configured.trim()
    || CONTROL_CHARACTERS.test(configured)
    || !ALLOWED_JURISDICTIONS.has(configured)) {
    reject("FUNDOSMART_DATA_JURISDICTION must be empty, eu or fedramp.");
  }
  const jurisdiction = requireOption(
    options,
    "--jurisdiction",
    `${label} requires --jurisdiction ${configured}`,
  );
  if (jurisdiction !== configured) {
    reject(`${label} --jurisdiction must exactly match FUNDOSMART_DATA_JURISDICTION.`);
  }
  return ["--jurisdiction", jurisdiction];
}

function requireOption(options, flag, message) {
  if (!options.has(flag)) reject(`${message}.`);
  return options.get(flag);
}

function expectPositionals(actual, expected, label) {
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    reject(`${label} requires exactly: ${expected.join(" ") || "no positional arguments"}.`);
  }
}

function expectExactLength(args, length, message) {
  if (args.length !== length) reject(`${message}.`);
}

function validateMessage(value, label) {
  if (!value.trim() || value.length > 256 || CONTROL_CHARACTERS.test(value)) {
    reject(`${label} --message must be non-empty, at most 256 characters and free of control characters.`);
  }
}

function isSqlOutput(value) {
  return value === value.trim()
    && value.toLowerCase().endsWith(".sql")
    && !PLACEHOLDER.test(value)
    && !CONTROL_CHARACTERS.test(value);
}

function command(normalizedArguments, {
  requiresBuild = false,
  requiresSecrets = false,
  mutating = false,
  destructive = false,
} = {}) {
  return Object.freeze({
    normalizedArguments: Object.freeze(normalizedArguments),
    requiresBuild,
    requiresSecrets,
    mutating,
    destructive,
    productionConfirmationRequired: mutating,
  });
}

function reject(message) {
  throw new SelfHostingWranglerCommandError(message);
}
