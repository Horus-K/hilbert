const { registerProxyRoutes, createRefererFallback, recordProxyPath, getProxyRoutes, findPageByReferer } = require('./route-manager');
const { handleProxyRequest, resolveProxyTarget } = require('./proxy-handler');
const { setupWebSocket } = require('./websocket');
const { registerCustomRoutes, customPagesDispatcher } = require('../services/custom-pages.service');
const pagesRepo = require('../repositories/pages.repository');

/**
 * 初始化代理模块：注册代理路由 + 自定义页面路由
 * 监听页面变更事件自动刷新路由
 */
function init(app) {
  // 首次注册
  registerProxyRoutes(app);
  registerCustomRoutes();

  // 页面变更时自动重新注册（事件驱动，替代原 monkey-patch）
  pagesRepo.events.on('pages:changed', () => {
    registerProxyRoutes(app);
    registerCustomRoutes();
  });
}

module.exports = {
  init,
  registerProxyRoutes,
  createRefererFallback,
  handleProxyRequest,
  resolveProxyTarget,
  setupWebSocket,
  registerCustomRoutes,
  customPagesDispatcher,
  recordProxyPath,
  getProxyRoutes,
  findPageByReferer,
};
