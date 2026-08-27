const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const testDataDir = path.join(os.tmpdir(), 'hilbert-core-' + process.pid);
fs.rmSync(testDataDir, { recursive: true, force: true });
process.env.HILBERT_DATA_DIR = testDataDir;
process.env.DATA_ENCRYPTION_KEY = 'test-data-encryption-key-core';
process.on('exit', () => fs.rmSync(testDataDir, { recursive: true, force: true }));

process.env.PAGE_PROXY = '';
process.env.PAGE_TARGET_ALLOW_PRIVATE_CIDRS = '127.0.0.0/8';
process.env.PORT = '3000';
process.env.EXTERNAL_PROXY_PORT = '3001';
process.env.EXTERNAL_PROXY_PUBLIC_PORT = '3001';
process.env.EXTERNAL_PROXY_PUBLIC_ORIGIN = '';
process.env.EXTERNAL_PROXY_PUBLIC_HOST_TEMPLATE = '';
process.env.EXTERNAL_PROXY_PUBLIC_PROTOCOL = '';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const zlib = require('node:zlib');
const express = require('express');
const sameOrigin = require('../src/middleware/same-origin');

const { applyDnsOverride, getPageRequestAgent } = require('../src/proxy/agents');
const { applyAuthHeaders } = require('../src/proxy/auth-injector');
const {
  browserCookieHeader,
  clearCookieJar,
  rewriteBrowserSetCookies,
  storeResponseCookies
} = require('../src/proxy/cookie-jar');
const {
  buildUpstreamHeaders,
  negotiateAcceptEncoding,
  stripFrameAncestors
} = require('../src/proxy/header-utils');
const { handleProxyRequest, resolveProxyTarget } = require('../src/proxy/proxy-handler');
const pagesRepo = require('../src/repositories/pages.repository');
const { findRouteByPath, pathsOverlap, refreshProxyRoutes } = require('../src/proxy/route-manager');
const { rewriteCss, rewriteHtml } = require('../src/proxy/rewriter');
const { normalizeAuth, normalizeOrigins, normalizeSessionMode } = require('../src/utils/validators');
const { sanitizeGoogleAuth } = require('../src/utils/user-identity');

test('挂载 URL 完整镜像上游 pathname，保留相对路径语义', () => {
  const page = { url: 'https://example.test/base/app/?fixed=1' };
  assert.equal(
    resolveProxyTarget(page, '/mount/base/app/asset.js?v=2', '/mount').target,
    'https://example.test/base/app/asset.js?v=2'
  );
  assert.equal(
    resolveProxyTarget(page, '/mount/', '/mount').target,
    'https://example.test/base/app/?fixed=1'
  );
  assert.equal(
    resolveProxyTarget(page, '/api/items', '/mount').target,
    'https://example.test/api/items'
  );
});

test('关联 origin 使用保留路径路由，并重写标准绝对 URL', () => {
  assert.deepEqual(normalizeOrigins({ api: 'https://api.example.test' }), {
    api: 'https://api.example.test'
  });
  assert.equal(normalizeOrigins({ 'Bad Alias': 'https://api.example.test' }), undefined);
  assert.equal(normalizeOrigins({ api: 'https://api.example.test/path' }), undefined);

  const page = {
    url: 'https://app.example.test/base/',
    origins: { api: 'https://api.example.test' }
  };
  assert.equal(
    resolveProxyTarget(page, '/.hilbert/upstream/api/v1/users?q=1', '').target,
    'https://api.example.test/v1/users?q=1'
  );
  assert.equal(
    rewriteHtml('<a href="https://api.example.test/v1/users">users</a>', {
      mountPrefix: '',
      primaryOrigin: 'https://app.example.test',
      upstreamOrigin: 'https://app.example.test',
      upstreamUrl: 'https://app.example.test/base/',
      upstreamOrigins: page.origins
    }),
    '<a href="/.hilbert/upstream/api/v1/users">users</a>'
  );
});

