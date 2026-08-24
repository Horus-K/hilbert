const { handleProxyRequest } = require('./proxy-handler');
const { userKey } = require('./cookie-jar');
const { hasPermission } = require('../services/rbac.service');
const pagesRepo = require('../repositories/pages.repository');

const proxyRoutes = new Map();
let routeEntries = [];

function canReadPage(req, page) {
  return req.user && hasPermission(req.user.email, page.id, 'read');
}

/**
 * 所有代理页面均使用显式挂载命名空间；不再把上游路径注册到 Hilbert 主站。
 */
function getMountPath(page) {
  return page.mountPath || '/hilbert-proxy/' + page.id;
}

function pathsOverlap(left, right) {
  return left === right || left.startsWith(right + '/') || right.startsWith(left + '/');
}

function refreshProxyRoutes() {
  const nextEntries = [];
  for (const page of pagesRepo.read()) {
    if (page.type !== 'link') continue;
    const path = getMountPath(page);
    const conflict = nextEntries.find(entry => pathsOverlap(entry.path, path));
    if (conflict) {
      console.error(`代理挂载路径冲突，已忽略页面 ${page.id}: ${path} 与 ${conflict.path}`);
      continue;
    }
    nextEntries.push({ path, pageId: page.id });
  }
  nextEntries.sort((a, b) => b.path.length - a.path.length);
  routeEntries = nextEntries;
  proxyRoutes.clear();
  for (const entry of routeEntries) {
    const page = pagesRepo.read().find(candidate => candidate.id === entry.pageId);
    if (page) proxyRoutes.set(entry.path, { page, mount: true });
  }
}

function findRouteByPath(reqPath) {
  for (const entry of routeEntries) {
    if (reqPath === entry.path || reqPath.startsWith(entry.path + '/')) {
      const page = pagesRepo.read().find(candidate => candidate.id === entry.pageId && candidate.type === 'link');
      if (page && getMountPath(page) === entry.path) {
        return { page, mountPrefix: entry.path };
      }
    }
  }
  return null;
}

const recentProxyPaths = new Map();
const RECENT_PROXY_PATHS_LIMIT = 5000;

function recentPathKey(path, user) {
  return `${userKey(user)}:${path}`;
}

function recordProxyPath(page, reqPath, user) {
  recentProxyPaths.set(recentPathKey(reqPath, user), page.id);
  if (recentProxyPaths.size > RECENT_PROXY_PATHS_LIMIT) {
    recentProxyPaths.delete(recentProxyPaths.keys().next().value);
  }
}

function findPageByReferer(referer, user) {
  let refUrl;
  try {
    refUrl = new URL(referer);
  } catch {
    return null;
  }

  const direct = findRouteByPath(refUrl.pathname);
  if (direct) return direct;

  const pageId = recentProxyPaths.get(recentPathKey(refUrl.pathname, user));
  if (!pageId) return null;
  const page = pagesRepo.read().find(candidate => candidate.id === pageId && candidate.type === 'link');
  return page ? { page, mountPrefix: getMountPath(page) } : null;
}

function resolveProxyRequest(req, user = req.user) {
  const reqPath = req.url.split('?')[0];
  const direct = findRouteByPath(reqPath);
  if (direct) return direct;
  if (req.headers.referer) return findPageByReferer(req.headers.referer, user);
  return null;
}

/**
 * Express 中只注册一次稳定 dispatcher；页面变化只替换内存路由表。
 */
function createProxyDispatcher() {
  return (req, res, next) => {
    const found = resolveProxyRequest(req);
    if (!found) return next();
    if (!canReadPage(req, found.page)) return res.status(403).send('没有查看该页面的权限');
    handleProxyRequest(found.page, req, res, null, found.mountPrefix);
  };
}

function getProxyRoutes() {
  return proxyRoutes;
}

module.exports = {
  createProxyDispatcher,
  findPageByReferer,
  findRouteByPath,
  getMountPath,
  getProxyRoutes,
  pathsOverlap,
  recordProxyPath,
  refreshProxyRoutes,
  resolveProxyRequest
};
