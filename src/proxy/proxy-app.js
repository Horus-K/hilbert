const express = require('express');
const auth = require('../middleware/auth');
const proxyAuth = require('../middleware/proxy-auth');
const securityHeaders = require('../middleware/security-headers');
const { errorHandler } = require('../utils/errors');
const { isHostRoutingEnabled, PROXY_SESSION_PATH } = require('../utils/proxy-origin');
const { handleProxySessionExchange } = require('./session-handler');
const proxy = require('./index');

/**
 * 只承载外部页面内容的隔离应用。这里故意不注册 Hilbert UI、静态资源或 API。
 */
function createProxyApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('external-proxy-app', true);
  app.use(securityHeaders);

  if (isHostRoutingEnabled()) {
    // 一次性票据兑换必须先于页面会话认证，且仅存在于严格匹配的页面 Host。
    app.get(PROXY_SESSION_PATH, handleProxySessionExchange);
    app.use(proxyAuth);
  } else {
    // 未配置通配 Host 时保留旧版“同 hostname 不同端口”的主站 Cookie 认证。
    app.use(auth);
  }

  proxy.init();
  app.use(proxy.createProxyDispatcher());
  app.use((req, res) => res.status(404).send('代理页面不存在'));
  app.use(errorHandler);
  return app;
}

module.exports = { createProxyApp };
