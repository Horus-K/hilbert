const crypto = require('crypto');
const path = require('path');
const { PAGE_TYPES, external_proxy: externalProxyConfig } = require('../config');
const { AppError } = require('../utils/errors');
const {
  isValidUrl,
  normalizeAuth,
  normalizeAuthOrigins,
  normalizeMountPath,
  normalizeOrigins,
  normalizeResolveIp,
  normalizeSessionMode
} = require('../utils/validators');
const { mergeAuthSecrets } = require('../utils/auth-secrets');
const pagesRepo = require('../repositories/pages.repository');
const markdownSvc = require('./markdown.service');
const customPagesSvc = require('./custom-pages.service');
const pageDocsSvc = require('./page-docs.service');
const rbacSvc = require('./rbac.service');
const favoritesSvc = require('./favorites.service');

const hostRoutingEnabled = Boolean(externalProxyConfig.public_host_template);

/**
 * 检查挂载路径是否与其他页面重叠。父子路径也会被 Express 前缀路由互相抢占。
 */
function mountPathConflict(pages, mountPath, excludeId) {
  return pages.some(p => {
    if (p.id === excludeId || p.type !== 'link') return false;
    const existing = p.mountPath || '/hilbert-proxy/' + p.id;
    return existing === mountPath || existing.startsWith(mountPath + '/') || mountPath.startsWith(existing + '/');
  });
}

/**
 * 获取全部页面（按权限过滤）
 */
function getAllPages(email, adminCheck, permCheck) {
  const allPages = pagesRepo.read().map(markdownSvc.resolvePage).map(pageDocsSvc.resolvePageDoc);
  if (adminCheck(email)) return allPages;
  return allPages.filter(p => permCheck(email, p.id, 'read'));
}

function getPageById(id) {
  const page = pagesRepo.read().find(candidate => candidate.id === id);
  if (!page) throw new AppError('页面不存在', 404);
  return pageDocsSvc.resolvePageDoc(markdownSvc.resolvePage(page));
}

/**
 * 创建页面
 */
function createPage(data = {}) {
  const {
    type = 'link', name, url, icon, groupId, content, auth, mountPath, resolveIp,
    sessionMode, origins, authOrigins, sourceId
  } = data;

  if (!PAGE_TYPES.includes(type)) throw new AppError('不支持的页面类型');
  if (!name || !name.trim()) throw new AppError('页面名称不能为空');
  if ((type === 'link' || type === 'direct' || type === 'iframe') && !isValidUrl(url)) {
    throw new AppError('请输入合法的 http/https 链接');
  }

  const pages = pagesRepo.read();
  const page = {
    id: crypto.randomUUID(),
    type,
    name: name.trim(),
    icon: (icon || ({ markdown: '📝', custom: '🖥️', direct: '🔗', iframe: '🖼️' }[type] || '🔗')).trim(),
    groupId: groupId || null
  };

  if (type === 'link' || type === 'direct' || type === 'iframe') {
    page.url = url.trim();
    if (type === 'link') {
      const normalizedSessionMode = normalizeSessionMode(sessionMode);
      if (!normalizedSessionMode) throw new AppError('会话模式不合法');
      if (normalizedSessionMode === 'browser') {
        if (!hostRoutingEnabled) throw new AppError('浏览器会话仅支持逐页面 Host 路由');
        page.sessionMode = 'browser';
      }
      const normalizedOrigins = normalizeOrigins(origins);
      if (!normalizedOrigins) throw new AppError('关联 origin 配置不合法');
      const normalizedAuthOrigins = normalizeAuthOrigins(authOrigins, normalizedOrigins);
      if (!normalizedAuthOrigins) throw new AppError('关联 origin 认证配置不合法');
      if (Object.keys(normalizedOrigins).length) {
        if (!hostRoutingEnabled) throw new AppError('关联 origin 仅支持逐页面 Host 路由');
        const originValues = Object.values(normalizedOrigins);
        if (new Set(originValues).size !== originValues.length || originValues.includes(new URL(page.url).origin)) {
          throw new AppError('关联 origin 不能重复或与主页面 origin 相同');
        }
        if (normalizedSessionMode === 'browser') throw new AppError('浏览器会话不能与关联 origin 同时使用');
        page.origins = normalizedOrigins;
      }
      page.proxyMode = hostRoutingEnabled ? 'host' : 'mount';
      if (!hostRoutingEnabled) {
        const mp = normalizeMountPath(mountPath);
        if (mp === undefined) throw new AppError('挂载路径不合法');
        if (mp) {
          if (mountPathConflict(pages, mp)) throw new AppError('挂载路径与其他页面重叠');
          page.mountPath = mp;
        }
      }
      const normalizedResolveIp = normalizeResolveIp(resolveIp);
      if (normalizedResolveIp === undefined) throw new AppError('DNS 解析 IP 不合法');
      if (normalizedResolveIp) page.resolveIp = normalizedResolveIp;
      let authInput = auth;
      if (authInput === undefined && sourceId) {
        const sourcePage = pages.find(candidate => candidate.id === sourceId && candidate.type === 'link');
        if (!sourcePage) throw new AppError('源页面不存在或类型不匹配', 404);
        authInput = sourcePage.auth || null;
      }
      const normalized = normalizeAuth(authInput);
      if (normalized === undefined) throw new AppError('认证信息不完整');
      if (normalizedSessionMode === 'browser' && normalized && normalized.mode === 'login') {
        throw new AppError('浏览器会话不能使用自动表单登录');
      }
      if (normalizedAuthOrigins.length) {
        if (!normalized) throw new AppError('关联 origin 认证需要先配置页面认证');
        page.authOrigins = normalizedAuthOrigins;
      }
      if (normalized) page.auth = normalized;
    }
  } else if (type === 'custom') {
    customPagesSvc.initCustomPage(page.id, sourceId);
    page.entry = 'index.html';
  } else {
    // Markdown
    const text = (content && content.trim())
      ? content
      : '# 新文档\n\n点击右上角「编辑」开始编写内容。';
    page.content = markdownSvc.writeMdFile(page.id + '.md', text);
  }

  pagesRepo.write([...pages, page]);
  return markdownSvc.resolvePage(page);
}

