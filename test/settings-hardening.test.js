const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const AdmZip = require('adm-zip');
const testDataDir = path.join(os.tmpdir(), 'hilbert-settings-' + process.pid);
fs.rmSync(testDataDir, { recursive: true, force: true });
process.env.HILBERT_DATA_DIR = testDataDir;
process.env.DATA_ENCRYPTION_KEY = 'test-data-encryption-key-settings';
process.on('exit', () => fs.rmSync(testDataDir, { recursive: true, force: true }));

process.env.PORT = '3000';
process.env.EXTERNAL_PROXY_PORT = '3001';
process.env.EXTERNAL_PROXY_PUBLIC_PORT = '3001';
process.env.EXTERNAL_PROXY_PUBLIC_ORIGIN = '';
process.env.EXTERNAL_PROXY_PUBLIC_HOST_TEMPLATE = '';
process.env.PAGE_PROXY = '';
process.env.JWT_SECRET = 'settings-test-jwt-secret';
process.env.ADMIN_EMAIL = 'admin@example.test';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeAuthSecrets } = require('../src/utils/auth-secrets');
const { atomicWriteJson, readJsonFile } = require('../src/utils/json-file');
const { toPublicPage } = require('../src/utils/page-response');
const { validateGroupOrder, normalizeGroupName, groupKey } = require('../src/services/groups.service');
const { removePageFromList } = require('../src/repositories/favorites.repository');
const pagesRepo = require('../src/repositories/pages.repository');
const groupsRepo = require('../src/repositories/groups.repository');
const rolesRepo = require('../src/repositories/roles.repository');
const backupService = require('../src/services/backup.service');
const auditService = require('../src/services/audit.service');
const sessionRegistry = require('../src/services/session-registry.service');
const statusService = require('../src/services/system-status.service');
const diagnosticsService = require('../src/services/diagnostics.service');
const authService = require('../src/services/auth.service');
const jwt = require('jsonwebtoken');
const { decryptSecret, encryptSecret, getEncryptionStatus } = require('../src/utils/secret-crypto');
const {
  normalizeAssignmentEmail,
  normalizePermissions,
  removePagePermissionsFromData
} = require('../src/services/rbac.service');

test('页面公开响应不包含认证 Secret', () => {
  const source = {
    id: 'page-a',
    type: 'link',
    auth: {
      mode: 'login',
      username: 'service-user',
      password: 'top-secret',
      loginPath: '/login'
    }
  };
  const page = toPublicPage(source);
  assert.equal(page.auth.username, 'service-user');
  assert.equal(page.auth.loginPath, '/login');
  assert.equal(page.auth.hasPassword, true);
  assert.equal(page.auth.password, undefined);
  assert.equal(source.auth.password, 'top-secret');

  const headerPage = toPublicPage({
    auth: { mode: 'header', headerName: 'Authorization', headerValue: 'Bearer secret' }
  });
  assert.equal(headerPage.auth.hasHeaderValue, true);
  assert.equal(headerPage.auth.headerValue, undefined);

  const oauthPage = toPublicPage({
    auth: { mode: 'oauth', tokenUrl: 'https://id.test/token', clientId: 'client', clientSecret: 'secret' }
  });
  assert.equal(oauthPage.auth.hasClientSecret, true);
  assert.equal(oauthPage.auth.clientSecret, undefined);
});

test('编辑认证配置时空 Secret 保留旧值，切换模式不错误复用', () => {
  assert.equal(mergeAuthSecrets(
    { mode: 'login', password: 'old-password' },
    { mode: 'login', username: 'user', password: '' }
  ).password, 'old-password');

  assert.equal(mergeAuthSecrets(
    { mode: 'header', headerValue: 'old-token' },
    { mode: 'header', headerName: 'Authorization' }
  ).headerValue, 'old-token');

  assert.equal(mergeAuthSecrets(
    { mode: 'oauth', clientSecret: 'old-secret' },
    { mode: 'oauth', clientId: 'client', clientSecret: '' }
  ).clientSecret, 'old-secret');

  assert.equal(mergeAuthSecrets(
    { mode: 'header', headerValue: 'must-not-reuse' },
    { mode: 'oauth', clientId: 'client' }
  ).clientSecret, undefined);
});

