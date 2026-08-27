const { extractPageIdFromHost } = require('../utils/proxy-origin');
const { extractProxySession } = require('../services/proxy-session.service');

/**
 * 通配子域名代理认证：只接受绑定到当前页面 Host 的独立会话，
 * 不读取主站 hilbert_token，避免把主站会话共享给全部代理子域名。
 */
function proxyAuth(req, res, next) {
  const pageId = extractPageIdFromHost(req.headers.host);
  if (!pageId) return res.status(404).send('代理页面 Host 不合法');

  const user = extractProxySession(req, pageId);
  if (!user) return res.status(401).send('代理页面会话无效或已过期');

  req.proxyPageId = pageId;
  req.user = user;
  next();
}

module.exports = proxyAuth;
