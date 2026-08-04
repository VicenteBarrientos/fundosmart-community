import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_OUTPUT = ".dev.vars";

export async function createLocalVars({
  outputPath = DEFAULT_OUTPUT,
  randomBytesImpl = randomBytes,
} = {}) {
  const resolvedPath = path.resolve(outputPath);
  const secret = () => randomBytesImpl(32).toString("base64url");
  const generated = [secret(), secret(), secret()];
  if (new Set(generated).size !== generated.length) {
    throw new Error("The secure random source returned duplicate local secrets.");
  }

  const contents = [
    "# Generated for local development only. This file is ignored by Git.",
    "AUTH_ORIGIN=http://localhost:3000",
    "DEV_AUTH_EMAIL=developer@example.com",
    "DEV_AUTH_NAME=Desarrollador local",
    "FUNDOSMART_OWNER_EMAIL=developer@example.com",
    `OFFLINE_SESSION_SECRET=${generated[0]}`,
    `ASSISTANT_CONFIRMATION_SECRET=${generated[1]}`,
    `AI_KEYS_ENCRYPTION_SECRET=${generated[2]}`,
    "# Optional Google OIDC values for local testing:",
    "# GOOGLE_CLIENT_ID=",
    "# GOOGLE_CLIENT_SECRET=",
    "",
  ].join("\n");

  await writeFile(resolvedPath, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
  return { outputPath: resolvedPath };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  createLocalVars()
    .then(({ outputPath }) => {
      process.stdout.write(`Created ignored local development variables at ${path.relative(process.cwd(), outputPath)}.\n`);
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