test('HTML/CSS 只按标准 URL 语义重写，不识别应用私有字段', () => {
  const context = {
    mountPrefix: '/mount',
    upstreamOrigin: 'https://example.test',
    upstreamUrl: 'https://example.test/base/page.html'
  };
  const html = rewriteHtml(
    '<a href="/a">a</a><img srcset="/one 1x, /two 2x">' +
      '<a href="https://other.test/x" data-note=\'href="/attribute-must-stay"\'>external</a>' +
      '<script>const appSubUrl="/unchanged"; const appUrl="/unchanged";' +
      'const href="/script-must-stay";</script>',
    context
  );
  assert.match(html, /href="\/mount\/a"/);
  assert.match(html, /srcset="\/mount\/one 1x, \/mount\/two 2x"/);
  assert.match(html, /href="https:\/\/other\.test\/x"/);
  assert.match(html, /data-note='href="\/attribute-must-stay"'/);
  assert.match(html, /appSubUrl="\/unchanged"/);
  assert.match(html, /appUrl="\/unchanged"/);
  assert.match(html, /href="\/script-must-stay"/);
  assert.equal(rewriteCss('a{background:url(/img/a.png)}', context), 'a{background:url(/mount/img/a.png)}');
});

test('请求头只映射来自代理 origin 的 Origin/Referer', () => {
  const req = {
    headers: {
      host: 'localhost:3001',
      origin: 'http://localhost:3001',
      referer: 'http://localhost:3001/mount/base/form',
      cookie: 'hilbert_token=secret',
      connection: 'keep-alive'
    }
  };
  const headers = buildUpstreamHeaders(req, new URL('https://example.test/base/'), '/mount');
  assert.equal(headers.origin, 'https://example.test');
  assert.equal(headers.referer, 'https://example.test/base/form');
  assert.equal(headers.cookie, undefined);
  assert.equal(headers.connection, undefined);
  assert.equal(stripFrameAncestors("default-src 'self'; frame-ancestors 'none'; img-src *"),
    "default-src 'self'; img-src *");
});

test('映射 origin 的 Referer 去掉保留前缀，并按来源 origin 还原', () => {
  const page = {
    url: 'https://app.example.test/',
    origins: { api: 'https://api.example.test' }
  };
  const mapped = buildUpstreamHeaders({
    headers: {
      host: 'page.proxy.test',
      referer: 'http://page.proxy.test/.hilbert/upstream/api/v1/form'
    }
  }, new URL(page.origins.api + '/'), '', false, page);
  assert.equal(mapped.referer, 'https://api.example.test/v1/form');

  const primary = buildUpstreamHeaders({
    headers: { host: 'page.proxy.test', referer: 'http://page.proxy.test/dashboard' }
  }, new URL(page.origins.api + '/'), '', false, page);
  assert.equal(primary.referer, 'https://app.example.test/dashboard');
});

test('上游压缩协商不声明浏览器未接受或代理无法处理的编码', () => {
  assert.equal(negotiateAcceptEncoding('gzip, deflate'), 'gzip, deflate');
  assert.equal(negotiateAcceptEncoding('gzip, deflate, br, zstd'), 'gzip, deflate, br');
  assert.equal(negotiateAcceptEncoding('br;q=0, gzip;q=0.5'), 'gzip;q=0.5');
  assert.equal(negotiateAcceptEncoding('zstd'), 'identity');
  assert.equal(negotiateAcceptEncoding(undefined), 'identity');

  const headers = buildUpstreamHeaders({
    headers: { host: 'proxy.test', 'accept-encoding': 'gzip, deflate' }
  }, new URL('https://upstream.test/'), '/mount');
  assert.equal(headers['accept-encoding'], 'gzip, deflate');
});

test('主站拒绝隔离代理 origin 发起的状态修改', () => {
  const req = {
    method: 'POST',
    protocol: 'http',
    headers: { host: 'localhost:3000', origin: 'http://localhost:3001' }
  };
  let status;
  const res = {
    status(code) { status = code; return this; },
    json() {}
  };
  let nextCalled = false;
  sameOrigin(req, res, () => { nextCalled = true; });
  assert.equal(status, 403);
  assert.equal(nextCalled, false);
});

