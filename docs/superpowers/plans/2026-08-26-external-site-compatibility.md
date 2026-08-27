# External Site Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the existing external link proxy to support browser-owned sessions, mapped upstream origins, interactive login, bounded network access, and actionable compatibility diagnostics.

**Architecture:** Keep the existing per-page Host dispatcher as the single routing boundary. Add two optional page fields and one native target-policy module; all HTTP, WebSocket, authentication, rewriting, and diagnostics paths consume the same normalized page configuration.

**Tech Stack:** Node.js 24, Express 4, native `http`/`https`/`dns`/`net`, `node:test`.

**Spec:** `docs/superpowers/specs/2026-08-26-external-site-compatibility-design.md`

## Global Constraints

- Node.js `>=24.19.0`; add no npm dependency.
- Preserve `sessionMode: "server"` as the default.
- Never forward or overwrite `hilbert_token` or `hilbert_proxy_session`.
- Never forward primary-origin credentials to a mapped origin unless its alias is explicitly listed in `authOrigins`.
- Browser sessions and origin maps require Host routing.
- Do not rewrite arbitrary JavaScript.
- Preserve pre-existing working-tree changes in `src/proxy/proxy-handler.js` and `test/proxy-core.test.js`.

---

### Task 1: Compatibility baseline

**Files:**
- Create: `test/proxy-compatibility.test.js`
- Modify: `README.md`

**Interfaces:**
- Consumes: existing `createProxyDispatcher()`, `handleProxyRequest()`, `setupWebSocket()`.
- Produces: local integration fixtures for redirects, SSE, cookies, and mapped-origin work in later tasks.

- [ ] Add a local upstream and proxy integration test with literal expectations for relative URL, same-origin absolute URL, redirect, Set-Cookie isolation, and SSE streaming.
- [ ] Run `node --test test/proxy-compatibility.test.js`; expected result is PASS because this task characterizes the supported baseline.
- [ ] Run `npm test`; expected result is all existing and characterization tests PASS.

### Task 2: Browser Cookie session mode

**Files:**
- Modify: `src/utils/validators.js`
- Modify: `src/services/pages.service.js`
- Modify: `src/proxy/cookie-jar.js`
- Modify: `src/proxy/header-utils.js`
- Modify: `src/proxy/proxy-handler.js`
- Modify: `src/proxy/websocket.js`
- Modify: `public/index.html`
- Modify: `public/app.js`
- Test: `test/proxy-core.test.js`

**Interfaces:**
- Produces: `normalizeSessionMode(value)` returning `server`, `browser`, or `undefined`; `browserCookieHeader(value)`; `rewriteBrowserSetCookies(values)`.
- Consumes: normalized `page.sessionMode` in HTTP and WebSocket forwarding.

- [ ] Add failing tests proving invalid modes are rejected, reserved cookies are filtered, Domain is removed, and browser cookies reach an upstream without server-jar substitution.
- [ ] Run `node --test test/proxy-core.test.js`; expected failures name the missing normalization and cookie helpers.
- [ ] Implement the three helpers and the minimum HTTP/WebSocket branches; reject browser mode without Host routing and reject browser mode with automated `login` auth.
- [ ] Add the native select control and serialize/restore `sessionMode` in the page form.
- [ ] Run `node --test test/proxy-core.test.js` and `npm test`; expected result is PASS.

### Task 3: Mapped upstream origins

**Files:**
- Modify: `src/utils/validators.js`
- Modify: `src/services/pages.service.js`
- Modify: `src/proxy/proxy-handler.js`
- Modify: `src/proxy/rewriter.js`
- Modify: `public/index.html`
- Modify: `public/app.js`
- Test: `test/proxy-core.test.js`
- Test: `test/proxy-host-routing.test.js`

**Interfaces:**
- Produces: `normalizeOrigins(value)`, `normalizeAuthOrigins(value, origins)`, and reserved route `/.hilbert/upstream/<alias>/...`.
- Consumes: `page.origins` from HTTP, URL rewriting, redirects, and WebSocket target resolution.

- [ ] Add failing validator and routing tests using `api -> https://api.example.test` and literal proxy paths.
- [ ] Run the focused tests; expected failures show that origins are neither normalized nor routed.
- [ ] Implement alias validation, target resolution, standard URL/Referer rewriting, and explicit `authOrigins` credential forwarding without JavaScript source rewriting.
- [ ] Add a one-entry-per-line `alias=https://origin` textarea and serialize/restore it.
- [ ] Run focused tests and `npm test`; expected result is PASS.

