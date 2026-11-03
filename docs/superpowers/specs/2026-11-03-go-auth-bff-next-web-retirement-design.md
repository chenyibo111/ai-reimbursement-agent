# Go Auth BFF and Next.js Web Service Retirement

## Intent and scope

The user wants to stop the Next.js **Web service** while keeping the React workbench, Go reimbursement API, Feishu bot Worker, job Worker, and Agent event Worker. The React workbench currently uses Next.js only for `/api/auth/*`; therefore that interface must move before the `web` container is stopped. This changes local Compose startup for both ordinary and migration profiles. Removing the Next.js framework from the repository and migrating Node Workers are separate future work.

The Go API will contain the app-specific Auth BFF. Feishu SSO and Hydra remain the identity provider. The SSO project must not acquire reimbursement employee or role logic. The ordinary local Compose stack will also stop starting `web` by default; anyone explicitly needing the old UI can opt into its `legacy-web` profile.

## Approaches

1. **Add Auth BFF routes to the existing Go API (chosen).** The existing process already verifies Web JWTs and queries SSO session status. This keeps one API deployment and lets the edge route both `/api/auth/*` and `/api/v1/*` to Go. It increases the Go API's responsibility for OIDC state, browser cookies, and encrypted ID Tokens.
2. **Create a separate Go auth service.** This isolates OIDC secrets and browser sessions but adds a container, configuration, and a service boundary between authentication and the employee projection. The user chose the smaller existing-API approach.
3. **Run OIDC directly in React.** This would change the browser token and logout model and no longer preserve the existing HttpOnly session and short Web JWT contract. It does not fit the current immediate cross-project logout requirement.

## Existing behavior that must be preserved

- React requests `/api/auth/access-token`, redirects to `/api/auth/sso/login`, navigates to `/api/auth/sso/logout`, and sends the returned 15-minute `channel=web` JWT to `/api/v1/*`. Keep these paths and response fields so the React app need not change its auth flow.
- SSO client `reimbursement-web` uses issuer `http://localhost:4444/`, redirect `http://localhost:8088/api/auth/sso/callback`, post-logout `http://localhost:8088/logged-out`, and back-channel URL `http://host.docker.internal:8088/api/auth/sso/backchannel-logout`. Keeping the public paths means no SSO core or Hydra client registration change is required.
- A Web JWT contains `sub`, `role`, `aud=reimbursement-api`, `channel=web`, `sid`, `iat`, and `exp`. The Go Web resolver checks the current employee and SSO sid on every protected business request. Agent channel authentication remains separate.
- The Node Feishu bot still uses the Prisma `Employee` table and provisions its employee ID into `reimbursement.employees`. The SSO and bot use different Feishu applications, so their `open_id` values for the same person differ; React and bot identities are **not** automatically linked. Go Web login must preserve the current React employee ID for a given SSO `open_id` and must not attempt cross-application merging.
- Nginx currently sends `/api/auth/*` to `web:3000`, `/api/v1/*` to `reimbursement-api:8080`, and all other paths to the React static server.

## Go Auth BFF design

### Routes and OIDC

Add unauthenticated routes to the existing Go router, outside its Web bearer middleware:

- `GET /api/auth/sso/login`: validate a relative `returnTo`, create a short-lived state, nonce, and PKCE verifier, then redirect to Hydra's authorization endpoint with `openid profile feishu_identity`.
- `GET /api/auth/sso/callback`: require matching state, nonce, PKCE verifier, issuer, audience, signature, expiry, `sid`, and scoped `feishu_open_id`. Exchange the code using the exact registered redirect URI. An invalid callback creates no employee or session.
- `GET /api/auth/access-token`: validate the opaque HttpOnly session, check its sid with SSO, confirm the employee is active, and issue the existing short Web JWT and employee JSON shape. Revoked sessions return 401; unavailable SSO or storage returns 503. Do not cache a positive sid result across requests.
- `GET /api/auth/sso/logout`: validate the session and redirect to Hydra's end-session endpoint. Retain the local cookie and session until SSO revocation or a valid back-channel notification, so an unsuccessful logout can be retried.
- `POST /api/auth/sso/backchannel-logout`: accept exactly one form-encoded Logout Token; verify its signature and OIDC logout claims, then delete sessions for its sid. A forged notification must not delete sessions.