test('目标 Cookie 按页面和用户隔离，Hilbert Cookie 不会透传', async () => {
  const target = new URL('https://example.test/base/data');
  const pageA = { id: 'page-a', url: 'https://example.test/base/' };
  const pageB = { id: 'page-b', url: 'https://example.test/base/' };
  const userA = { sub: 'user-a' };
  const userB = { sub: 'user-b' };
  clearCookieJar(pageA.id);
  clearCookieJar(pageB.id);
  storeResponseCookies(pageA, userA, target, 'sid=target-a; Path=/base; Secure');

  const headersA = { cookie: 'hilbert_token=secret' };
  await applyAuthHeaders(pageA, headersA, userA, target);
  assert.equal(headersA.cookie, 'sid=target-a');

  const headersOtherUser = { cookie: 'hilbert_token=secret' };
  await applyAuthHeaders(pageA, headersOtherUser, userB, target);
  assert.equal(headersOtherUser.cookie, undefined);

  const headersOtherPage = { cookie: 'hilbert_token=secret' };
  await applyAuthHeaders(pageB, headersOtherPage, userA, target);
  assert.equal(headersOtherPage.cookie, undefined);
});

test('浏览器会话只转发目标 Cookie，并将目标 Cookie 限定到页面 Host', async () => {
  assert.equal(normalizeSessionMode(undefined), 'server');
  assert.equal(normalizeSessionMode('browser'), 'browser');
  assert.equal(normalizeSessionMode('invalid'), undefined);
  assert.equal(
    browserCookieHeader('hilbert_proxy_session=proxy; target=a; hilbert_token=main; theme=dark'),
    'target=a; theme=dark'
  );
  assert.deepEqual(
    rewriteBrowserSetCookies([
      'target=a; Domain=.example.test; Path=/; HttpOnly; Secure',
      'hilbert_proxy_session=overwrite; Path=/'
    ]),
    ['target=a; Path=/; HttpOnly; Secure']
  );

  const headers = { cookie: 'target=a; theme=dark' };
  await applyAuthHeaders(
    { id: 'browser-page', sessionMode: 'browser' },
    headers,
    { sub: 'user-a' },
    new URL('https://example.test/')
  );
  assert.equal(headers.cookie, 'target=a; theme=dark');
});

test('页面认证默认不发送给映射 origin，只有显式 alias 才转发', async () => {
  const page = {
    id: 'auth-map-page',
    url: 'https://app.example.test/',
    origins: { api: 'https://api.example.test' },
    auth: { mode: 'header', headerName: 'X-App-Token', headerValue: 'secret' }
  };
  const blocked = {};
  await applyAuthHeaders(page, blocked, { sub: 'user' }, new URL(page.origins.api + '/v1'));
  assert.equal(blocked['x-app-token'], undefined);

  const allowed = {};
  await applyAuthHeaders({ ...page, authOrigins: ['api'] }, allowed, { sub: 'user' }, new URL(page.origins.api + '/v1'));
  assert.equal(allowed['x-app-token'], 'secret');
});

test('路由拒绝相同或父子挂载路径', () => {
  assert.equal(pathsOverlap('/tools', '/tools'), true);
  assert.equal(pathsOverlap('/tools', '/tools/admin'), true);
  assert.equal(pathsOverlap('/tools-a', '/tools-b'), false);
});

test('动态刷新替换路由表，不保留旧挂载路径', () => {
  const pages = pagesRepo.read();
  const snapshot = pages.slice();
  try {
    pages.splice(0, pages.length, {
      id: '__route-test__', type: 'link', name: 'test',
      url: 'https://example.test/base/', proxyMode: 'mount', mountPath: '/__old-route__'
    });
    refreshProxyRoutes();
    assert.equal(findRouteByPath('/__old-route__/base/').page.id, '__route-test__');

    pages[0].mountPath = '/__new-route__';
    refreshProxyRoutes();
    assert.equal(findRouteByPath('/__old-route__/base/'), null);
    assert.equal(findRouteByPath('/__new-route__/base/').page.id, '__route-test__');
  } finally {
    pages.splice(0, pages.length, ...snapshot);
    refreshProxyRoutes();
  }
});

test('DNS 覆盖仍使用证书校验正常开启的 HTTPS agent', () => {
  const agent = getPageRequestAgent(new URL('https://example.test/'), { resolveIp: '127.0.0.1' });
  assert.notEqual(agent.options.rejectUnauthorized, false);
});

test('目标请求固定使用已经过策略检查的地址，同时保留 Host 和 TLS SNI', () => {
  const logical = new URL('https://example.test/app');
  const network = new URL(logical.href);
  const headers = {};
  const options = applyDnsOverride({}, network, logical, headers, '203.0.113.7');
  assert.equal(network.hostname, '203.0.113.7');
  assert.equal(headers.host, 'example.test');
  assert.equal(options.servername, 'example.test');
});

