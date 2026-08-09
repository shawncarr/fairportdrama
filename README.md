# Fairport Drama Club

The Fairport High School Drama Club website, and the admin students and board
members use to maintain it.

Hono JSX on Cloudflare Workers, content in D1, images in Cloudflare Images,
auth by Better Auth. Server-rendered; the only client-side JavaScript is the
photo gallery lightbox and the contact form submit.

## Local development

```bash
npm install
npm run images:local     # loads the archive's images into the local KV shim
npm run db:migrate:local
npm run seed:build
npm run seed:apply:local
npm run dev              # http://localhost:8787
```

Local development never touches production. `APP_ENV` is `development` at the
top level of `wrangler.jsonc`, which selects the KV-backed image shim instead
of Cloudflare Images, and every binding is simulated by miniflare unless a
command is given `--remote`.

To get into the admin on a fresh database:

```bash
npm run bootstrap:admin -- you@example.com
```

Then sign in at `/admin/sign-in` with that address. Access is invite-only and
invites are issued by an admin, so this writes the first invite directly - the
only step that ever bypasses the admin UI. It refuses if an admin already
exists. The magic-link path needs no Google credentials, so it works before
OAuth is set up.

## Tests

```bash
npm run test             # both suites
npm run test:unit        # pure functions, node
npm run test:integration # real workerd and a real D1, via vitest-pool-workers
npm run typecheck
```

Coverage needs both runs merged, and the workers config uses istanbul because
v8 coverage requires the V8 inspector, which workerd does not implement - it
reports 0% silently.

## Deploying

Order matters. Skipping the migration step is what makes `seed:apply` fail
with `no such table: members`.

```bash
# 1. Secrets, once. Per environment: production secrets are not visible to
#    development and vice versa.
wrangler secret put BETTER_AUTH_SECRET --env production
wrangler secret put CONTACT_EMAIL --env production
wrangler secret put TURNSTILE_SECRET_KEY --env production
wrangler secret put GOOGLE_CLIENT_ID --env production
wrangler secret put GOOGLE_CLIENT_SECRET --env production

# 2. Schema, before any data
npm run db:migrate

# 3. Images, before the seed - the seed maps database columns to image ids
npm run images:upload
npm run seed:build          # warns if the manifest still holds local ids
npm run seed:apply

# 4. The Worker
npm run deploy              # wrangler deploy --env production
```

`CF_IMAGES_ACCOUNT_ID` and `CF_IMAGES_API_TOKEN` live in `.dev.vars` and are
needed only by `images:upload`, which runs on your machine. The deployed
Worker uploads through the `IMAGES` binding and holds no token.

### Things that have bitten

- **Migrations before seed.** `seed:apply` writes rows; it does not create
  tables.
- **Images before seed.** `seed:build` reads `seed/image-manifest.json` to
  fill image columns. Run it after `images:upload`, or every image column is
  either null or a local development id. It warns about the latter.
- **`SITE_URL` is the OAuth callback base.** Better Auth builds
  `/api/auth/callback/google` from it, so Google sign-in only works on the
  domain `SITE_URL` names. During a `workers.dev` shakedown, use the
  magic-link path and leave Google until the domain moves.
- **The newsletter table predates this project** and holds live subscribers.
  Migration 0000 creates it `IF NOT EXISTS`, and the seed never writes to it.

## Layout

```
src/routes/       public pages, admin, JSON endpoints
src/services/     everything that writes, each audited
src/lib/          auth, permissions, audit, images, markdown, dates
src/db/           schema and read queries
scripts/          one-off migration and image tooling
drizzle/          migrations
```

Two rules the code holds to, and which are worth knowing before changing it:

**Every mutation is audited**, in the same D1 batch as the change, through
`writeWithAudit`. D1 has no interactive transactions, so the audit row is a
statement the caller batches rather than a side effect it can forget.

**Member visibility is enforced in the query layer**, not in templates.
`toPublicMember` decides what leaves the database, so a new render site cannot
accidentally print a surname a student withheld. A hidden member has no detail
page at all, because the URL is their name.
