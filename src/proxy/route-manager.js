const { handleProxyRequest } = require('./proxy-handler');

// 存储已注册的代理路由
const proxyRoutes = new Map(); // pathPrefix -> { page, mount }

// 最近经由代理转发的请求路径 -> 页面 id（来源归属链）
const recentProxyPaths = new Map();
const RECENT_PROXY_PATHS_LIMIT = 5000;

/**
 * 记录代理路径归属
 */
function recordProxyPath(page, reqPath) {
  recentProxyPaths.set(reqPath, page.id);
  if (recentProxyPaths.size > RECENT_PROXY_PATHS_LIMIT) {
    recentProxyPaths.delete(recentProxyPaths.keys().next().value);
  }
}

/**
 * 按 Referer 识别来源页面
 */
function findPageByReferer(referer) {
  let refUrl;
  try {
    refUrl = new URL(referer);
  } catch {
    return null;
  }

  // ① 已注册代理路由前缀最长匹配
  let page = null;
  let mountPrefix = null;
  let bestLen = 0;
  for (const [pathPrefix, entry] of proxyRoutes) {
    if ((entry.page.proxyMode === 'mount') !== entry.mount) continue;
    if ((refUrl.pathname === pathPrefix || refUrl.pathname.startsWith(pathPrefix + '/')) &&
        pathPrefix.length > bestLen) {
      page = entry.page;
      bestLen = pathPrefix.length;
      mountPrefix = entry.mount ? pathPrefix : null;
    }
  }
  if (page) return { page, mountPrefix };

  // ①.5 同域路径归属
  const refOrigin = refUrl.origin;
  let pathMatchPage = null;
  let pathMatchLen = 0;
  const pagesRepo = require('../repositories/pages.repository');
  for (const p of pagesRepo.read()) {
    if (p.type !== 'link' || p.proxyMode === 'mount') continue;
    let target;
    try {
      target = new URL(p.url);
    } catch {
      continue;
    }
    if (target.origin !== refOrigin) continue;
    const pagePath = target.pathname.replace(/\/+$/, '');
    if (!pagePath) continue;
    if ((refUrl.pathname === pagePath || refUrl.pathname.startsWith(pagePath + '/')) &&
        pagePath.length > pathMatchLen) {
      pathMatchPage = p;
      pathMatchLen = pagePath.length;
    }
  }
  if (pathMatchPage) return { page: pathMatchPage, mountPrefix: null };

  // ② 目标站 origin 匹配
  let best = null;
  for (const p of pagesRepo.read()) {
    if (p.type !== 'link' || p.proxyMode === 'mount') continue;
    let target;
    try {
      target = new URL(p.url);
    } catch {
      continue;
    }
    if (target.origin === refOrigin) {
      if (!best || target.pathname.length > new URL(best.url).pathname.length) best = p;
    }
  }
  if (best) return { page: best, mountPrefix: null };

  // ③ 归属链
  const servedBy = recentProxyPaths.get(refUrl.pathname);
  if (servedBy) {
    const p = pagesRepo.read().find(x => x.id === servedBy && x.type === 'link');
    if (p) {
      return {
        page: p,
        mountPrefix: p.proxyMode === 'mount' ? '/hilbert-proxy/' + p.id : null
      };
    }
  }
  return null;
}

/**
 * 动态注册代理路由
 */
function registerProxyRoutes(app) {
  proxyRoutes.clear();

  const pagesRepo = require('../repositories/pages.repository');
  const pages = pagesRepo.read().filter(p => p.type === 'link');
  const routesToRegister = [];

  for (const page of pages) {
    try {
      const url = new URL(page.url);
      const fullPath = url.pathname.replace(/\/+$/, '');

      if (page.proxyMode === 'mount') {
        const mountPath = '/hilbert-proxy/' + page.id;
        routesToRegister.push({ path: mountPath, page, mount: true, priority: mountPath.length });
        continue;
      }

      if (!fullPath) continue;

      const segments = fullPath.split('/').filter(Boolean);
      const prefixes = [];
      let currentPath = '';
      for (const seg of segments) {
        currentPath += '/' + seg;
        prefixes.push(currentPath);
      }

      for (const prefix of prefixes) {
        routesToRegister.push({ path: prefix, page, mount: false, priority: prefix.length });
      }
    } catch { /* 无效 URL 忽略 */ }
  }

  // 按优先级排序（路径越长优先级越高）
  routesToRegister.sort((a, b) => b.priority - a.priority);

  // 注册路由（去重）
  const registeredPaths = new Set();
  for (const { path, page, mount } of routesToRegister) {
    if (registeredPaths.has(path)) continue;
    registeredPaths.add(path);

    proxyRoutes.set(path, { page, mount });

    app.use(path, (req, res, next) => {
      const pagesRepo = require('../repositories/pages.repository');
      const currentPage = pagesRepo.read().find(p => p.id === page.id && p.type === 'link');
      if (!currentPage || (currentPage.proxyMode === 'mount') !== mount) return next();
      handleProxyRequest(currentPage, req, res, mount ? null : path, mount ? path : undefined);
    });
  }
}

/**
 * 创建 Referer 兜底代理中间件
 */
function createRefererFallback() {
  return (req, res, next) => {
    const reqPath = req.url.split('?')[0];
    if (reqPath.startsWith('/hilbert-api') || reqPath.startsWith('/hilbert-custom')) return next();
    for (const pathPrefix of proxyRoutes.keys()) {
      if (reqPath === pathPrefix || reqPath.startsWith(pathPrefix + '/')) return next();
    }
    const found = findPageByReferer(req.headers.referer);
    if (!found) return next();
    handleProxyRequest(found.page, req, res, '', found.mountPrefix || undefined);
  };
}

/**
 * 获取代理路由表（供 WebSocket 模块使用）
 */
function getProxyRoutes() {
  return proxyRoutes;
}

module.exports = {
  registerProxyRoutes,
  createRefererFallback,
  findPageByReferer,
  recordProxyPath,
  getProxyRoutes,
};
