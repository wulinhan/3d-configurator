# Deploying

Neon (Postgres) + Fly (the service) + R2 (the bytes) + Cloudflare Pages or
Vercel (the Studio). Everything the repository can decide in advance is
decided; what remains is three accounts and about twenty minutes.

Run these from a machine signed in to your own accounts — the tokens below
are credentials and should never reach a repository, a CI log, or an agent's
environment.

---

## 0. Decide the two hostnames first

`PUBLIC_BASE` is the hostname merchants **paste into their own storefronts**.
Nothing is stored — every URL the service hands out is built at serve time —
but the snippet lives in someone else's HTML, and you cannot edit that. So if
it ever has to change, the old hostname must keep answering (a redirect is
enough). Easier to pick once:

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

## 0b. Does the domain have to move to Cloudflare?

Only for an R2 **custom domain**. Cloudflare will only attach one to a zone
it hosts, and `allin-studio.com` currently is not one — so that step means
changing the registrar's nameservers, which moves DNS for the live marketing
site too. Cloudflare imports the existing records first and you check them
before flipping, but it is still a change to something that is working.

You do not have to decide now. Use the r2.dev URL, ship, and move the zone
later if the rate limit ever matters: `CDN_BASE` is a Fly secret, not a
stored value, so switching is one `flyctl secrets set` and a restart.

`api.` and `studio.` need no such thing — those are ordinary CNAMEs at
whatever DNS provider you already use.

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
3. **Public access**, one of two ways. `CDN_BASE` is read on every request
   and never stored, so this one is genuinely reversible — start with
   whichever is quicker:
   - **r2.dev subdomain** (bucket → Settings → Public access → Allow):
     zero setup, no DNS, rate-limited and not meant for production traffic.
     Fine for the first weeks.
   - **Custom domain** → `models.allin-studio.com`. Needs the DNS zone to be
     on Cloudflare, which for `allin-studio.com` means moving nameservers —
     see §0b.

   Leave `CDN_BASE` unset entirely and the service streams models itself:
   correct, just slower and billed for egress.

## 3. Fly — from the browser

No local `flyctl`. Three screens and a button.

**a. Create the app.** fly.io → sign up → add a payment method (Billing).
Then *Launch an app* → **Create app manually** (not the GitHub importer —
`fly.toml` is already in the repo and the importer would write its own).

Name it exactly **`allin-configurator-api`**, org `personal`. The name has to
match `app =` in `packages/api/fly.toml`, or the deploy targets nothing.

**b. Set the secrets.** App → **Secrets** → *New secret*, one at a time.
These never go in `fly.toml`, which is committed:

| Name | Value |
| --- | --- |
| `DATABASE_URL` | the **whole** `postgresql://…` connection string, with the pooled (`-pooler`) host in it — NOT just the host field. See §1. |
| `APP_BASE` | `https://studio.allin-studio.com` |
| `PUBLIC_BASE` | `https://api.allin-studio.com` |
| `STUDIO_ORIGINS` | `https://studio.allin-studio.com` |
| `S3_BUCKET` | `configurator` |
| `S3_REGION` | `auto` |
| `S3_ENDPOINT` | `https://<account-id>.r2.cloudflarestorage.com` |
| `S3_ACCESS_KEY_ID` | from the R2 token |
| `S3_SECRET_ACCESS_KEY` | from the R2 token |
| `CDN_BASE` | the `pub-….r2.dev` URL |

Fly will say the app has no machines yet. That is expected — secrets are
stored against the app and applied when the first one starts.

**c. Give GitHub a deploy token.** Fly → **Tokens** (account level, or
App → Tokens for one scoped to this app — prefer the scoped one). Create a
deploy token, copy it.

In GitHub: repo → Settings → Secrets and variables → Actions → *New
repository secret* → name `FLY_API_TOKEN`, paste.

**d. Deploy.** Repo → **Actions** → *Deploy API to Fly* → **Run workflow**.

It installs, runs all three unit suites, builds on Fly's remote builder (so
nothing needs Docker), deploys, and then polls `/health` from outside until
the machine answers. Roughly four minutes. After this, every push to `main`
that touches `packages/api` deploys itself.

**e. The hostname.** App → **Certificates** → *Add certificate* →
`api.allin-studio.com`. Add the **CNAME only** — `api` pointing at the
`<something>.<app>.fly.dev` value Fly shows. That is the whole requirement.

The ACME DNS challenge on the same page is labelled optional and means it:
it exists so you can have the certificate issued *before* pointing traffic
at Fly. Add the CNAME and Fly validates over HTTP by itself, usually within
a minute or two of the record propagating.

Ignore "your app does not have any IPv6 records allocated" if you see it
before the first successful deploy — deploying allocates the IPs, and the
warning is just stale.

Until then the app is already reachable at
`https://allin-configurator-api.fly.dev`, which is enough to test with.

> If you would rather use the CLI, `scripts/deploy-api.sh` does the same
> thing locally: checks, secret presence, deploy, health.

## 4. Email

`MAIL_FROM` may be any address on any domain **already verified in your
Resend account** — it does not have to match the Studio's domain, and the
sign-in link inside the email points at `APP_BASE` regardless. The ERP and
marketing site already send through Resend as
`notifications@allincreatives.com`, so the zero-setup path is to reuse that
domain: create a SEPARATE API key for this service (rotating one app's key
must not break the other), then set `RESEND_API_KEY` and
`MAIL_FROM=Allin Studio <notifications@allincreatives.com>` as Fly secrets.
No DNS, no verification wait.

Order matters if you ever DO verify a new domain: verify first, secrets
after. The moment `RESEND_API_KEY` is set, links stop printing to the log —
and an unverified from-domain means Resend rejects every send and nobody
can sign in at all.

Resend's free tier is one domain and 3,000 emails/month (100/day), shared
across everything the account sends. Real marketing volume is the moment to
go paid, add a second domain, and split marketing from transactional so a
spam-flagged campaign cannot drag order and sign-in mail down with it.

Without `RESEND_API_KEY` at all, links print to `flyctl logs` — usable for
your own first sign-in, not for anyone else.

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
| `/health` 503 | `DATABASE_URL` wrong, or the pooled host was not used. |
| Sign-in emails never arrive | Resend domain unverified. |
| Published products 404 after a hostname change | `PUBLIC_BASE` was changed after publishing. See §0. |
| Rate limits behaving oddly | `TRUST_PROXY` false behind Fly, so every caller shares one bucket. |

## One interaction to know about

Fly checks `/health` every 15 seconds, and `/health` runs `select 1` — which
is the point of it, since a machine that cannot reach Postgres must leave the
load balancer. But it also means **the database never goes idle**, so Neon's
scale-to-zero never kicks in and the compute runs continuously.

That is what you want for a service merchants are using: a cold Postgres on
the first real request is worse than a warm one costing a few dollars. It
does mean the free tier's compute allowance is not a realistic plan — budget
for Neon Launch. If you would rather stay free while nobody is using it, say
so and I will make the database probe optional; the check then only proves
the process is alive, which is a real downgrade and should be a choice
rather than a default.

## Cost, roughly

Neon free → $19/mo. Fly `shared-cpu-1x` 512 MB ≈ $2/mo. R2: 10 GB free, then
$0.015/GB, **no egress charge** — which is the reason it is R2 and not S3,
because models and artwork are the bandwidth here. Resend free to 3k
emails/month. Under $30 with real merchants on it.
