import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_OUTPUT = ".wrangler/community.production.secrets.env";

export async function createSelfHostingSecrets({
  outputPath = DEFAULT_OUTPUT,
  randomBytesImpl = randomBytes,
} = {}) {
  const resolvedPath = path.resolve(outputPath);
  const secret = () => randomBytesImpl(32).toString("base64url");
  const generated = {
    OFFLINE_SESSION_SECRET: secret(),
    ASSISTANT_CONFIRMATION_SECRET: secret(),
    AI_KEYS_ENCRYPTION_SECRET: secret(),
  };
  if (new Set(Object.values(generated)).size !== 3) {
    throw new Error("The secure random source returned duplicate secrets.");
  }

  const contents = [
    "# Generated locally. Complete the four installation-specific placeholders below.",
    "# This file is ignored by Git. Never paste it into issues, logs or screenshots.",
    "AUTH_ORIGIN=https://replace.invalid",
    "GOOGLE_CLIENT_ID=replace.apps.googleusercontent.com",
    "GOOGLE_CLIENT_SECRET=replace-with-google-client-secret",
    "FUNDOSMART_OWNER_EMAIL=owner@replace.invalid",
    `OFFLINE_SESSION_SECRET=${generated.OFFLINE_SESSION_SECRET}`,
    `ASSISTANT_CONFIRMATION_SECRET=${generated.ASSISTANT_CONFIRMATION_SECRET}`,
    `AI_KEYS_ENCRYPTION_SECRET=${generated.AI_KEYS_ENCRYPTION_SECRET}`,
    "# Optional Copernicus credentials must be configured as a pair:",
    "# CDSE_CLIENT_ID=",
    "# CDSE_CLIENT_SECRET=",
    "",
  ].join("\n");

  await mkdir(path.dirname(resolvedPath), { recursive: true });
  await writeFile(resolvedPath, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
  return { outputPath: resolvedPath };
}

function parseArguments(args) {
  if (args.length === 0) return { outputPath: DEFAULT_OUTPUT };
  if (args.length === 2 && args[0] === "--output" && args[1]) return { outputPath: args[1] };
  throw new Error("Usage: node scripts/release/create-self-hosting-secrets.mjs [--output <path>]");
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  createSelfHostingSecrets(parseArguments(process.argv.slice(2)))
    .then(({ outputPath }) => {
      process.stdout.write(`Created ignored self-hosting secrets file at ${path.relative(process.cwd(), outputPath)}.\n`);
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
