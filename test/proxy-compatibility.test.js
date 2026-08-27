const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

process.env.PAGE_TARGET_ALLOW_PRIVATE_CIDRS = '127.0.0.0/8';
process.env.PAGE_PROXY_MAX_BODY_BYTES = '1024';
process.env.PAGE_PROXY_MAX_REWRITE_BYTES = '1024';
process.env.PAGE_PROXY_TIMEOUT_MS = '1000';

const { handleProxyRequest } = require('../src/proxy/proxy-handler');

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

test('兼容性基线：SSE 原样流式透传，重定向留在页面挂载路径', async () => {
  const upstream = await listen(http.createServer((req, res) => {
    if (req.url === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('event: ready\ndata: {"ok":true}\n\n');
      return;
    }
    if (req.url === '/large-html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<main>' + 'x'.repeat(1100) + '</main>');
      return;
    }
    if (req.method === 'POST') {
      req.resume();
      req.on('end', () => res.end('uploaded'));
      return;
    }
    res.writeHead(302, { location: '/events' });
    res.end();
  }));
  const upstreamOrigin = `http://127.0.0.1:${upstream.address().port}`;
  const page = { id: 'compatibility-page', type: 'link', url: upstreamOrigin + '/' };
  const proxy = await listen(http.createServer((req, res) => {
    req.originalUrl = req.url;
    req.user = { email: 'user@example.test' };
    handleProxyRequest(page, req, res, null, '/mount');
  }));
  const proxyOrigin = `http://127.0.0.1:${proxy.address().port}`;

  try {
    const redirect = await fetch(proxyOrigin + '/mount/start', { redirect: 'manual' });
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.get('location'), '/mount/events');

    const events = await fetch(proxyOrigin + '/mount/events');
    assert.equal(events.headers.get('content-type'), 'text/event-stream');
    assert.equal(await events.text(), 'event: ready\ndata: {"ok":true}\n\n');
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('代理拒绝超限的请求体和可重写响应', async () => {
  const upstream = await listen(http.createServer((req, res) => {
    if (req.url === '/large-html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<main>' + 'x'.repeat(1100) + '</main>');
      return;
    }
    req.resume();
    req.on('end', () => res.end('uploaded'));
  }));
  const page = { id: 'bounded-page', type: 'link', url: `http://127.0.0.1:${upstream.address().port}/` };
  const proxy = await listen(http.createServer((req, res) => {
    req.originalUrl = req.url;
    req.user = { email: 'user@example.test' };
    res.status = code => { res.statusCode = code; return res; };
    res.send = body => res.end(body);
    handleProxyRequest(page, req, res, null, '/mount');
  }));
  const origin = `http://127.0.0.1:${proxy.address().port}`;

  try {
    const upload = await fetch(origin + '/mount/upload', {
      method: 'POST',
      body: 'x'.repeat(1025)
    });
    assert.equal(upload.status, 413);

    const html = await fetch(origin + '/mount/large-html');
    assert.equal(html.status, 502);
    assert.match(await html.text(), /超过重写限制/);
  } finally {
    await close(proxy);
    await close(upstream);
  }
});
