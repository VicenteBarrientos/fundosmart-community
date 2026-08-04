import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const DIRECT_DEPLOY_MESSAGE = [
  "Direct deployment is disabled in the community repository.",
  "Use npm run deploy:check for a read-only validation.",
  "Create and review an installation-specific Cloudflare release workflow before publishing.",
].join(" ");

export function blockDirectDeploy() {
  throw new Error(DIRECT_DEPLOY_MESSAGE);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    blockDirectDeploy();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
