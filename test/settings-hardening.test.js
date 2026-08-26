process.env.PORT = '3000';
process.env.EXTERNAL_PROXY_PORT = '3001';
process.env.EXTERNAL_PROXY_PUBLIC_PORT = '3001';
process.env.EXTERNAL_PROXY_PUBLIC_ORIGIN = '';
process.env.EXTERNAL_PROXY_PUBLIC_HOST_TEMPLATE = '';
process.env.PAGE_PROXY = '';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { mergeAuthSecrets } = require('../src/utils/auth-secrets');
const { atomicWriteJson, readJsonFile } = require('../src/utils/json-file');
const { toPublicPage } = require('../src/utils/page-response');
const { validateGroupOrder, normalizeGroupName, groupKey } = require('../src/services/groups.service');
const { removePageFromList } = require('../src/repositories/favorites.repository');
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
