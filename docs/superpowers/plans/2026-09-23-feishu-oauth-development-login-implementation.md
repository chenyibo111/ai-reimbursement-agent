# Feishu OAuth Development Login Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Feishu OAuth login plus a development-only demo login that both issue the existing server-verified reimbursement session.

**Architecture:** An auth provider boundary exchanges Feishu OAuth codes and exposes a normalized identity. Route handlers validate OAuth state, map the identity to `Employee`, and issue/clear HttpOnly session cookies. The demo route uses the same issuer but is disabled in production.

**Tech Stack:** Next.js route handlers, Node crypto, Prisma/PostgreSQL, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-23-feishu-oauth-development-login-design.md`

## Global Constraints

- Never accept employee identity directly from browser request payloads.
- Keep client secrets and OAuth tokens out of URLs, logs, audit payloads, and client storage.
- Production must reject the development login route.
- Session and state cookies are HttpOnly and SameSite=Lax; production cookies are Secure.

## Review Focus

- Missing or tampered OAuth state must not issue a session.
- OAuth callback with a missing `open_id` must not create an employee.
- Production must return 404 for development login even with valid demo configuration.
- Existing Feishu identity must resolve to the same local employee on repeat login.
- Callback failure must clear temporary OAuth state before returning an actionable error.

---

### Task 1: Add Auth Configuration, Cookie Helpers, and Feishu Provider Boundary

**Files:**
- Create: `src/server/auth-cookies.ts`
- Create: `src/infrastructure/auth/feishu-oauth.ts`
- Modify: `src/server/config.ts`
- Modify: `.env.example`
- Test: `tests/unit/server/auth-cookies.test.ts`
- Test: `tests/unit/infrastructure/feishu-oauth.test.ts`

**Interfaces:**
- Produces: `createOAuthState(): string`, `oauthStateCookie(value: string): string`, `sessionCookie(actorId: string): string`.
- Produces: `FeishuOAuthClient.exchangeCode(code): Promise<{ openId: string; unionId?: string; displayName?: string }>`.

- [ ] **Step 1: Write failing tests**

```ts
it("marks production session cookies Secure and HttpOnly", () => {
  expect(sessionCookie("employee-1", true)).toContain("HttpOnly");
  expect(sessionCookie("employee-1", true)).toContain("Secure");
});

it("rejects an OAuth identity without openId", async () => {
  await expect(client.exchangeCode("code")).rejects.toThrow("feishu identity is incomplete");
});
```

- [ ] **Step 2: Run the tests**

Run: `npm exec vitest -- run tests/unit/server/auth-cookies.test.ts tests/unit/infrastructure/feishu-oauth.test.ts`

Expected: FAIL because auth modules do not exist.

- [ ] **Step 3: Implement helpers and provider**

Use `crypto.randomBytes(32).toString("base64url")` for state. Use the existing `createSessionToken` with `SESSION_SECRET`. The provider reads `FEISHU_APP_ID`, `FEISHU_APP_SECRET`, and `FEISHU_REDIRECT_URI`; it posts the callback code to Feishu and validates the normalized identity before returning it.

- [ ] **Step 4: Verify green**

Run: `npm exec vitest -- run tests/unit/server/auth-cookies.test.ts tests/unit/infrastructure/feishu-oauth.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/auth-cookies.ts src/infrastructure/auth/feishu-oauth.ts src/server/config.ts .env.example tests/unit
git commit -m "feat: add feishu oauth provider boundary"
```

### Task 2: Add Employee Identity Mapping and OAuth Routes

**Files:**
- Create: `src/application/authenticate-feishu-user.ts`
- Create: `app/api/auth/feishu/login/route.ts`
- Create: `app/api/auth/feishu/callback/route.ts`
- Modify: `src/infrastructure/prisma/claim-repository.ts`
- Test: `tests/integration/api/feishu-login.test.ts`

**Interfaces:**
- Consumes: `FeishuOAuthClient`, OAuth cookie helpers, `Employee.feishuUserId`.
- Produces: `authenticateFeishuUser(identity): Promise<{ employeeId: string }>`.

- [ ] **Step 1: Write failing tests**

```ts
it("rejects a callback when state differs from the HttpOnly cookie", async () => {
  const response = await GET(callbackRequest({ state: "wrong" }));
  expect(response.status).toBe(400);
});

it("maps a repeated openId to one employee", async () => {
  expect(await authenticate(identity)).toEqual(await authenticate(identity));
});
```

- [ ] **Step 2: Run tests**

Run: `npm exec vitest -- run tests/integration/api/feishu-login.test.ts`

Expected: FAIL because routes do not exist.

- [ ] **Step 3: Implement routes**

Login writes a short-lived state cookie and redirects to Feishu authorization. Callback uses `timingSafeEqual` for state comparison, clears the state cookie on every result, maps `openId` to `Employee.feishuUserId`, writes the signed session cookie, and redirects to `/claims/new`. Do not include OAuth token data in the redirect.

- [ ] **Step 4: Verify green**

Run: `npm exec vitest -- run tests/integration/api/feishu-login.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/application/authenticate-feishu-user.ts app/api/auth/feishu src/infrastructure/prisma tests/integration/api/feishu-login.test.ts
git commit -m "feat: add feishu oauth session login"
```

### Task 3: Add Development Demo Login and Auth Documentation

**Files:**
- Create: `app/api/auth/dev-login/route.ts`
- Create: `app/api/auth/logout/route.ts`
- Modify: `README.md`
- Test: `tests/integration/api/dev-login.test.ts`

**Interfaces:**
- Consumes: session-cookie issuer and `DEV_DEMO_EMPLOYEE_ID` configuration.
- Produces: development-only demo login and logout endpoints.

- [ ] **Step 1: Write failing tests**

```ts
it("returns 404 for demo login in production", async () => {
  process.env.NODE_ENV = "production";
  expect((await POST(request)).status).toBe(404);
});
```

- [ ] **Step 2: Run tests**

Run: `npm exec vitest -- run tests/integration/api/dev-login.test.ts`

Expected: FAIL because the route does not exist.

- [ ] **Step 3: Implement routes and docs**

Demo login reads only server environment configuration, creates the configured employee if needed, writes the normal session cookie, and returns JSON. Logout clears session and state cookies. Document Feishu app setup, required redirect URL, and that demo login is forbidden in production.

- [ ] **Step 4: Verify full authentication suite**

Run: `npm exec vitest -- run tests/unit/server/auth-cookies.test.ts tests/unit/infrastructure/feishu-oauth.test.ts tests/integration/api/feishu-login.test.ts tests/integration/api/dev-login.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/api/auth README.md tests/integration/api/dev-login.test.ts
git commit -m "feat: add development demo login"
```
