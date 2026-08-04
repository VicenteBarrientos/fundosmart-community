import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export async function checkHealth({
  baseUrl,
  fetchImpl = fetch,
  attempts = 3,
  timeoutMs = 10_000,
  sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)),
} = {}) {
  const healthUrl = new URL("/healthz", String(baseUrl ?? ""));
  if (healthUrl.protocol !== "https:") throw new Error("The production monitor requires HTTPS.");
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 5) throw new Error("Health attempts must be between 1 and 5.");

  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(healthUrl, {
        headers: { Accept: "application/json", "User-Agent": "FundoSmart-Health-Monitor/1" },
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
      const payload = await response.json();
      if (response.status !== 200 || payload?.status !== "ok") {
        throw new Error(`Health endpoint returned ${response.status}.`);
      }
      if (!response.headers.get("cache-control")?.includes("no-store")) {
        throw new Error("Health endpoint is cacheable.");
      }
      if (!response.headers.get("x-robots-tag")?.includes("noindex")) {
        throw new Error("Health endpoint is indexable.");
      }
      process.stdout.write(`Production health check passed on attempt ${attempt}.\n`);
      return { attempt, status: response.status, origin: healthUrl.origin };
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(attempt * 1_000);
    }
  }

  throw new Error(
    `Production health check failed after ${attempts} attempt(s): ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    { cause: lastError },
  );
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  checkHealth({ baseUrl: process.env.FUNDOSMART_MONITOR_BASE_URL ?? process.argv[2] }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
