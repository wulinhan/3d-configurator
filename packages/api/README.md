# The service

What turns the Studio from an app that loses your work when you close the tab
into something a merchant can sign into. Three jobs, and nothing else yet:

1. **Accounts and saved projects** — sign in, invite your team, autosave.
2. **Publishing** — freeze a version at a URL a storefront can embed.
3. **Customer artwork** — take the upload so the cart carries an id, not a
   megabyte of base64.

It is a plain Node HTTP service. No framework: the router, the body reader
and the CORS rules are about two hundred lines in `src/http.ts`, and a
dependency that owned the request lifecycle would be the largest thing in
the repository.

```
sql/001_init.sql   the whole schema, heavily commented — most of the
                   service's guarantees live in its constraints
src/sql.ts         the one thing it asks of a database: parameterised SQL
src/store.ts       every query, with the tenancy check IN the query
src/http.ts        router, body limits, cookies, CORS, rate limiting
src/app.ts         assembly: takes its world (db, storage, mail, clock) as
                   an argument, which is why the tests need none of it
src/routes/studio.ts   what the Studio calls
src/routes/public.ts   what a customer's browser touches
src/storage.ts     memory / filesystem / S3-compatible, one interface
src/main.ts        the only file that decides what the real world is
```

## Running it

```
DATABASE_URL=postgres://localhost/configurator npm run dev:api
```

Everything else has a default that works locally: bytes go to `./.storage`,
sign-in links print to the console instead of being emailed, and cookies are
allowed over plain HTTP. For a real deployment:

| Variable | What it does |
| --- | --- |
| `DATABASE_URL` | Postgres. Required. |
| `APP_BASE` | The Studio's URL — sign-in links point here. |
| `PUBLIC_BASE` | This service's URL — manifest, model and upload URLs are built from it. |
| `STUDIO_ORIGINS` | Comma-separated. Cookie-authenticated writes must come from one of these; this is the CSRF defence. |
| `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | Object storage. `S3_ENDPOINT` too for R2/MinIO/Spaces. |
| `CDN_BASE` | A CDN in front of the bucket. Set it and published models never pass through this process. |
| `RESEND_API_KEY`, `MAIL_FROM` | Email. Without them, links print to the log. |
| `COOKIE_SECURE` | `false` only for plain-HTTP local development. |
| `COOKIE_SAMESITE` | `lax` (default) when the Studio shares a domain with this service; `none` otherwise — see below. |
| `TRUST_PROXY` | `true` behind a load balancer. Read `clientIp` before setting it. |

The schema applies itself on boot — every statement is `if not exists`,
which is how a service this size should migrate.

## The decisions worth knowing

**Tenancy is enforced in SQL, not in handlers.** `projectFor(sql, id, userId)`
joins `memberships`; a non-member's query returns no rows. There is no
`if (project.orgId !== user.orgId)` to forget, because that is exactly the
line multi-tenant services forget. A stranger gets 404 rather than 403 —
a 403 would confirm the id exists.

**Autosave uses optimistic concurrency.** `PUT /v1/projects/:id` carries the
revision it last read. If the row has moved on, the write is refused with a
409 and the current revision. Two tabs open on one project is a normal
accident; silently keeping the slower tab's copy is how a morning's work
disappears.

**An autosave never validates.** A draft mid-edit is often incomplete, and
refusing to store it loses an afternoon to a rule that only matters at
publish. So the manifest is stored either way and marked `valid`;
`POST /publications` is where validation is a gate.

**Publications are copies, not pointers.** Publishing snapshots the manifest
and the compressed GLB. A product edited in March must not silently change
what someone bought in February.

**Two URLs, on purpose.**
`/p/:publication/manifest.json` is frozen and cached for a year — it is what
an order pins. `/e/:project/manifest.json` follows the merchant's live
pointer with a one-minute cache — it is what they paste into their store. If
storefronts embedded the version id, every publish would mean re-pasting the
snippet; if orders recorded the live URL, last month's order would become
this month's product.

**Uploads exist because a data: URL cannot survive a checkout.** Most carts
cap a line-item property at 255 characters, and an image zone's artwork is
up to 1.5 MB of base64. So the image is posted to `/v1/uploads` and the
selection carries `{ "img": "https://…/u/upl_x", "up": "upl_x", … }` — a few
dozen characters. The switch is the `uploads` block the service injects when
it serves a published manifest: with no block, the embed inlines the image
exactly as before, so a merchant hosting two files on a CDN still needs no
server at all.

**What an upload is checked against is the manifest the customer is looking
at.** The zone's `accept` and `maxBytes` come from that published version, so
a merchant who allowed 3 MB on one product gets 3 MB there and nowhere else.
The bytes are sniffed rather than trusted — a declared Content-Type is a
claim by the caller — and SVG is refused outright rather than sniffed,
because it is a document that can carry script and we serve these back.

**The origin allowlist starts empty, meaning open.** Nobody's first
integration should fail on a setting they have not been told about yet.
Once set it governs reads AND uploads.

## Tests

```
npm run test:unit -w @allin/api
```

See `DEPLOY.md` at the repository root for Neon + Fly + R2.

37 tests, against **real Postgres** — PGlite is Postgres compiled to WASM, so
the cascades, unique indexes, `returning` and transactions under test are the
ones that ship. A hand-written fake store would have passed every one of them
while proving nothing about `001_init.sql`, which is where the guarantees
actually are. (It earned its keep immediately: the first run found that
`publications.glb_asset_id` had no delete rule, so deleting an org deadlocked
against its own cascade.)

```
test/store.test.ts  14 — the data layer: an email is one account however it
                    is typed, a magic link is single-use and short-lived, a
                    session stops resolving when it expires but is only
                    deleted by the janitor, an org can never be left without
                    an owner, a project is invisible outside its org,
                    autosave refuses to overwrite a newer revision, history
                    is kept and kept bounded, the same bytes saved twice are
                    one asset (and one org's dedupe cannot probe another's),
                    publishing freezes a version and moves the live pointer,
                    the allowlist belongs to the product rather than to one
                    version, abandoned artwork is swept while ordered
                    artwork is kept, deleting an org really deletes
                    everything it owns, and a pasted DATABASE_URL is
                    recovered from its label, quotes and line breaks