test('认证配置支持通用 claim 映射和状态码策略', () => {
  const identity = normalizeAuth({
    mode: 'identity',
    claims: [{ claim: 'profile.department', header: 'X-Department', format: 'text' }]
  });
  assert.deepEqual(identity.claims, [
    { claim: 'profile.department', header: 'X-Department', format: 'text' }
  ]);
  const login = normalizeAuth({
    mode: 'login', username: 'u', password: 'p', loginPath: 'session',
    loginSuccessStatuses: [200, 302], expiredStatuses: [401, 419]
  });
  assert.equal(login.loginPath, 'session');
  assert.deepEqual(login.loginSuccessStatuses, [200, 302]);
  assert.deepEqual(login.expiredStatuses, [401, 419]);
});

test('认证配置保留登录和 OAuth 附加参数，并校验多请求头', () => {
  const login = normalizeAuth({
    mode: 'login', username: 'u', password: 'p',
    extraParams: { tenant: 'acme', user: 'override' }
  });
  assert.deepEqual(login.extraParams, { tenant: 'acme', user: 'override' });

  const oauth = normalizeAuth({
    mode: 'oauth', tokenUrl: 'https://id.test/token', clientId: 'client', clientSecret: 'secret',
    extraParams: { audience: 'api', grant_type: 'password' }
  });
  assert.deepEqual(oauth.extraParams, { audience: 'api', grant_type: 'password' });

  assert.deepEqual(normalizeAuth({
    mode: 'header', headers: { Authorization: 'Bearer token', 'X-Tenant': 'acme' }
  }), {
    mode: 'header', headers: { Authorization: 'Bearer token', 'X-Tenant': 'acme' }
  });
  assert.equal(normalizeAuth({ mode: 'header', headers: { 'Bad Header': 'value' } }), undefined);
  assert.equal(normalizeAuth({ mode: 'header', headers: { Good: 'line\nbreak' } }), undefined);
  assert.equal(normalizeAuth({
    mode: 'header', headers: { Authorization: 'first', authorization: 'second' }
  }), undefined);

  const kvLogin = normalizeAuth({
    mode: 'login', loginPath: '/session', loginFormat: 'json',
    params: { account: 'alice', secret: 'password' }
  });
  assert.deepEqual(kvLogin, {
    mode: 'login', loginPath: '/session', loginFormat: 'json',
    params: { account: 'alice', secret: 'password' }
  });
  assert.deepEqual(normalizeAuth({ mode: 'login', params: {} }), {
    mode: 'login', loginPath: '/login', loginFormat: 'json', params: {}
  });
});

test('自定义请求头模式注入所有 KV', async () => {
  const headers = {};
  await applyAuthHeaders({
    id: 'multi-header-page',
    url: 'https://example.test/',
    auth: { mode: 'header', headers: { Authorization: 'Bearer token', 'X-Tenant': 'acme' } }
  }, headers, { sub: 'user' }, new URL('https://example.test/'));
  assert.equal(headers.authorization, 'Bearer token');
  assert.equal(headers['x-tenant'], 'acme');
});

test('表单登录附加参数覆盖内置字段', async () => {
  let receivedBody;
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      receivedBody = Buffer.concat(chunks).toString();
      res.writeHead(200, { 'set-cookie': 'sid=login; Path=/' });
      res.end('{}');
    });
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${upstream.address().port}`;
  const page = {
    id: 'login-kv-page', url: origin + '/',
    auth: {
      mode: 'login', username: 'original', password: 'password',
      userField: 'user', passwordField: 'password', loginPath: '/login', loginFormat: 'json',
      extraParams: { user: 'override', tenant: 'acme' }
    }
  };
  try {
    await applyAuthHeaders(page, {}, { sub: 'login-kv-user' }, new URL(origin + '/'));
    assert.deepEqual(JSON.parse(receivedBody), {
      user: 'override', password: 'password', tenant: 'acme'
    });
  } finally {
    await new Promise(resolve => upstream.close(resolve));
    clearCookieJar(page.id);
  }
});

test('表单登录请求体完全由可编辑 KV 决定', async () => {
  let receivedBody;
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      receivedBody = Buffer.concat(chunks).toString();
      res.writeHead(200, { 'set-cookie': 'sid=kv-login; Path=/' });
      res.end('{}');
    });
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${upstream.address().port}`;
  const page = {
    id: 'freeform-login-page', url: origin + '/',
    auth: {
      mode: 'login', loginPath: '/login', loginFormat: 'json',
      params: { account: 'alice', secret: 'password', tenant: 'acme' }
    }
  };
  try {
    await applyAuthHeaders(page, {}, { sub: 'freeform-login-user' }, new URL(origin + '/'));
    assert.deepEqual(JSON.parse(receivedBody), {
      account: 'alice', secret: 'password', tenant: 'acme'
    });
  } finally {
    await new Promise(resolve => upstream.close(resolve));
    clearCookieJar(page.id);
  }
});

