const http = require('http');
const https = require('https');
const { HttpProxyAgent } = require('http-proxy-agent');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { page_proxy: pageProxy } = require('../config');

// 出方向代理连接池：复用与目标站的 TCP/TLS 连接，避免每个请求重新三次握手
const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true });

let pageProxyUrl = null;
let pageHttpProxyAgent = null;
let pageHttpsProxyAgent = null;

if (pageProxy) {
  try {
    pageProxyUrl = new URL(pageProxy);
    if (!['http:', 'https:'].includes(pageProxyUrl.protocol)) {
      throw new Error('仅支持 http:// 或 https:// 代理');
    }
    pageHttpProxyAgent = new HttpProxyAgent(pageProxyUrl, { keepAlive: true });
    pageHttpsProxyAgent = new HttpsProxyAgent(pageProxyUrl, { keepAlive: true });
  } catch (err) {
    throw new Error(`PAGE_PROXY 配置无效: ${err.message}`);
  }
}

/**
 * 为页面相关的 HTTP/HTTPS 请求选择连接池。配置 PAGE_PROXY 后，页面内容、
 * 自动认证请求和 WebSocket 握手都会通过该代理建立连接。
 */
function getPageRequestAgent(targetUrl, page) {
  const protocol = targetUrl instanceof URL ? targetUrl.protocol : new URL(targetUrl).protocol;
  if (pageProxyUrl) {
    return protocol === 'https:' ? pageHttpsProxyAgent : pageHttpProxyAgent;
  }
  if (protocol === 'https:') return httpsAgent;
  return httpAgent;
}

/**
 * DNS 覆盖：当页面配置了 resolveIp 时，将代理请求的 TCP 连接目标改为指定 IP，
 * 同时保持 Host 头和 TLS SNI 为原始域名
 */
function applyDnsOverride(page, targetUrl, base, headers, validatedAddress) {
  const configuredAddress = page && page.resolveIp && page.url && base.origin === new URL(page.url).origin
    ? page.resolveIp
    : '';
  const ip = configuredAddress || validatedAddress;
  if (!ip) return {};
  targetUrl.hostname = ip;
  headers.host = base.host;
  if (base.protocol === 'https:') {
    return { servername: base.hostname };
  }
  return {};
}

module.exports = {
  httpAgent,
  httpsAgent,
  getPageRequestAgent,
  applyDnsOverride
};