/**
 * 更新页面
 */
function updatePage(id, data = {}) {
  const pages = pagesRepo.read();
  const idx = pages.findIndex(p => p.id === id);
  if (idx === -1) throw new AppError('页面不存在', 404);

  const current = { ...pages[idx] };
  const {
    type, name, url, icon, groupId, content, auth, mountPath, resolveIp,
    sessionMode, origins, authOrigins
  } = data;

  if (type !== undefined) {
    if (!PAGE_TYPES.includes(type)) throw new AppError('不支持的页面类型');
    current.type = type;
  }
  if (name !== undefined) {
    if (!name.trim()) throw new AppError('页面名称不能为空');
    current.name = name.trim();
  }
  if (url !== undefined) current.url = url.trim();
  if (resolveIp !== undefined) {
    const normalizedResolveIp = normalizeResolveIp(resolveIp);
    if (normalizedResolveIp === undefined) throw new AppError('DNS 解析 IP 不合法');
    if (normalizedResolveIp) current.resolveIp = normalizedResolveIp;
    else delete current.resolveIp;
  }
  if (current.type === 'link') {
    if (origins !== undefined) {
      const normalizedOrigins = normalizeOrigins(origins);
      if (!normalizedOrigins) throw new AppError('关联 origin 配置不合法');
      if (Object.keys(normalizedOrigins).length) current.origins = normalizedOrigins;
      else delete current.origins;
    }
    if (sessionMode !== undefined) {
      const normalizedSessionMode = normalizeSessionMode(sessionMode);
      if (!normalizedSessionMode) throw new AppError('会话模式不合法');
      if (normalizedSessionMode === 'browser') current.sessionMode = 'browser';
      else delete current.sessionMode;
    }
    current.proxyMode = hostRoutingEnabled ? 'host' : 'mount';
    if (hostRoutingEnabled) {
      delete current.mountPath;
    } else if (mountPath !== undefined) {
      const mp = normalizeMountPath(mountPath);
      if (mp === undefined) throw new AppError('挂载路径不合法');
      if (mp) {
        if (mountPathConflict(pages, mp, id)) throw new AppError('挂载路径与其他页面重叠');
        current.mountPath = mp;
      } else delete current.mountPath;
    }
  }
  if (auth !== undefined) {
    const normalized = normalizeAuth(mergeAuthSecrets(current.auth, auth));
    if (normalized === undefined) throw new AppError('认证信息不完整');
    if (normalized) current.auth = normalized;
    else {
      delete current.auth;
      delete current.authOrigins;
    }
  }
  if (authOrigins !== undefined) {
    const normalizedAuthOrigins = normalizeAuthOrigins(authOrigins, current.origins || {});
    if (!normalizedAuthOrigins) throw new AppError('关联 origin 认证配置不合法');
    if (normalizedAuthOrigins.length) current.authOrigins = normalizedAuthOrigins;
    else delete current.authOrigins;
  }
  if (icon !== undefined) current.icon = icon.trim() || ({ markdown: '📝', custom: '🖥️', direct: '🔗', iframe: '🖼️' }[current.type] || '🔗');
  if (groupId !== undefined) current.groupId = groupId || null;

  // 按最终类型做一致性校验，并清理不属于该类型的字段
  if (current.type === 'link') {
    if (!isValidUrl(current.url)) throw new AppError('请输入合法的 http/https 链接');
    if (current.sessionMode === 'browser') {
      if (!hostRoutingEnabled) throw new AppError('浏览器会话仅支持逐页面 Host 路由');
      if (current.auth && current.auth.mode === 'login') throw new AppError('浏览器会话不能使用自动表单登录');
    }
    if (current.origins && !hostRoutingEnabled) throw new AppError('关联 origin 仅支持逐页面 Host 路由');
    if (current.origins) {
      const originValues = Object.values(current.origins);
      if (new Set(originValues).size !== originValues.length || originValues.includes(new URL(current.url).origin)) {
        throw new AppError('关联 origin 不能重复或与主页面 origin 相同');
      }
      if (current.sessionMode === 'browser') throw new AppError('浏览器会话不能与关联 origin 同时使用');
    }
    if (current.authOrigins && (!current.auth || !normalizeAuthOrigins(current.authOrigins, current.origins || {}))) {
      throw new AppError('关联 origin 认证配置不合法');
    }
    markdownSvc.deleteMdFile(current.content);
    delete current.content;
  } else if (current.type === 'direct' || current.type === 'iframe') {
    if (!isValidUrl(current.url)) throw new AppError('请输入合法的 http/https 链接');
    markdownSvc.deleteMdFile(current.content);
    delete current.content;
    delete current.auth;
    delete current.proxyMode;
    delete current.mountPath;
    delete current.resolveIp;
    delete current.sessionMode;
    delete current.origins;
    delete current.authOrigins;
  } else {
    if (current.type === 'custom') {
      delete current.auth;
      delete current.url;
      delete current.proxyMode;
      delete current.mountPath;
      delete current.resolveIp;
      delete current.sessionMode;
      delete current.origins;
      delete current.authOrigins;
      if (data.entry !== undefined) {
        const entry = String(data.entry || 'index.html').trim();
        if (/[/\\]/.test(entry) || entry.includes('..')) throw new AppError('入口文件名不合法');
        current.entry = entry || 'index.html';
      }
    } else {
      customPagesSvc.deleteCustomPageDir(current.id);
      delete current.entry;
      delete current.auth;
      delete current.url;
      delete current.proxyMode;
      delete current.mountPath;
      delete current.resolveIp;
      delete current.sessionMode;
      delete current.origins;
      delete current.authOrigins;
    }
    if (current.type === 'markdown') {
      if (content !== undefined) {
        if (!content.trim()) throw new AppError('Markdown 内容不能为空');
        const fileName = markdownSvc.isContentPath(current.content) ? path.basename(current.content) : current.id + '.md';
        current.content = markdownSvc.writeMdFile(fileName, content);
      } else if (!markdownSvc.isContentPath(current.content)) {
        const text = (current.content && current.content.trim())
          ? current.content
          : '# 新文档\n\n点击右上角「编辑」开始编写内容。';
        current.content = markdownSvc.writeMdFile(current.id + '.md', text);
      }
    }
  }

  const nextPages = [...pages];
  nextPages[idx] = current;
  pagesRepo.write(nextPages);
  return markdownSvc.resolvePage(current);
}

