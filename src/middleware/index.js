const securityHeaders = require('./security-headers');
const auth = require('./auth');

/**
 * 注册全局中间件
 */
function registerMiddleware(app) {
  // 安全响应头
  app.use(securityHeaders);

  // 全局认证（JWT 校验）
  app.use(auth);
}

module.exports = { registerMiddleware, auth };