test('OAuth 附加参数覆盖内置字段', async () => {
  let receivedBody;
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      receivedBody = Buffer.concat(chunks).toString();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ access_token: 'issued-token', expires_in: 3600 }));
    });
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const tokenUrl = `http://127.0.0.1:${upstream.address().port}/token`;
  const page = {
    id: 'oauth-kv-page', url: 'https://example.test/',
    auth: {
      mode: 'oauth', tokenUrl, clientId: 'client', clientSecret: 'secret', scope: 'default-scope',
      extraParams: { audience: 'api', grant_type: 'password', scope: 'override-scope' }
    }
  };
  const headers = {};
  try {
    await applyAuthHeaders(page, headers, { sub: 'oauth-kv-user' }, new URL(page.url));
    assert.deepEqual(Object.fromEntries(new URLSearchParams(receivedBody)), {
      grant_type: 'password', client_id: 'client', client_secret: 'secret',
      scope: 'override-scope', audience: 'api'
    });
    assert.equal(headers.authorization, 'Bearer issued-token');
  } finally {
    await new Promise(resolve => upstream.close(resolve));
  }
});

test('身份透传开关映射 Google 资料并拒绝过期 access_token', async () => {
  const identity = normalizeAuth({
    mode: 'identity',
    forwardGoogleAuth: true,
    forwardGoogleAccessToken: true
  });
  assert.equal(identity.forwardGoogleAuth, true);
  assert.equal(identity.forwardGoogleAccessToken, true);
  assert.ok(identity.claims.some(mapping =>
    mapping.claim === 'googleAuth' && mapping.header === 'X-Forwarded-Google-Auth'));
  assert.ok(identity.claims.some(mapping =>
    mapping.claim === 'googleAccessToken' && mapping.header === 'X-Forwarded-Google-Access-Token'));

  const profile = sanitizeGoogleAuth({
    id: 'google-user',
    email: 'user@example.test',
    googleAccessToken: 'must-not-leak',
    nested: { refresh_token: 'must-not-leak', locale: 'zh-CN' }
  });
  assert.equal(profile.googleAccessToken, undefined);
  assert.equal(profile.nested.refresh_token, undefined);
  assert.equal(profile.nested.locale, 'zh-CN');

  const page = { id: 'identity-page', auth: identity };
  const validHeaders = {};
  await applyAuthHeaders(page, validHeaders, {
    sub: 'user-id',
    email: 'user@example.test',
    displayName: 'Test User',
    groups: ['ops'],
    googleAuth: {
      id: 'google-user',
      email: 'user@example.test',
      googleAccessToken: 'must-not-leak'
    },
    googleAccessToken: 'valid-access-token',
    googleAccessTokenExpiresAt: Date.now() + 60_000
  }, new URL('https://example.test/'));
  const forwardedProfile = JSON.parse(Buffer.from(
    validHeaders['x-forwarded-google-auth'], 'base64url'
  ).toString('utf8'));
  assert.equal(forwardedProfile.email, 'user@example.test');
  assert.equal(forwardedProfile.googleAccessToken, undefined);
  assert.equal(validHeaders['x-forwarded-google-access-token'], 'valid-access-token');

  const expiredHeaders = {};
  await applyAuthHeaders(page, expiredHeaders, {
    sub: 'user-id',
    email: 'user@example.test',
    googleAuth: { id: 'google-user' },
    googleAccessToken: 'expired-access-token',
    googleAccessTokenExpiresAt: Date.now() - 1
  }, new URL('https://example.test/'));
  assert.equal(expiredHeaders['x-forwarded-google-access-token'], undefined);
});

