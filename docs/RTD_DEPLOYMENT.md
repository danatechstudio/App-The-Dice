# RTD Deployment

Everything runs in the existing Cloudflare account. These are one-off steps. They need either your Cloudflare login (on your own machine), or a `CLOUDFLARE_API_TOKEN` in an environment that can reach `api.cloudflare.com`.

## Status (2026-10-06)

Done through the Cloudflare connector:
- **Database:** D1 `rtd-app` created in Western Europe (id `6c948ad3-0311-459b-895d-facb14d5697d`, now in `wrangler.jsonc`).
- **Schema:** `0001_foundation.sql`, `0002_event_images.sql`, `0003_host_sessions.sql`, `0004_host_session_frequency.sql`, `0005_host_session_access.sql`, `0006_host_publishing.sql`, `0007_onboarding.sql` and `0008_bookings.sql` applied and recorded in `d1_migrations`, so `wrangler d1 migrations apply` will skip them. All tables, indexes and both audit triggers are present.
- **First admin:** Dan's account added (role `admin`).

The connector can't deploy code, set secrets or configure Access, so three dashboard steps remain.

### A. Deploy from GitHub (Workers Builds)
1. Go to Workers & Pages → **Create application** → **Import a repository**.
2. Choose GitHub, allow access to `danatechstudio/App-The-Dice`, and select it.
3. Set the project name to **`rtd-app`** (it must match `name` in `wrangler.jsonc`).
4. Leave the deploy command as `npx wrangler deploy`. Set the build command to `npm test`, so a failing test blocks the deploy.
5. Select **Save and Deploy**.

From then on, every push to `main` deploys automatically. The address will be `https://rtd-app.<your-subdomain>.workers.dev`.

### B. Sync token secret
1. Go to Worker `rtd-app` → **Settings → Variables and Secrets** → Add.
2. Choose type **Secret**, name `INTERNAL_SYNC_TOKEN`, and a long random value (e.g. 40+ characters from a password manager).
3. Keep the value for the n8n credential `RTD App Sync` (step 6 below). Deploys from Git keep secrets.

### C. Staff sign-in (Access on `/api/staff` only)
Don't use the one-click "Enable Cloudflare Access" button. It protects the whole Worker, including the public diary.