Keep the short-lived OIDC state, nonce, verifier, and return path in HttpOnly, SameSite=Lax cookies scoped to `/api/auth/sso`; clear them on callback. Use the canonical Hydra issuer in verification even when the Go container dials Hydra through `host.docker.internal`. Discovery/JWKS HTTP is a local-development concession; production requires HTTPS. The browser receives no ID Token or OIDC access token.

### Session and employee data

Create `reimbursement.sso_web_sessions` with a hash of a random opaque cookie, employee ID, sid, encrypted ID Token, and expiry. The Go Auth BFF owns this table; the existing Prisma `public.sso_web_sessions` table remains untouched for now. Keep the browser cookie name and `/api/auth` path, with HttpOnly, SameSite=Lax, and Secure on HTTPS. Existing Next.js cookies do not migrate; the first request after cutover returns 401 and React starts a new SSO login.

Preserve the current Next BFF employee mapping for the verified **SSO application** `feishu_open_id` in one PostgreSQL transaction across the Prisma `public."Employee"` table and `reimbursement.employees`:

1. If either table already has the open ID, reuse its employee ID; if both have different IDs, fail closed and report a reconciliation error.
2. If neither has it, allocate one UUID. Insert the missing record in each table with that same ID. Unique constraints and retry-on-conflict protect concurrent identity creation for one open ID.
3. Apply the existing administrator and finance-reviewer allowlists using the SSO application's open IDs, and update the Go employee projection. The retained bot uses its own application open IDs; this migration does not reconcile them.

Grant the Go Auth BFF's database connection only the public employee table rights it needs, in addition to its reimbursement schema rights. Do not use the SSO database as the reimbursement employee source. Do not delete existing employees, claims, bot conversations, or old Prisma sessions during this cutover.

### Logout and failure behavior

The SSO service continues to revoke the Hydra sid and send back-channel notifications. The existing Go Web middleware still calls `/internal/session-status` on each protected business request. The new Go Auth BFF performs the same live sid check before issuing a JWT. A missed back-channel notification therefore delays local row deletion but does not preserve access after SSO revocation. SSO or database failure denies access without asserting that logout completed.

## Deployment and cutover

1. Add Go migration and auth routes while Next.js remains running. Test the Go handlers directly, including real local Hydra integration with a synthetic SSO member; then test with both real test-enterprise members in separate browser sessions.
2. Change Nginx `/api/auth/*` to `reimbursement-api:8080`. Keep `/api/v1/*` and `/` as they are. Keep `/internal/*` unreachable from the edge.
3. Remove `web` from the migration edge's `depends_on` and put the Next.js `web` service behind a `legacy-web` Compose profile. This disables it for ordinary Compose startup, including the existing non-migration stack. Stop existing `web` containers only after the new auth path works. The old UI source and Prisma tables remain available for a later cleanup, and an explicit `--profile legacy-web` remains possible for troubleshooting.
4. Leave Feishu bot, job, and Agent event Workers as Node processes. Their current shared Dockerfile still runs `next build`; a worker-only image is separate future work. Thus this phase stops the Next.js **runtime service**, not the framework's build dependency.

## Acceptance

- With the Next.js `web` container stopped, React can sign in through the Go BFF, obtain a Web JWT, and use Go claims APIs as two distinct test-enterprise members.
- A member who logged into React through the current Next BFF retains the same employee ID and Go claim ownership after switching to Go login. The `public."Employee"` row and `reimbursement.employees` projection use the same ID for that SSO open ID. A bot identity with a different Feishu application open ID remains separate, as before.
- Logging out from React or demo A/B immediately makes the pre-logout Web JWT and `/api/auth/access-token` unusable. Valid back-channel notification removes the Go session. Forged notifications are rejected.
- SSO outage makes auth and protected Go Web requests fail closed; Agent channel and Node Workers keep their existing behavior.
- Compose starts the migration edge, React, Go API, and required dependencies without a Next.js `web` container. The browser paths and SSO client registration remain unchanged.

## Deferred work

This phase does not remove Next.js source, Prisma schema, the old UI's API routes, or the Node Workers. It does not migrate existing browser sessions or old Next.js claim records. A future worker-image split can eliminate `next build` from Worker deployments; moving Workers to Go is a separate project.
