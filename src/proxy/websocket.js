const http = require('http');
const https = require('https');
const jwt = require('jsonwebtoken');
const { external_proxy: proxyConfig } = require('../../config');
const { getPageRequestAgent, applyDnsOverride } = require('./agents');
const { applyAuthHeaders, clearSession } = require('./auth-injector');
const { browserCookieHeader, rewriteBrowserSetCookies, storeResponseCookies } = require('./cookie-jar');
const { buildUpstreamHeaders } = require('./header-utils');
const { resolveProxyTarget } = require('./proxy-handler');
const { resolveProxyRequest } = require('./route-manager');
const { GOOGLE_CONFIG } = require('../services/auth.service');
const { extractProxySession } = require('../services/proxy-session.service');
const { hasPermission } = require('../services/rbac.service');
const { extractPageIdFromHost, isHostRoutingEnabled } = require('../utils/proxy-origin');
const sessionRegistry = require('../services/session-registry.service');
const { assertTargetAllowed } = require('./target-policy');

const activeSockets = new Map();
sessionRegistry.events.on('sessions:revoked', ids => {
  for (const id of ids) {
    const sockets = activeSockets.get(id);
    if (!sockets) continue;
    for (const socket of sockets) socket.destroy();
    activeSockets.delete(id);
  }
});

function trackSessionSocket(sessionId, socket) {
  if (!sessionId) return;
  if (!activeSockets.has(sessionId)) activeSockets.set(sessionId, new Set());
  const sockets = activeSockets.get(sessionId);
  sockets.add(socket);
  socket.once('close', () => {
    sockets.delete(socket);
    if (!sockets.size) activeSockets.delete(sessionId);
  });
}

function rejectUpgrade(socket, statusCode, statusText) {
  socket.write(`HTTP/1.1 ${statusCode} ${statusText}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

function extractMainUser(req) {
  const tokenMatch = (req.headers.cookie || '').match(/(?:^|;\s*)hilbert_token=([^;]+)/);
  if (!tokenMatch) return null;
  try {
    const user = jwt.verify(decodeURIComponent(tokenMatch[1]), GOOGLE_CONFIG.jwt_secret);
    if (user.sid && !sessionRegistry.isActive(user.sid)) return null;
    if (user.sid) sessionRegistry.touch(user.sid);
    return user;
  } catch {
    return null;
  }
}

function resolveUpgradeContext(req) {
  if (isHostRoutingEnabled()) {
    const pageId = extractPageIdFromHost(req.headers.host);
    if (!pageId) return { statusCode: 404, statusText: 'Not Found' };
    const user = extractProxySession(req, pageId);
    if (!user) return { statusCode: 401, statusText: 'Unauthorized' };
    const found = resolveProxyRequest(req);
    if (!found || found.page.id !== pageId) return { statusCode: 404, statusText: 'Not Found' };
    return { found, user };
  }

  const user = extractMainUser(req);
  if (!user) return { statusCode: 401, statusText: 'Unauthorized' };
  const found = resolveProxyRequest(req, user);
  if (!found) return { statusCode: 404, statusText: 'Not Found' };
  return { found, user };
}

/**
 * 设置 WebSocket upgrade 转发。Host 路由与 HTTP 使用同一页面识别和页面会话。
 */
function setupWebSocket(server) {
  server.on('upgrade', async (req, socket, head) => {
    const context = resolveUpgradeContext(req);
    if (!context.found) return rejectUpgrade(socket, context.statusCode, context.statusText);

    const { found, user } = context;
    if (found.page.type !== 'link') return rejectUpgrade(socket, 404, 'Not Found');
    const { page, mountPrefix } = found;
    if (!hasPermission(user.email, page.id, 'read')) {
      return rejectUpgrade(socket, 403, 'Forbidden');
    }

    try {
      const { base, targetUrl } = resolveProxyTarget(page, req.url, mountPrefix);
      const validatedAddresses = await assertTargetAllowed(page, targetUrl);
      const headers = buildUpstreamHeaders(req, base, mountPrefix, true, page);
      if (page.sessionMode === 'browser') headers.cookie = browserCookieHeader(req.headers.cookie);
      await applyAuthHeaders(page, headers, user, targetUrl);

      const lib = targetUrl.protocol === 'https:' ? https : http;
      const wsUrl = new URL(targetUrl.href);
      const wsDnsOpts = applyDnsOverride(page, wsUrl, base, headers, validatedAddresses[0]);
      const wsOpts = {
        method: 'GET',
        headers,
        agent: getPageRequestAgent(wsUrl, page),
        ...wsDnsOpts
      };
      const proxyReq = lib.request(wsUrl, wsOpts);
      proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
        if (page.sessionMode !== 'browser') storeResponseCookies(page, user, targetUrl, proxyRes.headers['set-cookie']);
        const browserSetCookies = page.sessionMode === 'browser'
          ? rewriteBrowserSetCookies(proxyRes.headers['set-cookie'])
          : [];
        let raw = `HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage}\r\n`;
        for (let i = 0; i < proxyRes.rawHeaders.length; i += 2) {
          if (proxyRes.rawHeaders[i].toLowerCase() === 'set-cookie') continue;
          raw += `${proxyRes.rawHeaders[i]}: ${proxyRes.rawHeaders[i + 1]}\r\n`;
        }
        for (const cookie of browserSetCookies) raw += `Set-Cookie: ${cookie}\r\n`;
        raw += '\r\n';
        socket.write(raw);
        if (proxyHead.length) socket.write(proxyHead);
        if (head.length) proxySocket.write(head);
        trackSessionSocket(user.sid, socket);
        trackSessionSocket(user.sid, proxySocket);
        proxySocket.pipe(socket);
        socket.pipe(proxySocket);
      });
      proxyReq.on('response', proxyRes => {
        if (proxyRes.statusCode === 401) clearSession(page.id, user);
        proxyRes.resume();
        rejectUpgrade(socket, proxyRes.statusCode || 502, proxyRes.statusMessage || 'Bad Gateway');
      });
      proxyReq.on('error', () => socket.destroy());
      proxyReq.setTimeout(proxyConfig.timeout_ms, () => proxyReq.destroy());
      proxyReq.end();
    } catch {
      socket.destroy();
    }
  });
}

module.exports = { activeSockets, extractMainUser, resolveUpgradeContext, setupWebSocket };
