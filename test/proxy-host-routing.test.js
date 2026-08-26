process.env.PORT = '3000';
process.env.EXTERNAL_PROXY_PORT = '30001';
process.env.EXTERNAL_PROXY_PUBLIC_PORT = '';
process.env.EXTERNAL_PROXY_PUBLIC_ORIGIN = '';
process.env.EXTERNAL_PROXY_PUBLIC_HOST_TEMPLATE = '{pageId}.proxy.local.horus-k.com';
process.env.EXTERNAL_PROXY_PUBLIC_PROTOCOL = 'https';
process.env.EXTERNAL_PROXY_TICKET_TTL_SECONDS = '60';
process.env.EXTERNAL_PROXY_SESSION_TTL_MINUTES = '30';
process.env.JWT_SECRET = 'host-routing-test-secret-at-least-32-bytes';
process.env.ADMIN_EMAIL = 'host-admin@example.test';
process.env.DEBUG_MODE = 'false';
process.env.PAGE_PROXY = '';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');

const { createApp } = require('../src/app');
const { createProxyApp } = require('../src/proxy/proxy-app');
const { signJwt } = require('../src/services/auth.service');
const {
  clearProxyTickets,
  consumeProxyTicket,
  issueProxyTicket,
  normalizeNextPath,
  signProxySession,
  verifyProxySession
} = require('../src/services/proxy-session.service');
const pagesRepo = require('../src/repositories/pages.repository');
const {
  findRouteByHost,
  refreshProxyRoutes
} = require('../src/proxy/route-manager');
const {
  buildPageProxyHost,
  extractPageIdFromHost,
  getExternalProxyOrigin
} = require('../src/utils/proxy-origin');
const { resolveUpgradeContext, setupWebSocket } = require('../src/proxy/websocket');

