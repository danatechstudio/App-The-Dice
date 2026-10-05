# RTD Deployment

Everything runs in the existing Cloudflare account. These are one-off steps; they need your Cloudflare login, so they can't be run from Claude's environment.

## Quick path

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

1. **Create the credential.** In n8n, create a **Header Auth** credential named `RTD App Sync`, with name `Authorization` and value `Bearer <token from step 2>`.
2. **Add the app address.** Add a row to the `rtd_config` data table: `RTD_APP_BASE_URL` = `https://<host>`.
3. **Hand over to Claude.** Tell Claude, who then builds and tests **RTD Event Sync** ([RTD_N8N_WORKFLOWS.md](RTD_N8N_WORKFLOWS.md#planned-rtd-event-sync)).

## Local development

```sh
printf 'INTERNAL_SYNC_TOKEN=local-dev-token\nENVIRONMENT=development\nDEV_AUTH_EMAIL=you@example.com\n' > .dev.vars
npm run db:migrate:local
npm run dev                   # http://localhost:8787
```

`DEV_AUTH_EMAIL` only works when `ENVIRONMENT=development`. Never set either in production. `.dev.vars` is git-ignored.

## Costs

Expected traffic fits the free plans: Workers allows 100k requests a day, and D1 allows 5 GB with 5M reads a day. A sync uses about 10 D1 queries, under the free plan's per-request limit.
