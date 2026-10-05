declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    ENVIRONMENT: string;
    ACCESS_TEAM_DOMAIN: string;
    ACCESS_AUD: string;
    INTERNAL_SYNC_TOKEN: string;
    /** Local development only (ENVIRONMENT=development): treat every request as this signed-in email. */
    DEV_AUTH_EMAIL?: string;
    /** Test only: migrations read by vitest.config.ts. */
    TEST_MIGRATIONS?: { name: string; queries: string[] }[];
  }
}

type Env = Cloudflare.Env;
