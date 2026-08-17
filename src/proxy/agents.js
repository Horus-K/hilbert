const http = require('http');
const https = require('https');

// 出方向代理连接池：复用与目标站的 TCP/TLS 连接，避免每个请求重新三次握手
const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true });
// DNS 覆盖专用 agent：连接 IP 时跳过证书校验（证书是原始域名的，与 IP 不匹配）
const httpsAgentNoVerify = new https.Agent({ keepAlive: true, rejectUnauthorized: false });

/**
 * DNS 覆盖：当页面配置了 resolveIp 时，将代理请求的 TCP 连接目标改为指定 IP，
 * 同时保持 Host 头和 TLS SNI 为原始域名
 */
function applyDnsOverride(page, targetUrl, base, headers) {
  if (!page || !page.resolveIp) return {};
  const ip = page.resolveIp;
  targetUrl.hostname = ip;
  headers.host = base.host;
  if (base.protocol === 'https:') {
    return { servername: base.hostname };
  }
  return {};
}

module.exports = { httpAgent, httpsAgent, httpsAgentNoVerify, applyDnsOverride };