test('JSON 原子写入保留上一版本，并可从备份恢复损坏主文件', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hilbert-json-'));
  const file = path.join(dir, 'settings.json');
  try {
    atomicWriteJson(file, { revision: 1 }, { backup: false });
    atomicWriteJson(file, { revision: 2 });
    atomicWriteJson(file, { revision: 3 });
    assert.deepEqual(JSON.parse(fs.readFileSync(file + '.bak', 'utf8')), { revision: 2 });

    fs.writeFileSync(file, '{broken', 'utf8');
    const recovered = readJsonFile(file, { validate: value => Number.isInteger(value.revision) });
    assert.deepEqual(recovered, { revision: 2 });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { revision: 2 });

    fs.unlinkSync(file);
    assert.deepEqual(readJsonFile(file, { validate: value => Number.isInteger(value.revision) }), { revision: 2 });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { revision: 2 });
    assert.equal(fs.readdirSync(dir).some(name => name.endsWith('.tmp')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('分组排序拒绝重复、缺失和额外分组', () => {
  assert.deepEqual(validateGroupOrder(['B', 'A'], ['A', 'B']), ['B', 'A']);
  assert.throws(() => validateGroupOrder(['A', 'A'], ['A', 'B']), /重复项/);
  assert.throws(() => validateGroupOrder(['A'], ['A', 'B']), /不匹配/);
  assert.throws(() => validateGroupOrder(['A', 'C'], ['A', 'B']), /不匹配/);
  assert.throws(() => normalizeGroupName('a/b'), /非法字符/);
  assert.throws(() => normalizeGroupName('x'.repeat(21)), /不能超过/);
  assert.equal(groupKey('ＯＰＳ'), groupKey('ops'));
});

test('RBAC 权限严格校验并合并相同 pageId', () => {
  const normalized = normalizePermissions([
    { pageId: '*', actions: ['read', 'update'] },
    { pageId: '*', actions: ['create', 'read'] }
  ]);
  assert.deepEqual(normalized, [{ pageId: '*', actions: ['read', 'create', 'update'] }]);
  assert.throws(() => normalizePermissions([{ pageId: '*', actions: ['unknown'] }]), /不支持/);
  assert.throws(() => normalizePermissions([{ pageId: 'missing-page', actions: ['read'] }]), /不存在/);
  assert.throws(() => normalizePermissions([{ pageId: 'missing-page', actions: ['create'] }]), /不存在|只能配置/);
});

test('RBAC 邮箱仅接受合法邮箱或整域通配', () => {
  assert.equal(normalizeAssignmentEmail('User@Example.COM'), 'user@example.com');
  assert.equal(normalizeAssignmentEmail('*@Example.COM'), '*@example.com');
  assert.throws(() => normalizeAssignmentEmail('not-an-email'), /格式不正确/);
  assert.throws(() => normalizeAssignmentEmail('user@example..com'), /格式不正确/);
  assert.throws(() => normalizeAssignmentEmail('user*@example.com'), /仅支持/);
});

test('删除页面权限只移除目标页面，保留通配和其他页面权限', () => {
  const source = {
    roles: [{
      id: 'role-a',
      permissions: [
        { pageId: '*', actions: ['read'] },
        { pageId: 'page-a', actions: ['update'] },
        { pageId: 'page-b', actions: ['delete'] }
      ]
    }],
    assignments: []
  };
  const result = removePagePermissionsFromData(source, 'page-a');
  assert.equal(result.changed, true);
  assert.deepEqual(result.data.roles[0].permissions, [
    { pageId: '*', actions: ['read'] },
    { pageId: 'page-b', actions: ['delete'] }
  ]);
  assert.equal(source.roles[0].permissions.length, 3);
});


test('删除页面时从收藏列表移除全部重复引用', () => {
  assert.deepEqual(removePageFromList(['page-a', 'page-b', 'page-a'], 'page-a'), ['page-b']);
});


test('页面认证 Secret 使用 AES-GCM 加密落盘并透明解密', () => {
  const cipher = encryptSecret('super-secret');
  assert.match(cipher, /^enc:v1:/);
  assert.doesNotMatch(cipher, /super-secret/);
  assert.equal(decryptSecret(cipher), 'super-secret');
  assert.equal(getEncryptionStatus().source, 'explicit');

  pagesRepo.write([{
    id: 'encrypted-page',
    type: 'link',
    name: 'Encrypted',
    url: 'https://example.test/',
    group: '未分组',
    auth: { mode: 'header', headerName: 'Authorization', headerValue: 'Bearer disk-secret' }
  }]);
  const disk = fs.readFileSync(path.join(testDataDir, 'pages.json'), 'utf8');
  assert.doesNotMatch(disk, /disk-secret/);
  assert.match(disk, /enc:v1:/);
  pagesRepo.invalidate();
  assert.equal(pagesRepo.read()[0].auth.headerValue, 'Bearer disk-secret');
});

test('审计日志脱敏记录并支持过滤查询', () => {
  auditService.record({
    actor: 'admin@example.test',
    action: 'page.update',
    resourceType: 'page',
    resourceId: 'page-a',
    details: { password: 'must-not-leak', nested: { clientSecret: 'hidden', name: 'safe' } }
  });
  const entries = auditService.query({ actor: 'admin@', action: 'page.', limit: 10 });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].details.password, '[REDACTED]');
  assert.equal(entries[0].details.nested.clientSecret, '[REDACTED]');
  assert.equal(entries[0].details.nested.name, 'safe');
});

test('会话注册表支持主会话级联撤销代理会话', () => {
  const main = sessionRegistry.createSession({
    type: 'main', email: 'user@example.test', expiresAt: Date.now() + 60_000
  });
  const proxy = sessionRegistry.createSession({
    type: 'proxy', email: 'user@example.test', pageId: 'page-a',
    parentSessionId: main.id, expiresAt: Date.now() + 60_000
  });
  assert.equal(sessionRegistry.isActive(main.id), true);
  assert.equal(sessionRegistry.isActive(proxy.id), true);
  assert.equal(sessionRegistry.revoke(main.id, 'admin@example.test'), true);
  assert.equal(sessionRegistry.isActive(main.id), false);
  assert.equal(sessionRegistry.isActive(proxy.id), false);
});

