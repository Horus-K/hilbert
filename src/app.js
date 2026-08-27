const express = require('express');
const { registerMiddleware } = require('./middleware');
const { registerRoutes } = require('./routes');
const { errorHandler } = require('./utils/errors');
const proxy = require('./proxy');

/**
 * Express 应用工厂：组装中间件 + 路由 + 代理
 */
function createApp() {
  const app = express();

  // 隐藏技术栈信息
  app.disable('x-powered-by');

  // 注册全局中间件（安全头 + JWT 认证）
  registerMiddleware(app);

  // 初始化代理路由状态与自定义页面托管；外部内容由独立 proxy app 提供。
  proxy.init();

  // 注册所有路由
  registerRoutes(app, proxy);

  // 统一错误处理（放在所有路由之后）
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