/**
 * 删除页面
 */
function deletePage(id) {
  const pages = pagesRepo.read();
  const idx = pages.findIndex(p => p.id === id);
  if (idx === -1) throw new AppError('页面不存在', 404);

  const removed = pages[idx];
  const nextPages = pages.filter(page => page.id !== id);
  // 先原子提交主页面数据，再清理可重试的关联项，避免写入失败时提前删除页面文件。
  pagesRepo.write(nextPages);
  rbacSvc.removePagePermissions(removed.id);
  favoritesSvc.removePageFromAll(removed.id);
  markdownSvc.deleteMdFile(removed.content);
  pageDocsSvc.deletePageDoc(removed.id);
  customPagesSvc.deleteCustomPageDir(removed.id);
  return removed;
}

/**
 * 切换页面置顶状态（仅管理员）
 */
function togglePin(id) {
  const pages = pagesRepo.read();
  const idx = pages.findIndex(p => p.id === id);
  if (idx === -1) throw new AppError('页面不存在', 404);

  const page = { ...pages[idx], pinned: !pages[idx].pinned };
  const nextPages = [...pages];
  nextPages[idx] = page;
  pagesRepo.write(nextPages);
  return markdownSvc.resolvePage(page);
}

module.exports = { getAllPages, getPageById, createPage, updatePage, deletePage, togglePin };

/**
 * 获取页面专属文档内容
 */
function getPageDoc(pageId) {
  const pages = pagesRepo.read();
  const idx = pages.findIndex(p => p.id === pageId);
  if (idx === -1) throw new AppError('页面不存在', 404);
  const content = pageDocsSvc.readPageDoc(pageId);
  return { pageId, content, hasDoc: content !== null };
}

/**
 * 更新页面专属文档
 */
function updatePageDoc(pageId, content) {
  const pages = pagesRepo.read();
  const idx = pages.findIndex(p => p.id === pageId);
  if (idx === -1) throw new AppError('页面不存在', 404);
  if (!content || !content.trim()) {
    pageDocsSvc.deletePageDoc(pageId);
    return { pageId, content: '', hasDoc: false };
  }
  pageDocsSvc.writePageDoc(pageId, content);
  return { pageId, content, hasDoc: true };
}

module.exports.getPageDoc = getPageDoc;
module.exports.updatePageDoc = updatePageDoc;