test('完整备份可恢复页面、分组和 RBAC，且恢复前创建安全备份', () => {
  pagesRepo.write([{
    id: 'backup-page', type: 'link', name: 'Before', url: 'https://example.test/',
    group: 'Ops', auth: { mode: 'basic', username: 'u', password: 'backup-secret' }
  }]);
  groupsRepo.write(['Ops']);
  rolesRepo.write({
    roles: [{ id: 'role-a', name: 'Reader', description: '', permissions: [{ pageId: 'backup-page', actions: ['read'] }] }],
    assignments: [{ email: 'user@example.test', roleId: 'role-a' }]
  });
  fs.mkdirSync(path.join(testDataDir, 'custom-pages', 'backup-page'), { recursive: true });
  fs.writeFileSync(path.join(testDataDir, 'custom-pages', 'backup-page', 'index.html'), 'original', 'utf8');
  fs.mkdirSync(path.join(testDataDir, 'favorites'), { recursive: true });
  fs.writeFileSync(path.join(testDataDir, 'favorites', 'user@example.test.json'), JSON.stringify(['backup-page']), 'utf8');
  const created = backupService.createBackup({ reason: 'test' });
  assert.match(created.name, /^hilbert-\d{8}-\d{6}-[a-f0-9]{8}\.zip$/);
  const zip = new AdmZip(path.join(testDataDir, 'backups', created.name));
  const backedUpPages = zip.readAsText('data/pages.json');
  assert.doesNotMatch(backedUpPages, /backup-secret/);
  assert.match(backedUpPages, /enc:v1:/);
  assert.equal(zip.getEntry('data/sessions.json'), null);

  pagesRepo.write([{ id: 'changed', type: 'markdown', name: 'Changed', group: '未分组', content: 'x' }]);
  groupsRepo.write(['Changed']);
  rolesRepo.write({ roles: [], assignments: [] });
  fs.writeFileSync(path.join(testDataDir, 'custom-pages', 'backup-page', 'index.html'), 'changed', 'utf8');
  fs.writeFileSync(path.join(testDataDir, 'favorites', 'user@example.test.json'), '[]', 'utf8');

  const restored = backupService.restoreBackup(created.name, { confirm: 'RESTORE' });
  assert.equal(restored.restored, created.name);
  assert.match(restored.safetyBackup, /^hilbert-/);
  assert.equal(pagesRepo.read()[0].id, 'backup-page');
  assert.equal(pagesRepo.read()[0].auth.password, 'backup-secret');
  assert.deepEqual(groupsRepo.read(), ['Ops']);
  assert.equal(rolesRepo.read().roles[0].id, 'role-a');
  assert.equal(fs.readFileSync(path.join(testDataDir, 'custom-pages', 'backup-page', 'index.html'), 'utf8'), 'original');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(testDataDir, 'favorites', 'user@example.test.json'), 'utf8')), ['backup-page']);
});

test('系统状态汇总不暴露密钥并包含运维指标', () => {
  const status = statusService.getStatus();
  assert.equal(status.data.writable, true);
  assert.equal(status.encryption.enabled, true);
  assert.equal(typeof status.sessions.active, 'number');
  assert.equal(typeof status.audit.bytes, 'number');
  assert.equal(JSON.stringify(status).includes('test-data-encryption-key'), false);
});


test('代理诊断返回 HTTP 连通性、耗时和解析地址', async () => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(204, { server: 'diagnostic-test' });
    res.end();
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  try {
    const result = await diagnosticsService.diagnosePage({
      id: 'diagnostic-page',
      type: 'link',
      url: 'http://127.0.0.1:' + upstream.address().port + '/health'
    }, { sub: 'user', email: 'user@example.test' });
    assert.equal(result.ok, true);
    assert.equal(result.statusCode, 204);
    assert.equal(result.server, 'diagnostic-test');
    assert.ok(result.durationMs >= 0);
  } finally {
    await new Promise(resolve => upstream.close(resolve));
  }
});


test('主站 JWT 包含可撤销 sid，并与注册表过期时间一致', () => {
  const issued = authService.issueMainSession({
    id: 'user-id', email: 'user@example.test', name: 'User'
  }, { headers: {}, socket: {} });
  const decoded = jwt.verify(issued.token, authService.GOOGLE_CONFIG.jwt_secret);
  assert.equal(decoded.sid, issued.session.id);
  assert.equal(sessionRegistry.isActive(decoded.sid), true);
  assert.ok(Math.abs(decoded.exp * 1000 - issued.session.expiresAt) < 2000);
  sessionRegistry.revoke(decoded.sid, 'admin@example.test');
  assert.equal(sessionRegistry.isActive(decoded.sid), false);
});
