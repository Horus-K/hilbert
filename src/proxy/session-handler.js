const pagesRepo = require('../repositories/pages.repository');
const { hasPermission } = require('../services/rbac.service');
const {
  consumeProxyTicket,
  setProxySessionCookie,
  signProxySession
} = require('../services/proxy-session.service');
const { extractPageIdFromHost } = require('../utils/proxy-origin');
const audit = require('../services/audit.service');

function handleProxySessionExchange(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');

  const pageId = extractPageIdFromHost(req.headers.host);
  if (!pageId) return res.status(404).send('代理页面 Host 不合法');

  const payload = consumeProxyTicket(req.query.ticket, pageId);
  if (!payload) return res.status(401).send('代理访问票据无效、已过期或已使用');

  const page = pagesRepo.read().find(candidate => candidate.id === pageId && candidate.type === 'link');
  if (!page) return res.status(404).send('代理页面不存在');
  if (!hasPermission(payload.user.email, page.id, 'read')) {
    return res.status(403).send('没有查看该页面的权限');
  }

  let issued;
  try {
    issued = signProxySession(page.id, payload.user, {
      ip: String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim() || null,
      userAgent: req.headers['user-agent'] || null
    });

  } catch {
    return res.status(401).send('主站会话已过期，请重新打开页面');
  }
  setProxySessionCookie(req, res, issued.token);
  audit.record({
    req,
    actor: payload.user.email,
    sessionId: issued.session.id,
    action: 'proxy.session.create',
    resourceType: 'page',
    resourceId: page.id
  });
  return res.redirect(302, payload.nextPath);
}

module.exports = { handleProxySessionExchange };