test('HTTP 集成：主站 Cookie 不出站，目标 Cookie 留在服务端且内容按标准 URL 重写', async () => {
  const upstreamRequests = [];
  const upstream = http.createServer((req, res) => {
    upstreamRequests.push({
      url: req.url,
      cookie: req.headers.cookie,
      acceptEncoding: req.headers['accept-encoding']
    });
    if (req.url === '/base/page') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'set-cookie': 'sid=upstream-session; Path=/base; HttpOnly'
      });
      res.end('<a href="/root">root</a><script src="asset.js"></script>');
      return;
    }
    if (req.url === '/base/unavailable') {
      res.writeHead(503, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<main>upstream unavailable <a href="/status">status</a></main>');
      return;
    }
    if (req.url === '/base/asset.js') {
      const source = Buffer.from('window.proxyCompressionTest = true;');
      const accepts = String(req.headers['accept-encoding'] || '');
      if (/\bbr\b/.test(accepts)) {
        res.writeHead(200, {
          'content-type': 'application/javascript',
          'content-encoding': 'br'
        });
        res.end(zlib.brotliCompressSync(source));
      } else if (/\bgzip\b/.test(accepts)) {
        res.writeHead(200, {
          'content-type': 'application/javascript',
          'content-encoding': 'gzip'
        });
        res.end(zlib.gzipSync(source));
      } else {
        res.writeHead(200, { 'content-type': 'application/javascript' });
        res.end(source);
      }
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ cookie: req.headers.cookie || '' }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));

  const upstreamPort = upstream.address().port;
  const page = { id: '__integration__', url: `http://127.0.0.1:${upstreamPort}/base/page` };
  clearCookieJar(page.id);
  const app = express();
  app.use((req, res) => {
    req.user = { sub: 'integration-user', email: 'integration@example.test' };
    handleProxyRequest(page, req, res, null, '/mount');
  });
  const proxyServer = app.listen(0, '127.0.0.1');
  await new Promise(resolve => proxyServer.once('listening', resolve));
  const proxyOrigin = `http://127.0.0.1:${proxyServer.address().port}`;

  try {
    const pageResponse = await fetch(proxyOrigin + '/mount/base/page', {
      headers: { cookie: 'hilbert_token=must-not-leak', origin: proxyOrigin }
    });
    assert.equal(pageResponse.status, 200);
    assert.equal(pageResponse.headers.get('set-cookie'), null);
    const html = await pageResponse.text();
    assert.match(html, /href="\/mount\/root"/);
    assert.match(html, /src="asset\.js"/);
    assert.equal(upstreamRequests[0].cookie, undefined);

    const unavailableResponse = await fetch(proxyOrigin + '/mount/base/unavailable');
    assert.equal(unavailableResponse.status, 503);
    assert.equal(
      await unavailableResponse.text(),
      '<main>upstream unavailable <a href="/status">status</a></main>'
    );

    const apiResponse = await fetch(proxyOrigin + '/mount/base/api', {
      headers: { cookie: 'hilbert_token=must-not-leak', origin: proxyOrigin }
    });
    assert.equal(apiResponse.status, 200);
    assert.equal((await apiResponse.json()).cookie, 'sid=upstream-session');

    const compressedAsset = await new Promise((resolve, reject) => {
      const request = http.get(proxyOrigin + '/mount/base/asset.js', {
        headers: { 'accept-encoding': 'gzip' }
      }, response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => resolve({ response, body: Buffer.concat(chunks) }));
        response.on('error', reject);
      });
      request.on('error', reject);
    });
    assert.equal(compressedAsset.response.headers['content-encoding'], 'gzip');
    assert.equal(
      zlib.gunzipSync(compressedAsset.body).toString(),
      'window.proxyCompressionTest = true;'
    );
    const assetRequest = upstreamRequests.find(request => request.url === '/base/asset.js');
    assert.equal(assetRequest.acceptEncoding, 'gzip');
  } finally {
    await new Promise(resolve => proxyServer.close(resolve));
    await new Promise(resolve => upstream.close(resolve));
    clearCookieJar(page.id);
  }
});
