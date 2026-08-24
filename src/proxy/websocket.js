const http = require('http');
const https = require('https');
const jwt = require('jsonwebtoken');
const { httpAgent, httpsAgent, httpsAgentNoVerify, applyDnsOverride } = require('./agents');
const { applyAuthHeaders } = require('./auth-injector');
const { resolveProxyTarget } = require('./proxy-handler');
const { findPageByReferer, getProxyRoutes } = require('./route-manager');
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
    const reqPath = req.url.split('?')[0];
    let page = null;
    let matchedPath = null;

    // 查找匹配的代理路由（最长前缀匹配）
    let mountPrefix;
    const proxyRoutes = getProxyRoutes();
    for (const [pathPrefix, entry] of proxyRoutes) {
      if ((entry.page.proxyMode === 'mount') !== entry.mount) continue;
      if (reqPath === pathPrefix || reqPath.startsWith(pathPrefix + '/')) {
        if (!matchedPath || pathPrefix.length > matchedPath.length) {
          page = entry.page;
          matchedPath = pathPrefix;
          mountPrefix = entry.mount ? pathPrefix : undefined;
        }
      }
    }

    // 未命中时通过 Referer 识别来源页面转发
    if (!page && req.headers.referer) {
      const found = findPageByReferer(req.headers.referer);
      if (found) {
        page = found.page;
        mountPrefix = found.mountPrefix || undefined;
        matchedPath = '';
      }
    }

    if (!page || page.type !== 'link') return rejectUpgrade(socket, 404, 'Not Found');

    const user = extractUser(req);
    if (!user) return rejectUpgrade(socket, 401, 'Unauthorized');
    if (!hasPermission(user.email, page.id, 'read')) {
      return rejectUpgrade(socket, 403, 'Forbidden');
    }

    try {
      const { base, target } = resolveProxyTarget(page, req.url, mountPrefix || '');
      const headers = { ...req.headers };
      delete headers.host;
      headers.origin = base.origin;
      headers.referer = base.origin + '/';
      await applyAuthHeaders(page, headers, user);

      const lib = base.protocol === 'https:' ? https : http;
      const wsUrl = new URL(target);
      const wsDnsOpts = applyDnsOverride(page, wsUrl, base, headers);
      const wsOpts = { method: 'GET', headers, ...wsDnsOpts };
      if (page.resolveIp && base.protocol === 'https:') {
        wsOpts.agent = httpsAgentNoVerify;
      }
      const proxyReq = lib.request(wsUrl, wsOpts);
      proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
        let raw = `HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage}\r\n`;
        for (let i = 0; i < proxyRes.rawHeaders.length; i += 2) {
          raw += `${proxyRes.rawHeaders[i]}: ${proxyRes.rawHeaders[i + 1]}\r\n`;
        }
        raw += '\r\n';
        socket.write(raw);
        if (proxyHead.length) socket.write(proxyHead);
        if (head.length) proxySocket.write(head);
        proxySocket.pipe(socket);
        socket.pipe(proxySocket);
      });
      proxyReq.on('error', () => socket.destroy());
      proxyReq.end();
    } catch {
      socket.destroy();
    }
  });
}

module.exports = { setupWebSocket };