### Task 4: Interactive login entry

**Files:**
- Modify: `public/app.js`
- Test: `test/proxy-host-routing.test.js`

**Interfaces:**
- Consumes: existing `page.proxyUrl` ticket bootstrap.
- Produces: sidebar action opening `page.proxyUrl` in a new tab and iframe sandbox tokens `allow-top-navigation-by-user-activation`, `allow-storage-access-by-user-activation`.

- [ ] Add a failing response-level test proving a bootstrap ticket still enters the same page Host used by browser cookies.
- [ ] Run the focused test and confirm the expected failure if behavior is missing.
- [ ] Add the two sandbox tokens and one “新标签页打开” menu action for link pages.
- [ ] Run focused tests and `npm test`; expected result is PASS.

### Task 5: Target network and resource policy

**Files:**
- Create: `src/proxy/target-policy.js`
- Modify: `config.js`
- Modify: `src/proxy/proxy-handler.js`
- Modify: `src/proxy/websocket.js`
- Modify: `src/proxy/auth-injector.js`
- Modify: `src/services/diagnostics.service.js`
- Modify: `.env.example`
- Test: `test/proxy-policy.test.js`
- Test: `test/proxy-core.test.js`

**Interfaces:**
- Produces: `assertTargetAllowed(page, url)` and config values `target_allow_private_cidrs`, `max_body_bytes`, `max_rewrite_bytes`, `timeout_ms`.
- Consumes: all outbound HTTP/WebSocket/authentication/diagnostic paths.

- [ ] Add failing literal-IP tests for public, private allowed, private denied, loopback, metadata, invalid CIDR, oversized request, oversized rewrite, and timeout behavior.
- [ ] Run focused tests and confirm failures are caused by the absent policy and limits.
- [ ] Implement policy with native `net.BlockList`, `net.isIP`, and `dns.promises.lookup`; hard-deny metadata after allow-list evaluation.
- [ ] Apply the policy before each outbound request and add body/rewrite/timeout limits to the shared proxy handler.
- [ ] Document exact environment variables and defaults.
- [ ] Run focused tests and `npm test`; expected result is PASS.

### Task 6: Compatibility diagnostics

**Files:**
- Modify: `src/services/diagnostics.service.js`
- Modify: `public/app.js`
- Test: `test/settings-hardening.test.js`

**Interfaces:**
- Produces: `redirects`, `unknownOrigins`, `setsCookies`, and `recommendation` in diagnostic responses.
- Consumes: normalized primary and mapped origins plus target policy.

- [ ] Add a failing integration test with a redirect to an unknown origin and HTML containing one mapped and one unknown absolute origin.
- [ ] Run the focused test and confirm missing diagnostic fields cause failure.
- [ ] Follow at most five redirects, inspect at most 256 KiB, redact query strings and Cookie values, and return a deterministic recommendation.
- [ ] Render the new fields in the existing diagnostics result without a new UI subsystem.
- [ ] Run focused tests and `npm test`; expected result is PASS.

### Task 7: Runtime interception decision

**Files:**
- Modify only if a failing compatibility fixture proves dynamic JavaScript URL construction remains a required supported case.

**Interfaces:**
- Produces nothing when no measured failure exists.

- [ ] Review failures from Tasks 1–6 and the accepted compatibility boundary in the spec.
- [ ] If no accepted fixture fails solely because JavaScript dynamically constructs an absolute mapped URL, record “无需运行时注入” in `README.md` and write no production script.
- [ ] If such a fixture exists, first add one failing browser-observable test, then implement only fetch/XHR/WebSocket mapping for configured origins.
- [ ] Run `npm test`; expected result is PASS.

### Task 8: Final verification and documentation

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: all seven completed stage outputs.
- Produces: operator configuration and compatibility boundary documentation.

- [ ] Run `npm test`; expected result is zero failures.
- [ ] Run `git diff --check`; expected result is no whitespace errors.
- [ ] Review `git diff --stat` and preserve the pre-existing 503 behavior change.
- [ ] Update README and CHANGELOG with only shipped behavior and explicit unsupported cases.
