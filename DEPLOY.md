# Deploying

Neon (Postgres) + Fly (the service) + R2 (the bytes) + Cloudflare Pages or
Vercel (the Studio). Everything the repository can decide in advance is
decided; what remains is three accounts and about twenty minutes.

Run these from a machine signed in to your own accounts — the tokens below
are credentials and should never reach a repository, a CI log, or an agent's
environment.

---

## 0. Decide the two hostnames first

`PUBLIC_BASE` is **baked into every published manifest**. Change it later and
every product already on a storefront points at a hostname that no longer
answers. So pick now, and pick under one registrable domain:

| | Example | Why |
| --- | --- | --- |
| Studio | `studio.allin-studio.com` | Where merchants sign in |
| Service | `api.allin-studio.com` | `PUBLIC_BASE` — permanent |
| Models | `models.allin-studio.com` | `CDN_BASE`, an R2 custom domain |

They must share a registrable domain. The session is a `SameSite=Lax`
cookie, and `studio.x.com` → `api.x.com` is same-site so it crosses freely.
Split them across two domains and the browser drops the cookie **in
silence** — you would see a sign-in that appears to work and then 401s.
(`COOKIE_SAMESITE=none` is the escape hatch; it forces `Secure`.)

---

## 1. Neon

```bash
# console.neon.tech → new project, region ap-southeast-1 (Singapore),
# Postgres 17, named "configurator".
```

Copy the **pooled** connection string — the host with `-pooler` in it. The
direct endpoint has a low connection cap and this service holds a pool.

```
postgres://user:pw@ep-xxx-pooler.ap-southeast-1.aws.neon.tech/configurator?sslmode=require
```

Keep `sslmode=require`: `main.ts` reads it and verifies the certificate
properly. No schema step — the service applies `sql/001_init.sql` on boot,
and every statement is `if not exists`.

## 2. R2

```bash
# dash.cloudflare.com → R2 → Create bucket "configurator",
# location Asia-Pacific.
```

Then, in order:

1. **API token**: R2 → Manage API Tokens → Create, *Object Read & Write*,
   scoped to this bucket. Note the access key id, the secret, and your
   account id.
2. **CORS**: bucket → Settings → CORS policy → paste
   `packages/api/r2-cors.json`. Without this the embed cannot fetch
   `model.glb` from the CDN and every configurator on every storefront shows
   an empty viewport.
3. **Custom domain**: bucket → Settings → Public access → Connect a domain →
   `models.allin-studio.com`. That hostname is `CDN_BASE`. Skip it and the
   service streams models itself — correct, just slower and billed.

## 3. Fly

```bash
curl -L https://fly.io/install.sh | sh
flyctl auth login

cd packages/api
flyctl launch --no-deploy --copy-config --name allin-configurator-api --region sin
```

`fly.toml` is already written — health checks on `/health`, TLS forced,
`min_machines_running = 1` (never scale to zero: a cold start mid-upload is
a lost sale, and the hourly janitor needs a machine to run on).

Set the secrets. Nothing here belongs in `fly.toml`:

```bash
flyctl secrets set \
  DATABASE_URL="postgres://…-pooler…?sslmode=require" \
  APP_BASE="https://studio.allin-studio.com" \
  PUBLIC_BASE="https://api.allin-studio.com" \
  STUDIO_ORIGINS="https://studio.allin-studio.com" \
  S3_BUCKET="configurator" \
  S3_REGION="auto" \
  S3_ENDPOINT="https://<account-id>.r2.cloudflarestorage.com" \
  S3_ACCESS_KEY_ID="…" \
  S3_SECRET_ACCESS_KEY="…" \
  CDN_BASE="https://models.allin-studio.com" \
  RESEND_API_KEY="…" \
  MAIL_FROM="Studio <studio@allin-studio.com>"
```

Deploy from the **repository root** — the image needs the workspace
lockfile and `packages/embed`, because the service imports the embed's
validator rather than keeping a second opinion about what a valid product is:

```bash
cd ../..                       # repo root
./scripts/deploy-api.sh        # checks, then flyctl deploy
```

Then point `api.allin-studio.com` at it:

```bash
flyctl certs add api.allin-studio.com
# add the CNAME/A records it prints, at your DNS provider
```

## 4. Email

Resend → add `allin-studio.com` → publish the SPF/DKIM records it gives you.
Until the domain verifies, sign-in links go nowhere and merchants cannot get
in. Without `RESEND_API_KEY` at all, links print to `flyctl logs` — usable
for your own first sign-in, not for anyone else.

## 5. The Studio

A static build. The service's URL is compiled in:

```bash
VITE_API_BASE=https://api.allin-studio.com npm run build -w @allin/studio
```

Deploy `packages/studio/dist` to Cloudflare Pages or Vercel, on
`studio.allin-studio.com`.

**It needs an SPA rewrite.** `/p/<id>` and `/signin` are client routes, so
anything without a file extension must return `index.html`. Vercel:

```json
{ "rewrites": [{ "source": "/((?!assets/).*)", "destination": "/index.html" }] }
```

Cloudflare Pages: a `_redirects` file containing `/* /index.html 200`.

## 6. The embed bundle

The snippet a merchant pastes references `embed.js` and `embed.css` at
`PUBLIC_BASE`. Upload `packages/embed/dist/*` to the R2 bucket at the root,
or serve them from the Studio's host and change `embedBase` in
`CloudPublish.tsx`. Keep the whole set together — `embed.js` fetches its
lazy chunks (typeface data, the engraving engine, the mesh decoder)
relative to its own URL.

---

## Checking it actually works

```bash
curl https://api.allin-studio.com/health
# {"ok":true,"at":"…"}
```

Then the real test, in a browser: sign in at the Studio, create a product,
import a model, **reload the page** — if the model comes back, Neon and R2
are both wired correctly. Publish, and open the live manifest URL. That is
the same path `packages/studio/test/cloud-check.mjs` drives against an
in-process stack, so if it passes there and fails here, the difference is
configuration, not code.

## What breaks, and what it looks like

| Symptom | Cause |
| --- | --- |
| Sign-in seems to work, then everything 401s | Studio and API on different registrable domains — the cookie was dropped. `COOKIE_SAMESITE=none`, or move them together. |
| Configurator loads, model never appears | R2 CORS not applied. |
| `/health` 503 | `DATABASE_URL` wrong, or Neon asleep on the free tier. |
| Sign-in emails never arrive | Resend domain unverified. |
| Published products 404 after a hostname change | `PUBLIC_BASE` was changed after publishing. See §0. |
| Rate limits behaving oddly | `TRUST_PROXY` false behind Fly, so every caller shares one bucket. |

## Cost, roughly

Neon free → $19/mo. Fly `shared-cpu-1x` 512 MB ≈ $2/mo. R2: 10 GB free, then
$0.015/GB, **no egress charge** — which is the reason it is R2 and not S3,
because models and artwork are the bandwidth here. Resend free to 3k
emails/month. Under $30 with real merchants on it.
