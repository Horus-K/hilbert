const { external_proxy: proxyConfig } = require('../../config');

function firstHeaderValue(value) {
  return String(value || '').split(',')[0].trim();
}

/**
 * 计算浏览器访问外部页面代理所使用的独立 origin。
 * 生产环境推荐显式配置 EXTERNAL_PROXY_PUBLIC_ORIGIN。
 */
function getExternalProxyOrigin(req) {
  if (proxyConfig.public_origin) return proxyConfig.public_origin;

  const protocol = firstHeaderValue(req.headers['x-forwarded-proto']) || req.protocol || 'http';
  const forwardedHost = firstHeaderValue(req.headers['x-forwarded-host']);
  const requestHost = forwardedHost || req.headers.host;
  const origin = new URL(`${protocol}://${requestHost}`);
  origin.port = String(proxyConfig.public_port);
  return origin.origin;
}

function exposeProxyOrigin(page, req) {
  if (!page || page.type !== 'link') return page;
  return { ...page, proxyOrigin: getExternalProxyOrigin(req) };
}

module.exports = { getExternalProxyOrigin, exposeProxyOrigin };
