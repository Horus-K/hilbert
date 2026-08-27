const assert = require('node:assert/strict');
const test = require('node:test');

process.env.DEBUG_MODE = 'true';
process.env.PAGE_TARGET_ALLOW_PRIVATE_CIDRS = '';

const { assertTargetAllowed, createTargetPolicy } = require('../src/proxy/target-policy');
const { normalizeResolveIp } = require('../src/utils/validators');

test('debug 模式只默认允许 127.0.0.1', async () => {
  await assert.doesNotReject(() => assertTargetAllowed(null, 'http://127.0.0.1'));
  await assert.rejects(
    () => assertTargetAllowed(null, 'http://127.0.0.2'),
    /目标地址不在允许的私网范围/
  );
});

test('目标网络策略默认拒绝私网，显式放行 CIDR，但始终拒绝云元数据', () => {
  const defaultPolicy = createTargetPolicy('');
  assert.doesNotThrow(() => defaultPolicy.assertAddressAllowed('8.8.8.8'));
  assert.throws(() => defaultPolicy.assertAddressAllowed('10.20.1.2'), /目标地址不在允许的私网范围/);
  assert.throws(() => defaultPolicy.assertAddressAllowed('127.0.0.1'), /目标地址不在允许的私网范围/);

  const internalPolicy = createTargetPolicy('10.20.0.0/16,127.0.0.0/8,169.254.0.0/16');
  assert.doesNotThrow(() => internalPolicy.assertAddressAllowed('10.20.1.2'));
  assert.doesNotThrow(() => internalPolicy.assertAddressAllowed('127.0.0.1'));
  assert.throws(() => internalPolicy.assertAddressAllowed('169.254.169.254'), /云元数据/);
  const ipv6InternalPolicy = createTargetPolicy('fc00::/7');
  assert.throws(() => ipv6InternalPolicy.assertAddressAllowed('fd00:ec2::254'), /云元数据/);
  assert.throws(() => createTargetPolicy('10.0.0.0/99'), /CIDR/);
});

test('DNS 覆盖只接受完整 IP 地址', () => {
  assert.equal(normalizeResolveIp('10.20.1.2'), '10.20.1.2');
  assert.equal(normalizeResolveIp('2001:db8::1'), '2001:db8::1');
  assert.equal(normalizeResolveIp('127.1'), undefined);
  assert.equal(normalizeResolveIp('internal.example.test'), undefined);
  assert.equal(normalizeResolveIp(''), '');
});
