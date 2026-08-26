const securityHeaders = require('./security-headers');
const auth = require('./auth');
const sameOrigin = require('./same-origin');
const audit = require('./audit');

/**
 * 注册全局中间件
 */
function registerMiddleware(app) {
  // 安全响应头
  app.use(securityHeaders);

  // 全局认证（JWT 校验）
  app.use(auth);

  // 拒绝来自隔离代理 origin 或其他站点的状态修改请求。
  app.use(sameOrigin);

  // 统一记录受保护 API 的状态修改审计日志。
  app.use(audit);
}

module.exports = { registerMiddleware, auth };
