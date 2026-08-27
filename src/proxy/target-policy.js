const dns = require('node:dns').promises;
const net = require('node:net');
const { external_proxy: config } = require('../../config');

const METADATA_HOSTS = new Set(['metadata.google.internal']);
const METADATA_ADDRESSES = new Set([
  '169.254.169.254', '169.254.170.2', '100.100.100.200', 'fd00:ec2::254'
]);

function addCidr(blockList, cidr) {
  const [address, rawPrefix, ...extra] = String(cidr).trim().split('/');
  const type = net.isIP(address);
  const prefix = Number(rawPrefix);
  const max = type === 4 ? 32 : type === 6 ? 128 : 0;
  if (extra.length || !type || !Number.isInteger(prefix) || prefix < 0 || prefix > max) {
    throw new Error('PAGE_TARGET_ALLOW_PRIVATE_CIDRS 包含非法 CIDR: ' + cidr);
  }
  blockList.addSubnet(address, prefix, type === 4 ? 'ipv4' : 'ipv6');
}

function addressType(address) {
  if (/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.test(address)) return { address: RegExp.$1, type: 'ipv4' };
  const version = net.isIP(address);
  if (!version) throw new Error('目标地址不是合法 IP: ' + address);
  return { address, type: version === 4 ? 'ipv4' : 'ipv6' };
}

function createTargetPolicy(allowedCidrs) {
  const allowed = new net.BlockList();
  for (const cidr of String(allowedCidrs || '').split(',').map(value => value.trim()).filter(Boolean)) {
    addCidr(allowed, cidr);
  }

  const privateRanges = new net.BlockList();
  for (const cidr of [
    '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8',
    '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24', '192.168.0.0/16',
    '198.18.0.0/15', '224.0.0.0/4', '240.0.0.0/4',
    '::/128', '::1/128', 'fc00::/7', 'fe80::/10', 'ff00::/8'
  ]) addCidr(privateRanges, cidr);

  return {
    assertAddressAllowed(rawAddress) {
      const normalized = addressType(rawAddress);
      if (METADATA_ADDRESSES.has(normalized.address)) throw new Error('禁止访问云元数据地址');
      if (privateRanges.check(normalized.address, normalized.type) &&
          !allowed.check(normalized.address, normalized.type)) {
        throw new Error('目标地址不在允许的私网范围: ' + normalized.address);
      }
    }
  };
}

const defaultPolicy = createTargetPolicy(config.target_allow_private_cidrs);

async function assertTargetAllowed(page, target) {
  const url = target instanceof URL ? target : new URL(target);
  if (url.username || url.password) throw new Error('目标 URL 不能包含用户名或密码');
  if (METADATA_HOSTS.has(url.hostname.toLowerCase())) throw new Error('禁止访问云元数据地址');

  const primaryOrigin = page && page.url ? new URL(page.url).origin : '';
  const override = page && page.resolveIp && url.origin === primaryOrigin ? page.resolveIp : '';
  const addresses = override
    ? [override]
    : net.isIP(url.hostname)
      ? [url.hostname]
      : (await dns.lookup(url.hostname, { all: true })).map(item => item.address);
  for (const address of addresses) defaultPolicy.assertAddressAllowed(address);
  return addresses;
}

module.exports = { assertTargetAllowed, createTargetPolicy };
