const express = require('express');
const auth = require('../middleware/auth');
const securityHeaders = require('../middleware/security-headers');
const { errorHandler } = require('../utils/errors');
const proxy = require('./index');

/**
 * 只承载外部页面内容的隔离应用。这里故意不注册 Hilbert UI、静态资源或 API。
 */
function createProxyApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('external-proxy-app', true);
  app.use(securityHeaders);
  app.use(auth);
  proxy.init();
  app.use(proxy.createProxyDispatcher());
  app.use((req, res) => res.status(404).send('代理页面不存在'));
  app.use(errorHandler);
  return app;
}

module.exports = { createProxyApp };
