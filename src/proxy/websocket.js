const http = require('http');
const https = require('https');
const jwt = require('jsonwebtoken');
const { getPageRequestAgent, applyDnsOverride } = require('./agents');
const { applyAuthHeaders, clearSession } = require('./auth-injector');
const { storeResponseCookies } = require('./cookie-jar');
const { buildUpstreamHeaders } = require('./header-utils');
const { resolveProxyTarget } = require('./proxy-handler');
const { resolveProxyRequest } = require('./route-manager');
const { GOOGLE_CONFIG } = require('../services/auth.service');
const { hasPermission } = require('../services/rbac.service');

function rejectUpgrade(socket, statusCode, statusText) {
  socket.write(`HTTP/1.1 ${statusCode} ${statusText}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

/**
 * upgrade 事件不经过 Express 中间件，从 Cookie 解析当前登录用户（失败视为匿名）
 */
function extractUser(req) {
  const tokenMatch = (req.headers.cookie || '').match(/(?:^|;\s*)hilbert_token=([^;]+)/);
  if (!tokenMatch) return null;
  try {
    return jwt.verify(decodeURIComponent(tokenMatch[1]), GOOGLE_CONFIG.jwt_secret);
  } catch {
    return null;
  }
}

/**
 * 设置 WebSocket upgrade 转发
 */
function setupWebSocket(server) {
  server.on('upgrade', async (req, socket, head) => {
    const user = extractUser(req);
    if (!user) return rejectUpgrade(socket, 401, 'Unauthorized');
    const found = resolveProxyRequest(req, user);
    if (!found || found.page.type !== 'link') return rejectUpgrade(socket, 404, 'Not Found');
    const { page, mountPrefix } = found;
    if (!hasPermission(user.email, page.id, 'read')) {
      return rejectUpgrade(socket, 403, 'Forbidden');
    }

    try {
      const { base, targetUrl } = resolveProxyTarget(page, req.url, mountPrefix);
      const headers = buildUpstreamHeaders(req, base, mountPrefix, true);
      await applyAuthHeaders(page, headers, user, targetUrl);

      const lib = targetUrl.protocol === 'https:' ? https : http;
      const wsUrl = new URL(targetUrl.href);
      const wsDnsOpts = applyDnsOverride(page, wsUrl, base, headers);
      const wsOpts = {
        method: 'GET',
        headers,
        agent: getPageRequestAgent(wsUrl, page),
        ...wsDnsOpts
      };
      const proxyReq = lib.request(wsUrl, wsOpts);
      proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
        storeResponseCookies(page, user, targetUrl, proxyRes.headers['set-cookie']);
        let raw = `HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage}\r\n`;
        for (let i = 0; i < proxyRes.rawHeaders.length; i += 2) {
          if (proxyRes.rawHeaders[i].toLowerCase() === 'set-cookie') continue;
          raw += `${proxyRes.rawHeaders[i]}: ${proxyRes.rawHeaders[i + 1]}\r\n`;
        }
        raw += '\r\n';
        socket.write(raw);
        if (proxyHead.length) socket.write(proxyHead);
        if (head.length) proxySocket.write(head);
        proxySocket.pipe(socket);
        socket.pipe(proxySocket);
      });
      proxyReq.on('response', proxyRes => {
        if (proxyRes.statusCode === 401) clearSession(page.id, user);
        proxyRes.resume();
        rejectUpgrade(socket, proxyRes.statusCode || 502, proxyRes.statusMessage || 'Bad Gateway');
      });
      proxyReq.on('error', () => socket.destroy());
      proxyReq.end();
    } catch {
      socket.destroy();
    }
  });
}

module.exports = { setupWebSocket };
