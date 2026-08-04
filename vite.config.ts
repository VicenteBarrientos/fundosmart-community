import vinext from "vinext";
import { defineConfig } from "vite";

const d1DatabaseId = process.env.FUNDOSMART_D1_DATABASE_ID?.trim();
const emailSender = process.env.FUNDOSMART_EMAIL_FROM?.trim();
const enableAnalytics = process.env.FUNDOSMART_ENABLE_ANALYTICS === "true";

const workerVars = {
  FUNDOSMART_DEPLOY_ENVIRONMENT:
    process.env.FUNDOSMART_DEPLOY_ENVIRONMENT?.trim() || "development",
  FUNDOSMART_RELEASE_SHA:
    process.env.FUNDOSMART_RELEASE_SHA ?? process.env.GITHUB_SHA ?? "local-build",
  ...(process.env.FUNDOSMART_APP_BASE_URL?.trim()
    ? { FUNDOSMART_APP_BASE_URL: process.env.FUNDOSMART_APP_BASE_URL.trim() }
    : {}),
  ...(emailSender ? { FUNDOSMART_EMAIL_FROM: emailSender } : {}),
};

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";
const localStatePath = process.env.FUNDOSMART_LOCAL_STATE_PATH?.trim() || ".wrangler/state";

const localBindingConfig = {
  name: process.env.FUNDOSMART_WORKER_NAME?.trim() || "fundosmart-community",
  main: "./worker/index.ts",
  compatibility_date: "2026-07-18",
  compatibility_flags: ["nodejs_compat"],
  assets: {
    binding: "ASSETS",
  },
  images: {
    binding: "IMAGES",
  },
  d1_databases: [
    {
      binding: "DB",
      database_name:
        process.env.FUNDOSMART_D1_DATABASE_NAME?.trim() || "fundosmart-community-local",
      ...(d1DatabaseId ? { database_id: d1DatabaseId } : {}),
      migrations_dir: "drizzle",
    },
  ],
  r2_buckets: [
    {
      binding: "FILES",
      bucket_name:
        process.env.FUNDOSMART_R2_BUCKET_NAME?.trim() || "fundosmart-community-files",
    },
  ],
  ...(emailSender
    ? {
        send_email: [
          {
            name: "EMAIL",
            allowed_sender_addresses: [emailSender],
          },
        ],
      }
    : {}),
  ...(enableAnalytics
    ? {
        analytics_engine_datasets: [
          {
            binding: "METRICS",
            dataset:
              process.env.FUNDOSMART_METRICS_DATASET?.trim()
              || "fundosmart_community_observability",
          },
          {
            binding: "MAP_USAGE",
            dataset:
              process.env.FUNDOSMART_MAP_USAGE_DATASET?.trim()
              || "fundosmart_community_map_usage",
          },
        ],
      }
    : {}),
  observability: {
    enabled: true,
    logs: {
      enabled: true,
      head_sampling_rate: 1,
      invocation_logs: true,
    },
    traces: {
      enabled: true,
      head_sampling_rate: 0.05,
    },
  },
  triggers: {
    crons: ["17 */6 * * *"],
  },
};

export default defineConfig(async ({ command }) => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");

  return {
    server: isCodexSeatbeltSandbox
      ? { watch: { useFsEvents: false, usePolling: true } }
      : undefined,
    plugins: [
      vinext(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        persistState: { path: localStatePath },
        // Builds declare only non-secret release metadata. Google credentials
        // remain Worker secrets and local identities stay in ignored .dev.vars.
        config: {
          ...localBindingConfig,
          ...aiBindingConfig(command),
          vars: command === "build" ? workerVars : {},
        },
      }),
    ],
  };
});

function aiBindingConfig(command: "build" | "serve") {
  if (process.env.FUNDOSMART_ENABLE_AI !== "true") return {};
  if (command === "build" || process.env.CI === "true") return { ai: { binding: "AI" } };
  return process.env.FUNDOSMART_ENABLE_REMOTE_AI === "true"
    ? { ai: { binding: "AI", remote: true } }
    : { ai: { binding: "AI" } };
}