function listen(app) {
  return new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function close(server) {
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  return new Promise(resolve => server.close(resolve));
}

function upgradeRequest(server, { path, host, cookie }) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: server.address().port });
    const chunks = [];
    socket.setTimeout(3000);
    socket.on('connect', () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\n` +
        `Host: ${host}\r\n` +
        `Cookie: ${cookie}\r\n` +
        'Connection: Upgrade\r\n' +
        'Upgrade: websocket\r\n' +
        'Sec-WebSocket-Version: 13\r\n' +
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n'
      );
    });
    socket.on('data', chunk => chunks.push(chunk));
    socket.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    socket.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
    socket.on('timeout', () => { socket.destroy(); reject(new Error('WebSocket upgrade timeout')); });
    socket.on('error', reject);
  });
}

function request(server, { path = '/', host, cookie, forwardedProto = 'https' }) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: server.address().port,
      path,
      method: 'GET',
      headers: {
        Host: host,
        'X-Forwarded-Proto': forwardedProto,
        ...(cookie ? { Cookie: cookie } : {})
      }
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8')
      }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

test('通配 Host 模板严格生成并提取页面 ID', () => {
  assert.equal(buildPageProxyHost('page-a'), 'page-a.proxy.local.horus-k.com');
  assert.equal(extractPageIdFromHost('page-a.proxy.local.horus-k.com:443'), 'page-a');
  assert.equal(extractPageIdFromHost('page-a.proxy.local.horus-k.com.evil.test'), null);
  assert.equal(extractPageIdFromHost('user@page-a.proxy.local.horus-k.com'), null);
  assert.equal(extractPageIdFromHost('page-a.proxy.local.horus-k.com,evil.test'), null);
  assert.equal(extractPageIdFromHost('proxy.local.horus-k.com'), null);
  assert.equal(
    getExternalProxyOrigin({ headers: { 'x-forwarded-proto': 'http' }, protocol: 'http' }, { id: 'page-a' }),
    'https://page-a.proxy.local.horus-k.com'
  );
});

test('一次性票据只能兑换一次，页面会话绑定单个页面 Host', () => {
  clearProxyTickets();
  const page = { id: 'page-a' };
  const user = { sub: 'user-a', email: 'host-admin@example.test', groups: ['ops'] };
  const ticket = issueProxyTicket(page, user, '/base/page?x=1');
  const payload = consumeProxyTicket(ticket, page.id);
  assert.equal(payload.pageId, page.id);
  assert.equal(payload.nextPath, '/base/page?x=1');
  assert.equal(consumeProxyTicket(ticket, page.id), null);
  assert.throws(() => normalizeNextPath('//evil.test/path'));
  assert.throws(() => normalizeNextPath('/\\evil.test/path'));

  const token = signProxySession(page.id, user);
  assert.equal(verifyProxySession(token, page.id).email, user.email);
  assert.equal(verifyProxySession(token, 'page-b'), null);
});

test('完整流程：主站票据跳转、Host-only 会话、根路径 HTTP 与 WebSocket 路由', async () => {
  const upstreamRequests = [];
  const upstreamUpgrades = [];
  const upstream = http.createServer((req, res) => {
    upstreamRequests.push({ url: req.url, cookie: req.headers.cookie });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ url: req.url }));
  });
  upstream.on('upgrade', (req, socket) => {
    upstreamUpgrades.push({ url: req.url, cookie: req.headers.cookie });
    socket.end(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Connection: Upgrade\r\n' +
      'Upgrade: websocket\r\n\r\n'
    );
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));

  const pageA = {
    id: 'host-page-a',
    type: 'link',
    name: 'Host page A',
    url: `http://127.0.0.1:${upstream.address().port}/base/page?initial=1`,
    proxyMode: 'mount',
    auth: { mode: 'header', headerName: 'Authorization', headerValue: 'Bearer must-not-leak' }
  };
  const pageB = {
    id: 'host-page-b',
    type: 'link',
    name: 'Host page B',
    url: `http://127.0.0.1:${upstream.address().port}/other`,
    proxyMode: 'mount'
  };

  const pages = pagesRepo.read();
  const snapshot = pages.slice();
  pages.splice(0, pages.length, pageA, pageB);
  refreshProxyRoutes();
  clearProxyTickets();

  const mainServer = await listen(createApp());
  const proxyServer = await listen(createProxyApp());
  setupWebSocket(proxyServer);
  const user = { id: 'host-admin', email: 'host-admin@example.test', name: 'Host Admin' };
  const mainCookie = 'hilbert_token=' + encodeURIComponent(signJwt(user));

  try {
    assert.equal(findRouteByHost('host-page-a.proxy.local.horus-k.com').page.id, pageA.id);

    const listResponse = await request(mainServer, {
      path: '/hilbert-api/pages',
      host: 'hilbert.local.horus-k.com',
      cookie: mainCookie
    });
    assert.equal(listResponse.status, 200);
    const publicPage = JSON.parse(listResponse.body).find(page => page.id === pageA.id);
    assert.equal(publicPage.auth.mode, 'header');
    assert.equal(publicPage.auth.hasHeaderValue, true);
    assert.equal(publicPage.auth.headerValue, undefined);
    assert.doesNotMatch(listResponse.body, /must-not-leak/);

    const openResponse = await request(mainServer, {
      path: '/hilbert-api/pages/host-page-a/open',
      host: 'hilbert.local.horus-k.com',
      cookie: mainCookie
    });
    assert.equal(openResponse.status, 302);
    const exchangeUrl = new URL(openResponse.headers.location);
    assert.equal(exchangeUrl.hostname, 'host-page-a.proxy.local.horus-k.com');
    assert.equal(exchangeUrl.pathname, '/.hilbert/session');

    const exchangeResponse = await request(proxyServer, {
      path: exchangeUrl.pathname + exchangeUrl.search,
      host: exchangeUrl.host
    });
    assert.equal(exchangeResponse.status, 302);
    assert.equal(exchangeResponse.headers.location, '/base/page?initial=1');
    assert.equal(exchangeResponse.headers['referrer-policy'], 'no-referrer');
    const setCookie = exchangeResponse.headers['set-cookie'][0];
    assert.match(setCookie, /^hilbert_proxy_session=/);
    assert.match(setCookie, /; Path=\//);
    assert.match(setCookie, /; HttpOnly/);
    assert.match(setCookie, /; Secure/);
    assert.match(setCookie, /; SameSite=Lax/);
    assert.doesNotMatch(setCookie, /; Domain=/i);
    const proxyCookie = setCookie.split(';', 1)[0];

    const replayResponse = await request(proxyServer, {
      path: exchangeUrl.pathname + exchangeUrl.search,
      host: exchangeUrl.host
    });
    assert.equal(replayResponse.status, 401);

    const pageResponse = await request(proxyServer, {
      path: '/base/page?initial=1',
      host: exchangeUrl.host,
      cookie: proxyCookie
    });
    assert.equal(pageResponse.status, 200);
    assert.equal(JSON.parse(pageResponse.body).url, '/base/page?initial=1');

    const rootApiResponse = await request(proxyServer, {
      path: '/api/items',
      host: exchangeUrl.host,
      cookie: proxyCookie
    });
    assert.equal(rootApiResponse.status, 200);
    assert.equal(JSON.parse(rootApiResponse.body).url, '/api/items');
    assert.equal(upstreamRequests.at(-1).cookie, undefined);

    const wrongPageResponse = await request(proxyServer, {
      path: '/other',
      host: 'host-page-b.proxy.local.horus-k.com',
      cookie: proxyCookie
    });
    assert.equal(wrongPageResponse.status, 401);

    const mainCookieOnlyResponse = await request(proxyServer, {
      path: '/base/page',
      host: exchangeUrl.host,
      cookie: mainCookie
    });
    assert.equal(mainCookieOnlyResponse.status, 401);

    const upgradeResponse = await upgradeRequest(proxyServer, {
      path: '/ws?channel=ops',
      host: exchangeUrl.host,
      cookie: proxyCookie
    });
    assert.match(upgradeResponse, /^HTTP\/1\.1 101 /);
    assert.equal(upstreamUpgrades[0].url, '/ws?channel=ops');
    assert.equal(upstreamUpgrades[0].cookie, undefined);

    const wsContext = resolveUpgradeContext({
      url: '/ws',
      headers: { host: exchangeUrl.host, cookie: proxyCookie }
    });
    assert.equal(wsContext.found.page.id, pageA.id);
    assert.equal(wsContext.user.email, user.email);
  } finally {
    await close(mainServer);
    await close(proxyServer);
    await close(upstream);
    pages.splice(0, pages.length, ...snapshot);
    refreshProxyRoutes();
    clearProxyTickets();
  }
});
