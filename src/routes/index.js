const express = require('express');
const path = require('path');
const { healthRouter, versionRouter } = require('./health');

/**
 * 统一路由注册
 * 
 * 路由挂载规则（确保最终路径与原始 server.js 一致）：
 *   /auth         → auth.routes    → /auth/google
 *   /             → callback.routes → /callback
 *   /hilbert-api  → user.routes    → /hilbert-api/me, /my-permissions, /logout
 */
function registerRoutes(app, proxy) {
  // 1. 健康检查（无需认证，最先注册）
  app.use('/hilbert-api/health', healthRouter);

  // 2. 认证路由（无需 JWT 中间件）
  //    auth.routes 挂载于 /auth → /auth/google
  app.use('/auth', require('./auth.routes'));
  //    callback.routes 挂载于 / → /callback
  app.use('/', require('./callback.routes'));

  // 3. JSON 解析（仅 /hilbert-api 路径）
  app.use('/hilbert-api', express.json());

  // 4. 静态资源
  app.use(express.static(path.join(__dirname, '../../public')));
  // Markdown 编辑器资源随应用本地托管，避免运行时依赖外部 CDN。
  app.use('/vendor/vditor', express.static(path.join(__dirname, '../../node_modules/vditor')));
  // Markdown 渲染结果必须先经过 DOMPurify，再写入页面。
  app.use('/vendor/dompurify', express.static(path.join(__dirname, '../../node_modules/dompurify/dist')));

  // 5. 受保护的 API 路由（认证中间件已在 app 层全局注册）
  app.use('/hilbert-api/version', versionRouter);
  //    user.routes 挂载于 /hilbert-api → /hilbert-api/me, /my-permissions, /logout
  app.use('/hilbert-api', require('./user.routes'));
  app.use('/hilbert-api/rbac', require('./rbac.routes'));
  app.use('/hilbert-api/pages', require('./pages.routes'));
  app.use('/hilbert-api/groups', require('./groups.routes'));
  app.use('/hilbert-api/favorites', require('./favorites.routes'));
  app.use('/hilbert-api/ops', require('./ops.routes'));

  // 6. 独立页面查看器（每个页面拥有独立浏览器 URL）
  app.use('/page', require('./page.routes'));

  // 7. 自定义页面静态托管
  app.use('/hilbert-custom', proxy.customPagesDispatcher);

}

module.exports = { registerRoutes };