test/api.test.ts    23 — the service through its own front door, on a real
                    socket with fetch: a magic link signs you in once and
                    gives you a workshop, an unknown address is answered
                    exactly like a known one, a cookie is not enough for a
                    write (the Origin must be the Studio's), autosave
                    conflicts return the current revision, an incomplete
                    draft still saves, a stranger gets 404 and a viewer gets
                    403, the workspace model round-trips and dedupes,
                    publishing freezes the product while the draft moves on,
                    an invalid product cannot be published, the allowlist
                    decides which storefronts may embed, artwork comes back
                    as an id short enough for a cart, an upload is checked
                    against the very product it claims to belong to, a
                    zone that allows 400 kB does not allow a megabyte, the
                    dashboard thumbnail round-trips under the same
                    permissions as everything else, a cart's total is
                    re-derived from the frozen manifest rather than read
                    out of the request, a verified Google token lands in
                    the same account its email would (and an unverifiable
                    one gets a single uniform refusal), the Turnstile gate
                    keeps the link-sender from sending for bots, and no
                    inbox can be sent more than five links an hour however
                    many addresses ask
```

## Deploying it next to the Studio

The session is a cookie, so **the Studio and this service must share a
registrable domain** — `studio.example.com` and `api.example.com` are the
same site and a `SameSite=Lax` cookie crosses between them freely. Put them
on genuinely different domains and the browser drops the session silently,
which is a miserable thing to debug; `COOKIE_SAMESITE=none` is the escape
hatch and forces `Secure` with it.

The Studio is built against the service with one variable:

```
VITE_API_BASE=https://api.example.com npm run build -w @allin/studio
```

Leave it unset and the Studio is exactly what it was before this service
existed — import, author, download two files, no account. That is not a
fallback mode; it is a supported way to run, and the browser checks cover it.

Serving the Studio needs an **SPA rewrite**: `/p/<id>` and `/signin` are
client routes, so anything without a file extension must return
`index.html`. On Vercel/Netlify that is one line; behind nginx it is
`try_files $uri /index.html`.
