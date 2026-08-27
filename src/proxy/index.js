const {
  createProxyDispatcher,
  findPageByReferer,
  getMountPath,
  getProxyRoutes,
  recordProxyPath,
  refreshProxyRoutes,
  resolveProxyRequest
} = require('./route-manager');
const { handleProxyRequest, resolveProxyTarget } = require('./proxy-handler');
const { setupWebSocket } = require('./websocket');
const { registerCustomRoutes, customPagesDispatcher } = require('../services/custom-pages.service');
const pagesRepo = require('../repositories/pages.repository');

/**
 * 初始化代理模块：注册代理路由 + 自定义页面路由
 * 监听页面变更事件自动刷新路由
 */
let initialized = false;

function init() {
  refreshProxyRoutes();
  registerCustomRoutes();
  if (initialized) return;
  initialized = true;
  pagesRepo.events.on('pages:changed', () => {
    refreshProxyRoutes();
    registerCustomRoutes();
  });
}

module.exports = {
  init,
  createProxyDispatcher,
  handleProxyRequest,
  resolveProxyTarget,
  setupWebSocket,
  registerCustomRoutes,
  customPagesDispatcher,
  recordProxyPath,
  getProxyRoutes,
  findPageByReferer,
  getMountPath,
  refreshProxyRoutes,
  resolveProxyRequest,
};
