const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hilbert-logo-'));
process.env.HILBERT_DATA_DIR = testDataDir;
process.env.PAGE_TARGET_ALLOW_PRIVATE_CIDRS = '127.0.0.1/32';
process.env.PAGE_PROXY_TIMEOUT_MS = '1000';
process.env.DEBUG_MODE = 'true';
process.env.DEBUG_USER_EMAIL = 'logo-admin@example.test';
process.env.ADMIN_EMAIL = 'logo-admin@example.test';
process.env.JWT_SECRET = 'page-logo-test-secret-at-least-32-bytes';

const { cachePageLogo, deletePageLogo, logoFile } = require('../src/services/page-logo.service');
const pagesService = require('../src/services/pages.service');
const { createApp } = require('../src/app');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

function listen(handler) {
  const server = http.createServer(handler);
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

test.after(() => fs.rmSync(testDataDir, { recursive: true, force: true }));

test('缓存用户填写的页面 Logo 图片', async () => {
  const server = await listen((req, res) => {
    res.setHeader('Content-Type', 'image/png');
    res.end(PNG);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;

  try {
    const result = await cachePageLogo({ id: 'page-1', type: 'link', url: origin + '/app' }, origin + '/logo.png');

    assert.deepEqual(result, { cached: true, mimeType: 'image/png', source: origin + '/logo.png' });
    assert.deepEqual(fs.readFileSync(logoFile('page-1')), PNG);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('Logo 网址留空时自动请求页面 origin 的 favicon.ico', async () => {
  let requestedPath = '';
  const server = await listen((req, res) => {
    requestedPath = req.url;
    res.setHeader('Content-Type', 'image/x-icon');
    res.end(PNG);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;

  try {
    const result = await cachePageLogo({ id: 'page-auto', type: 'iframe', url: origin + '/nested/app?x=1' }, '');

    assert.equal(requestedPath, '/favicon.ico');
    assert.equal(result.source, origin + '/favicon.ico');
    assert.equal(result.cached, true);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('无网址页面留空时直接使用默认图标', async () => {
  const result = await cachePageLogo({ id: 'page-markdown', type: 'markdown' }, '');
  assert.deepEqual(result, { cached: false, source: '' });
});

test('Logo 获取失败时返回默认状态并移除旧缓存', async () => {
  const server = await listen((req, res) => {
    res.statusCode = 404;
    res.end('missing');
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  fs.mkdirSync(path.dirname(logoFile('page-fallback')), { recursive: true });
  fs.writeFileSync(logoFile('page-fallback'), PNG);

  try {
    const result = await cachePageLogo({ id: 'page-fallback', type: 'direct', url: origin }, '');

    assert.equal(result.cached, false);
    assert.match(result.warning, /404/);
    assert.equal(fs.existsSync(logoFile('page-fallback')), false);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('Logo 下载跟随站内重定向', async () => {
  const server = await listen((req, res) => {
    if (req.url === '/logo') {
      res.setHeader('Content-Type', 'image/png');
      return res.end(PNG);
    }
    res.writeHead(302, { Location: '/logo' });
    res.end();
  });
  const origin = `http://127.0.0.1:${server.address().port}`;

  try {
    const result = await cachePageLogo({ id: 'page-redirect', type: 'link', url: origin }, origin + '/start');
    assert.equal(result.cached, true);
    assert.deepEqual(fs.readFileSync(logoFile('page-redirect')), PNG);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('拒绝把非图片响应缓存为 Logo', async () => {
  const server = await listen((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end('<script>alert(1)</script>');
  });
  const origin = `http://127.0.0.1:${server.address().port}`;

  try {
    const result = await cachePageLogo({ id: 'page-html', type: 'link', url: origin }, origin + '/logo');
    assert.equal(result.cached, false);
    assert.match(result.warning, /图片格式/);
    assert.equal(fs.existsSync(logoFile('page-html')), false);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('Logo 网址只接受 http 和 https', async () => {
  const result = await cachePageLogo({ id: 'page-protocol', type: 'markdown' }, 'ftp://example.test/logo.png');
  assert.equal(result.cached, false);
  assert.match(result.warning, /仅支持 http\/https/);
});

test('拒绝超过 1 MB 的 Logo', async () => {
  const server = await listen((req, res) => {
    res.setHeader('Content-Type', 'image/png');
    res.end(Buffer.alloc(1024 * 1024 + 1));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;

  try {
    const result = await cachePageLogo({ id: 'page-large', type: 'link', url: origin }, origin + '/large.png');
    assert.equal(result.cached, false);
    assert.match(result.warning, /1 MB/);
    assert.equal(fs.existsSync(logoFile('page-large')), false);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('删除页面 Logo 时清理缓存文件', () => {
  fs.mkdirSync(path.dirname(logoFile('page-delete')), { recursive: true });
  fs.writeFileSync(logoFile('page-delete'), PNG);

  deletePageLogo('page-delete');

  assert.equal(fs.existsSync(logoFile('page-delete')), false);
});

test('Logo 下载使用页面代理超时限制', async () => {
  const server = await listen((req, res) => {
    setTimeout(() => {
      res.setHeader('Content-Type', 'image/png');
      res.end(PNG);
    }, 1100);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;

  try {
    const result = await cachePageLogo({ id: 'page-timeout', type: 'link', url: origin }, origin + '/slow.png');
    assert.equal(result.cached, false);
    assert.match(result.warning, /超时/);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('页面服务保存 Logo 来源和缓存类型', async () => {
  const server = await listen((req, res) => {
    res.setHeader('Content-Type', 'image/png');
    res.end(PNG);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const page = pagesService.createPage({ type: 'direct', name: 'Logo page', url: origin + '/app' });

  try {
    const result = await pagesService.updatePageLogo(page.id, origin + '/logo.png');
    assert.equal(result.page.logoUrl, origin + '/logo.png');
    assert.equal(result.page.logoType, 'image/png');
    assert.equal(result.warning, undefined);
    pagesService.deletePage(page.id);
    assert.equal(fs.existsSync(logoFile(page.id)), false);
  } finally {
    try { pagesService.deletePage(page.id); } catch { /* 已删除 */ }
    await new Promise(resolve => server.close(resolve));
  }
});

test('页面 Logo 接口缓存并返回受保护的本地图片', async () => {
  const logoServer = await listen((req, res) => {
    res.setHeader('Content-Type', 'image/png');
    res.end(PNG);
  });
  const appServer = await listen(createApp());
  const logoOrigin = `http://127.0.0.1:${logoServer.address().port}`;
  const appOrigin = `http://127.0.0.1:${appServer.address().port}`;
  const page = pagesService.createPage({ type: 'direct', name: 'API logo', url: logoOrigin + '/app' });

  try {
    const update = await fetch(`${appOrigin}/hilbert-api/pages/${page.id}/logo`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ logoUrl: logoOrigin + '/logo.png' })
    });
    assert.equal(update.status, 200);
    const updatedPage = await update.json();
    assert.equal(updatedPage.logo, `/hilbert-api/pages/${page.id}/logo`);

    const image = await fetch(appOrigin + updatedPage.logo);
    assert.equal(image.status, 200);
    assert.equal(image.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), PNG);
  } finally {
    pagesService.deletePage(page.id);
    await new Promise(resolve => appServer.close(resolve));
    await new Promise(resolve => logoServer.close(resolve));
  }
});