1. Go to Zero Trust → Access → Applications → **Add an application → Self-hosted**.
2. Name it `RTD Staff`. Domain: `rtd-app.<your-subdomain>.workers.dev`, path `api/staff`.
3. Login method: **One-time PIN**. Policy: **Allow**. For Include, use specific emails, or Everyone (the app's `users` table still decides roles).
4. Save, then copy the application's **AUD tag** and your **team domain** (`https://<team>.cloudflareaccess.com`).
5. Send Claude the AUD tag, the team domain and the `workers.dev` address. These are identifiers, not secrets. Claude puts them in `wrangler.jsonc` and pushes, which redeploys.

### The app (Phase 2): no extra steps
- **Build:** `wrangler.jsonc` builds the PWA (`npm run build:web`) before every deploy, and `npm test` builds it too. The existing Workers Builds settings (build `npm test`, deploy `npx wrangler deploy`) carry on unchanged.
- **Node:** the build image's default Node 24 works.
- **New variable:** `VENUE_LOCATION` (calendar location) is set in `wrangler.jsonc`. Change it there, not in the dashboard.

### Event photos: done through the connector
- **KV namespace:** `rtd-app-images` (id `0a23bcba51b84a749f7c64935fa53335`), bound as `IMAGES` in `wrangler.jsonc`.
- **Migration:** `0002_event_images.sql` applied and recorded in `d1_migrations`.

### Host organiser sign-in
Sign-in goes through the RTD Staff Access application at `/api/staff/sign-in`, so no extra Access paths are needed. For hosts to sign in, the application's policy must include them (Include → Everyone recommended). Details: [RTD_HOST_PORTAL.md](RTD_HOST_PORTAL.md#signing-in).

**Onboarding needs Include → Everyone.** New hosts and café staff ask for access from the join screen, so they must be able to sign in before anyone approves them. With a list of specific emails, nobody new can reach the join screen. Details: [RTD_ONBOARDING.md](RTD_ONBOARDING.md#before-anyone-can-apply).

### Future migrations
Claude applies new files in `migrations/` through the connector and records them in `d1_migrations`. Alternatively, change the Workers Builds deploy command to `npx wrangler d1 migrations apply rtd-app --remote && npx wrangler deploy`.

## Quick path (alternative: from your own machine)

Steps 1–3 and 5 are one command. It is safe to re-run, because it skips whatever already exists:

```sh
./scripts/cloudflare-setup.sh you@example.com
```

1. **Sign in.** Run `npx wrangler login` first, or set `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
2. **Commit the database id.** The script writes it into `wrangler.jsonc`; commit that change.
3. **Copy the sync token.** The script creates it in `.rtd-sync-token`, which is git-ignored. Copy it into n8n (step 6), then delete the file.

Then do step 4 (Access) and step 6 (n8n). The manual equivalents of every step are below.

## Prerequisites

- Node 22, then `npm ci` in this repo.
- `npx wrangler login`, or set `CLOUDFLARE_API_TOKEN` with Workers, D1 and Access edit rights.

## 1. Database

```sh
npx wrangler d1 create rtd-app
```

1. Put the printed `database_id` into `wrangler.jsonc`, replacing the zeros.
2. Commit that change.
3. Apply the schema:

```sh
npm run db:migrate:remote
```

## 2. Sync token

```sh
openssl rand -hex 32          # keep this value for the n8n credential in step 6
npx wrangler secret put INTERNAL_SYNC_TOKEN
```

## 3. Deploy

```sh
npm test && npm run deploy
```

This prints `https://rtd-app.<your-subdomain>.workers.dev`. To use your own domain instead (e.g. `app.<rtd-domain>`), go to Workers & Pages → rtd-app → Settings → Domains & Routes → Add custom domain.

Check: `curl https://<host>/api/health` should return `{"ok":true,"last_sync":null}`.

## 4. Staff sign-in (Cloudflare Access)

1. **Turn on one-time PIN.** Go to Zero Trust → Settings → Authentication → Login methods, and enable **One-time PIN**.
2. **Create the Access application.** Go to Zero Trust → Access → Applications → Add an application → Self-hosted.
   - Domain: your app host. Path: `api/staff`. Add more paths later for `api/host`, `staff` and `host`.
   - Policy: **Allow**, Include **Everyone**. Access only proves the email address; the app's `users` table decides who gets in. For extra safety you can list specific emails here instead.
3. **Point the app at Access.** Copy the application's **AUD tag** and your team domain (`https://<team>.cloudflareaccess.com`) into `wrangler.jsonc` → `vars.ACCESS_AUD` and `vars.ACCESS_TEAM_DOMAIN`. Then run `npm run deploy` again.

While these vars are empty, every staff request is refused.

## 5. First admin

```sh
npx wrangler d1 execute rtd-app --remote --command \
  "INSERT INTO users (user_id, email, role, created_at, updated_at)
   VALUES ('admin-1', 'you@example.com', 'admin', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))"
```

Then open `https://<host>/api/staff/me`, sign in with the emailed PIN, and check that it shows your role.

## 6. Connect n8n

`rtd_config` already holds `RTD_APP_BASE_URL`, and the **RTD Event Sync** workflow is built.

1. In n8n, open **RTD Event Sync** → node **Send Snapshot To App** → Credential → *Create new*.
2. Choose type **Header Auth** (it is titled `rtd-app` in n8n). Set the header **Name** to `Authorization` and the **Value** to `Bearer <the INTERNAL_SYNC_TOKEN value>`. The credential's title doesn't matter; the header Name does.
3. Save the credential and the workflow. Tell Claude, who runs it once by hand, checks the result in D1, then switches it on.

If a run fails, n8n's error gives the app's reason:
- **503** "no INTERNAL_SYNC_TOKEN secret": the Worker has no secret. Add it as type **Secret** under the Worker's own Settings → Variables and Secrets. Build variables don't count.
- **401** "Missing Authorization header": the credential's header Name isn't `Authorization`.
- **401** "must be 'Bearer <token>'": the credential value is missing the `Bearer ` prefix.
- **401** "does not match": the credential and the Worker secret hold different values.

## Local development

```sh
printf 'INTERNAL_SYNC_TOKEN=local-dev-token\nENVIRONMENT=development\nDEV_AUTH_EMAIL=you@example.com\n' > .dev.vars
npm run db:migrate:local
npm run dev                   # builds the app; everything on http://localhost:8787
npm run dev:web               # optional: live-reloading app on :5173, using the Worker on :8787 for /api
```

`npm run dev` serves the app as built. After changing files in `web/`, restart it, or use `dev:web` alongside it.

`DEV_AUTH_EMAIL` only works when `ENVIRONMENT=development`. Never set either in production. `.dev.vars` is git-ignored.

## Costs

Expected traffic fits the free plans: Workers allows 100k requests a day, and D1 allows 5 GB with 5M reads a day. A sync uses about 10 D1 queries, under the free plan's per-request limit.
