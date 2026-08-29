# Hilbert Identity Header Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent an authenticated Hilbert user from supplying identity headers that survive into an `identity`-mode upstream request.

**Architecture:** Keep the existing signed Hilbert session and per-page identity mapping. In the shared `applyAuthHeaders` path used by HTTP and WebSocket proxying, delete every configured identity header before injecting claims derived from `req.user`; missing claims therefore remove the header instead of preserving client input.

**Tech Stack:** Node.js 24, Express, `node:test`, existing `jsonwebtoken` dependency

**Spec:** `README.md` sections “逐页面通配子域名路由” and “页面接入模式”; downstream identity must come only from the verified Hilbert page session.

## Global Constraints

- Add no dependency, middleware, policy engine, or new configuration option.
- Change only the shared identity-injection path so HTTP and WebSocket receive the same protection.
- Preserve all five existing authentication modes and their current behavior outside `identity` mode.
- Treat only headers listed in `page.auth.claims` as the identity contract; downstream applications must not trust undeclared identity headers.

---

### Task 1: Strip Client Identity Headers Before Injection

**Files:**
- Modify: `src/proxy/auth-injector.js:187`
- Test: `test/proxy-core.test.js`

**Interfaces:**
- Consumes: `applyAuthHeaders(page, headers, user, targetUrl)` and normalized `page.auth.claims` entries shaped as `{ claim, header, format, fallbackClaim? }`.
- Produces: The same `Promise<void>` interface, with every configured identity header either set from `user` or absent.

- [ ] **Step 1: Write the failing regression test**

Add this test beside the existing identity-injection tests in `test/proxy-core.test.js`:

```js
test('identity 模式不保留客户端伪造的身份头', async () => {
  const page = {
    id: 'identity-page',
    url: 'https://example.test/',
    auth: {
      mode: 'identity',
      claims: [
        { claim: 'email', header: 'X-Forwarded-User', format: 'text' },
        { claim: 'missingClaim', header: 'X-Forwarded-Groups', format: 'csv' }
      ]
    }
  };
  const headers = {
    'x-forwarded-user': 'mallory@example.com',
    'x-forwarded-groups': 'jenkins-admins'
  };

  await applyAuthHeaders(page, headers, { email: 'alice@example.com' }, new URL(page.url));

  assert.equal(headers['x-forwarded-user'], 'alice@example.com');
  assert.equal(headers['x-forwarded-groups'], undefined);
});
```

- [ ] **Step 2: Run the focused test and verify the vulnerability is reproduced**

Run:

```powershell
node --test --test-name-pattern="identity 模式不保留客户端伪造的身份头" test/proxy-core.test.js
```

Expected: FAIL because `x-forwarded-groups` remains `jenkins-admins` when the mapped claim is absent.

- [ ] **Step 3: Implement the minimum shared fix**

In the `auth.mode === 'identity'` branch of `src/proxy/auth-injector.js`, clear all configured header names before the existing claim loop:

```js
if (auth.mode === 'identity') {
  for (const mapping of auth.claims || []) delete headers[mapping.header.toLowerCase()];
  for (const mapping of auth.claims || []) {
    let value = getClaim(user, mapping.claim);
```

Do not add a second sanitizer in `proxy-handler.js` or `websocket.js`; both already call `applyAuthHeaders`.

- [ ] **Step 4: Run the focused test**

Run:

```powershell
node --test --test-name-pattern="identity 模式不保留客户端伪造的身份头" test/proxy-core.test.js
```

Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run:

```powershell
npm test
```

Expected: all tests pass.

- [ ] **Step 6: Commit the security fix**

```powershell
git add src/proxy/auth-injector.js test/proxy-core.test.js
git commit -m "fix: strip client identity headers before proxying"
```

---

### Task 2: Document the Trust Boundary

**Files:**
- Modify: `README.md` under “页面接入模式”

**Interfaces:**
- Consumes: The `identity` mode contract enforced by Task 1.
- Produces: Deployment requirements for upstream reachability and trusted header names.

- [ ] **Step 1: Add the deployment warning**

Add the following paragraph after the page access-mode list:

```markdown
> `identity` 模式只保证配置在 `claims` 中的身份 Header 由 Hilbert 生成。下游只能信任这些 Header，并应通过网络策略或 mTLS 仅接受来自 Hilbert 的请求；不要同时信任其他客户端可提交的身份 Header。`basic`、`login`、`header` 和客户端凭证 `oauth` 模式代表共享服务身份，不应用于模拟当前 Hilbert 用户。
```

- [ ] **Step 2: Verify the documented mode names against validation**

Run:

```powershell
rg -n "basic|login|oauth|header|identity" README.md src/utils/validators.js
```

Expected: the warning uses only the five modes accepted by `normalizeAuth`.

- [ ] **Step 3: Run the full suite**

Run:

```powershell
npm test
```

Expected: all tests pass.

- [ ] **Step 4: Commit the trust-boundary documentation**

```powershell
git add README.md
git commit -m "docs: define identity proxy trust boundary"
```

---

## Deployment Order After This Code Change

1. Inventory every Hilbert link page and classify its mode as per-user (`identity` or `browser`) or shared identity (`basic`, `login`, `header`, or client-credentials `oauth`). Remove shared administrator credentials first.
2. Deploy Task 1 and Task 2 before onboarding another privileged application.
3. Block direct access to Jenkins and other header-auth upstreams; allow only Hilbert or the trusted ingress, and have the ingress overwrite forwarding headers.
4. Pilot Jenkins against the organization's existing OIDC provider. Keep Hilbert as a link/portal and use Jenkins Role Strategy for group-to-permission mapping.
5. After the Jenkins pilot proves login, logout, group mapping, API-token access, and emergency admin recovery, connect GitLab directly to the same OIDC provider.
6. Keep Hilbert `identity` forwarding only for legacy applications without native OIDC. Do not make Jenkins or GitLab trust the Hilbert browser JWT.
7. Add a general Hilbert OIDC client only if the organization replaces Google as its identity provider; do not build a provider abstraction speculatively.

## Self-Review

- Spec coverage: configured identity headers are server-controlled; shared-identity modes and deployment trust are documented; Jenkins/GitLab rollout order is explicit.
- Placeholder scan: no deferred implementation steps or unspecified tests.
- Type consistency: the plan keeps the existing `applyAuthHeaders(page, headers, user, targetUrl)` signature and `auth.claims` shape.
