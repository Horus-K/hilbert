const express = require('express');
const router = express.Router();
const { hasPermission, isAdmin } = require('../services/rbac.service');
const pagesService = require('../services/pages.service');
const customPagesService = require('../services/custom-pages.service');
const { AppError } = require('../utils/errors');
const {
  buildProxySessionExchangeUrl,
  exposeProxyOrigin,
  getLegacyPageProxyUrl,
  getPageEntryPath,
  isHostRoutingEnabled
} = require('../utils/proxy-origin');
const { issueProxyTicket } = require('../services/proxy-session.service');

// 获取全部页面（按权限过滤）
router.get('/', (req, res) => {
  const email = req.user.email;
  const pages = pagesService.getAllPages(email, isAdmin, hasPermission);
  res.json(pages.map(page => exposeProxyOrigin(page, req)));
});

// 进入外部代理页面：主站认证后签发一次性票据，再跳转到页面专属 Host 换取独立会话。
router.get('/:id/open', (req, res) => {
  if (!hasPermission(req.user.email, req.params.id, 'read')) {
    throw new AppError('没有查看该页面的权限', 403);
  }
  const page = pagesService.getPageById(req.params.id);
  if (page.type !== 'link') throw new AppError('该页面不是外部代理页面');

  res.setHeader('Cache-Control', 'no-store');
  if (!isHostRoutingEnabled()) {
    return res.redirect(302, getLegacyPageProxyUrl(page, req));
  }

  const ticket = issueProxyTicket(page, req.user, getPageEntryPath(page));
  return res.redirect(302, buildProxySessionExchangeUrl(page, req, ticket));
});

// 新增页面
router.post('/', (req, res) => {
  if (!hasPermission(req.user.email, '*', 'create')) {
    throw new AppError('没有创建页面的权限', 403);
  }
  const page = pagesService.createPage(req.body);
  res.status(201).json(exposeProxyOrigin(page, req));
});

// 更新页面
router.put('/:id', (req, res) => {
  if (!hasPermission(req.user.email, req.params.id, 'update')) {
    throw new AppError('没有修改该页面的权限', 403);
  }
  const page = pagesService.updatePage(req.params.id, req.body);
  res.json(exposeProxyOrigin(page, req));
});

// 删除页面
router.delete('/:id', (req, res) => {
  if (!hasPermission(req.user.email, req.params.id, 'delete')) {
    throw new AppError('没有删除该页面的权限', 403);
  }
  const removed = pagesService.deletePage(req.params.id);
  res.json(removed);
});

// 切换页面置顶（仅管理员）
router.put('/:id/pin', (req, res) => {
  if (!isAdmin(req.user.email)) {
    throw new AppError('仅管理员可置顶页面', 403);
  }
  const page = pagesService.togglePin(req.params.id);
  res.json(page);
});

// 上传文件（支持多文件 + zip 包）
router.post('/:id/upload', (req, res, next) => {
  if (!hasPermission(req.user.email, req.params.id, 'update')) {
    throw new AppError('没有修改该页面的权限', 403);
  }
  customPagesService.upload.array('files', 50)(req, res, (err) => {
    if (err) {
      return next(err.code === 'LIMIT_FILE_SIZE' ? err : new AppError(err.message, 400));
    }
    try {
      const result = customPagesService.handleUpload(req.params.id, req.files);
      return res.json(result);
    } catch (uploadError) {
      return next(uploadError);
    }
  });
});

// 列出文件
router.get('/:id/files', (req, res) => {
  if (!hasPermission(req.user.email, req.params.id, 'read')) {
    throw new AppError('没有查看该页面的权限', 403);
  }
  const files = customPagesService.listFiles(req.params.id);
  res.json(files);
});

// 删除单个文件
router.delete('/:id/files/:filename', (req, res) => {
  if (!hasPermission(req.user.email, req.params.id, 'update')) {
    throw new AppError('没有修改该页面的权限', 403);
  }
  const result = customPagesService.deleteFile(req.params.id, req.params.filename);
  res.json(result);
});

// 获取页面专属文档
router.get('/:id/doc', (req, res) => {
  if (!hasPermission(req.user.email, req.params.id, 'read')) {
    throw new AppError('没有查看该页面的权限', 403);
  }
  const doc = pagesService.getPageDoc(req.params.id);
  res.json(doc);
});

// 更新页面专属文档
router.put('/:id/doc', (req, res) => {
  if (!hasPermission(req.user.email, req.params.id, 'update')) {
    throw new AppError('没有修改该页面的权限', 403);
  }
  const { content } = req.body;
  const doc = pagesService.updatePageDoc(req.params.id, content);
  res.json(doc);
});

module.exports = router;
