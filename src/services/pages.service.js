const crypto = require('crypto');
const path = require('path');
const { PAGE_TYPES } = require('../config');
const { AppError } = require('../utils/errors');
const { isValidUrl, normalizeAuth, normalizeMountPath } = require('../utils/validators');
const pagesRepo = require('../repositories/pages.repository');
const markdownSvc = require('./markdown.service');
const customPagesSvc = require('./custom-pages.service');
const pageDocsSvc = require('./page-docs.service');

/**
 * 检查自定义挂载路径是否与其他页面冲突（其他挂载路径 / 恒等映射的路径前缀）
 */
function mountPathConflict(pages, mountPath, excludeId) {
  return pages.some(p => {
    if (p.id === excludeId || p.type !== 'link') return false;
    if (p.proxyMode === 'mount') return (p.mountPath || '/hilbert-proxy/' + p.id) === mountPath;
    try {
      const segs = new URL(p.url).pathname.split('/').filter(Boolean);
      let cur = '';
      for (const seg of segs) {
        cur += '/' + seg;
        if (cur === mountPath) return true;
      }
    } catch { /* 无效 URL 忽略 */ }
    return false;
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

/**
 * 创建页面
 */
function createPage(data) {
  const { type = 'link', name, url, icon, group, content, auth, proxyMode, mountPath, resolveIp, sourceId } = data;

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
    group: (group || '未分组').trim()
  };

  if (type === 'link' || type === 'direct' || type === 'iframe') {
    page.url = url.trim();
    if (type === 'link') {
      if (proxyMode === 'mount') {
        page.proxyMode = 'mount';
        const mp = normalizeMountPath(mountPath);
        if (mp === undefined) throw new AppError('挂载路径不合法');
        if (mp) {
          if (mountPathConflict(pages, mp)) throw new AppError('挂载路径已被其他页面占用');
          page.mountPath = mp;
        }
      }
      if (resolveIp) page.resolveIp = resolveIp.trim();
      const normalized = normalizeAuth(auth);
      if (normalized === undefined) throw new AppError('认证信息不完整');
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

  pages.push(page);
  pagesRepo.write(pages);
  return markdownSvc.resolvePage(page);
}

/**
 * 更新页面
 */
function updatePage(id, data) {
  const pages = pagesRepo.read();
  const idx = pages.findIndex(p => p.id === id);
  if (idx === -1) throw new AppError('页面不存在', 404);

  const current = pages[idx];
  const { type, name, url, icon, group, content, auth, proxyMode, mountPath, resolveIp } = data;

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
    if (resolveIp) current.resolveIp = resolveIp.trim();
    else delete current.resolveIp;
  }
  if (proxyMode !== undefined) {
    if (proxyMode === 'mount') current.proxyMode = 'mount';
    else delete current.proxyMode;
  }
  // 自定义挂载路径：仅挂载模式生效，非挂载模式静默清除
  if (current.proxyMode === 'mount') {
    if (mountPath !== undefined) {
      const mp = normalizeMountPath(mountPath);
      if (mp === undefined) throw new AppError('挂载路径不合法');
      if (mp) {
        if (mountPathConflict(pages, mp, id)) throw new AppError('挂载路径已被其他页面占用');
        current.mountPath = mp;
      } else delete current.mountPath;
    }
  } else {
    delete current.mountPath;
  }
  if (auth !== undefined) {
    const normalized = normalizeAuth(auth);
    if (normalized === undefined) throw new AppError('认证信息不完整');
    if (normalized) current.auth = normalized;
    else delete current.auth;
  }
  if (icon !== undefined) current.icon = icon.trim() || ({ markdown: '📝', custom: '🖥️', direct: '🔗', iframe: '🖼️' }[current.type] || '🔗');
  if (group !== undefined) current.group = (group || '未分组').trim();

  // 按最终类型做一致性校验，并清理不属于该类型的字段
  if (current.type === 'link') {
    if (!isValidUrl(current.url)) throw new AppError('请输入合法的 http/https 链接');
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
  } else {
    if (current.type === 'custom') {
      delete current.auth;
      delete current.url;
      delete current.mountPath;
      delete current.resolveIp;
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
      delete current.mountPath;
      delete current.resolveIp;
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

  pages[idx] = current;
  pagesRepo.write(pages);
  return markdownSvc.resolvePage(current);
}

/**
 * 删除页面
 */
function deletePage(id) {
  const pages = pagesRepo.read();
  const idx = pages.findIndex(p => p.id === id);
  if (idx === -1) throw new AppError('页面不存在', 404);

  const [removed] = pages.splice(idx, 1);
  markdownSvc.deleteMdFile(removed.content);
  pageDocsSvc.deletePageDoc(removed.id);
  customPagesSvc.deleteCustomPageDir(removed.id);
  pagesRepo.write(pages);
  return removed;
}

/**
 * 切换页面置顶状态（仅管理员）
 */
function togglePin(id) {
  const pages = pagesRepo.read();
  const idx = pages.findIndex(p => p.id === id);
  if (idx === -1) throw new AppError('页面不存在', 404);

  pages[idx].pinned = !pages[idx].pinned;
  pagesRepo.write(pages);
  return markdownSvc.resolvePage(pages[idx]);
}

module.exports = { getAllPages, createPage, updatePage, deletePage, togglePin };

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
