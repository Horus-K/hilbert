const { external_proxy: proxyConfig } = require('../../config');

const PROXY_SESSION_PATH = '/.hilbert/session';
const DNS_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function firstHeaderValue(value) {
  return String(value || '').split(',')[0].trim();
}

function requestProtocol(req) {
  return (firstHeaderValue(req.headers['x-forwarded-proto']) || req.protocol || 'http')
    .replace(/:$/, '')
    .toLowerCase();
}

function isHostRoutingEnabled() {
  return Boolean(proxyConfig.public_host_template);
}

function getHostTemplateLabels() {
  return String(proxyConfig.public_host_template || '').toLowerCase().split('.');
}

function normalizePageHostLabel(pageId) {
  const label = String(pageId || '').trim().toLowerCase();
  return DNS_LABEL_RE.test(label) ? label : '';
}

function buildPageProxyHost(pageId) {
  if (!isHostRoutingEnabled()) return '';
  const label = normalizePageHostLabel(pageId);
  if (!label) throw new Error(`页面 ID 不能用于代理子域名: ${pageId}`);
  return getHostTemplateLabels().map(part => part === '{pageid}' ? label : part).join('.');
}

function hostnameFromHostHeader(hostHeader) {
  const value = String(hostHeader || '').trim().toLowerCase();
  // Host 只能是 DNS hostname 加可选数字端口；拒绝 userinfo、逗号、路径等宽松 URL 语法。
  const match = value.match(/^([a-z0-9.-]+)(?::([0-9]{1,5}))?$/);
  if (!match || match[1].startsWith('.') || match[1].endsWith('.') || match[1].includes('..')) return '';
  if (match[2]) {
    const port = Number(match[2]);
    if (port < 1 || port > 65535) return '';
  }
  return match[1];
}

/**
 * 严格按公开 Host 模板提取页面 ID。只读取网关保留下来的 Host，
 * 不信任可由客户端伪造的 X-Forwarded-Host 作为页面路由键。
 */
function extractPageIdFromHost(hostHeader) {
  if (!isHostRoutingEnabled()) return null;
  const hostname = hostnameFromHostHeader(hostHeader);
  const templateLabels = getHostTemplateLabels();
  const hostLabels = hostname.split('.');
  if (!hostname || hostLabels.length !== templateLabels.length) return null;

  let pageId = '';
  for (let index = 0; index < templateLabels.length; index += 1) {
    const expected = templateLabels[index];
    const actual = hostLabels[index];
    if (expected === '{pageid}') {
      if (!DNS_LABEL_RE.test(actual)) return null;
      pageId = actual;
    } else if (actual !== expected) {
      return null;
    }
  }
  return pageId || null;
}

/**
 * 计算指定页面的浏览器代理 origin。
 * Host 路由模式下每个页面一个 origin；旧模式下所有页面共享 origin。
 */
function getExternalProxyOrigin(req, page) {
  if (isHostRoutingEnabled()) {
    const protocol = proxyConfig.public_protocol || requestProtocol(req);
    const url = new URL(`${protocol}://${buildPageProxyHost(page && page.id)}`);
    if (proxyConfig.public_port !== null) url.port = String(proxyConfig.public_port);
    return url.origin;
  }

  if (proxyConfig.public_origin) return proxyConfig.public_origin;

  const protocol = requestProtocol(req);
  const forwardedHost = firstHeaderValue(req.headers['x-forwarded-host']);
  const requestHost = forwardedHost || req.headers.host;
  const origin = new URL(`${protocol}://${requestHost}`);
  origin.port = String(proxyConfig.public_port);
  return origin.origin;
}

function getPageEntryPath(page) {
  const pageUrl = new URL(page.url);
  return pageUrl.pathname + pageUrl.search + pageUrl.hash;
}

function getLegacyPageProxyUrl(page, req) {
  const mountPath = page.mountPath || '/hilbert-proxy/' + page.id;
  return getExternalProxyOrigin(req, page) + mountPath + getPageEntryPath(page);
}

function getPageBootstrapUrl(page) {
  return '/hilbert-api/pages/' + encodeURIComponent(page.id) + '/open';
}

function buildProxySessionExchangeUrl(page, req, ticket) {
  const url = new URL(PROXY_SESSION_PATH, getExternalProxyOrigin(req, page));
  url.searchParams.set('ticket', ticket);
  return url.href;
}

function exposeProxyOrigin(page, req) {
  if (!page || page.type !== 'link') return page;
  const hostRouting = isHostRoutingEnabled();
  return {
    ...page,
    proxyOrigin: getExternalProxyOrigin(req, page),
    proxyRoutingMode: hostRouting ? 'host' : 'mount',
    proxyUrl: hostRouting ? getPageBootstrapUrl(page) : getLegacyPageProxyUrl(page, req)
  };
}

module.exports = {
  PROXY_SESSION_PATH,
  buildPageProxyHost,
  buildProxySessionExchangeUrl,
  exposeProxyOrigin,
  extractPageIdFromHost,
  getExternalProxyOrigin,
  getLegacyPageProxyUrl,
  getPageBootstrapUrl,
  getPageEntryPath,
  hostnameFromHostHeader,
  isHostRoutingEnabled,
  normalizePageHostLabel,
  requestProtocol
};
