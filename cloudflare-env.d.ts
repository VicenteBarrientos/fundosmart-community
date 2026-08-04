declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    FILES: R2Bucket;
    IMAGES: ImagesBinding;
    ASSETS: Fetcher;
    AI?: Ai;
    EMAIL?: SendEmail;
    METRICS?: AnalyticsEngineDataset;
    MAP_USAGE?: AnalyticsEngineDataset;
    AUTH_ORIGIN?: string;
    FUNDOSMART_DEPLOY_ENVIRONMENT?: string;
    FUNDOSMART_RELEASE_SHA?: string;
    FUNDOSMART_APP_BASE_URL?: string;
    FUNDOSMART_EMAIL_FROM?: string;
    FUNDOSMART_INBOX_DOMAIN?: string;
    GOOGLE_CLIENT_ID?: string;
    GOOGLE_CLIENT_SECRET?: string;
    FUNDOSMART_OWNER_EMAIL?: string;
    // Local-development identity override (set only in gitignored .dev.vars).
    DEV_AUTH_EMAIL?: string;
    DEV_AUTH_NAME?: string;
    CDSE_CLIENT_ID?: string;
    CDSE_CLIENT_SECRET?: string;
    OFFLINE_SESSION_SECRET?: string;
    ASSISTANT_CONFIRMATION_SECRET?: string;
    AI_KEYS_ENCRYPTION_SECRET?: string;
  }
}
