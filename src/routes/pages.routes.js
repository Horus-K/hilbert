const express = require('express');
const router = express.Router();
const { hasPermission, isAdmin } = require('../services/rbac.service');
const pagesService = require('../services/pages.service');
const customPagesService = require('../services/custom-pages.service');
const { AppError } = require('../utils/errors');

// 获取全部页面（按权限过滤）
router.get('/', (req, res) => {
  const email = req.user.email;
  const pages = pagesService.getAllPages(email, isAdmin, hasPermission);
  res.json(pages);
});

// 新增页面
router.post('/', (req, res) => {
  if (!hasPermission(req.user.email, '*', 'create')) {
    throw new AppError('没有创建页面的权限', 403);
  }
  const page = pagesService.createPage(req.body);
  res.status(201).json(page);
});

// 更新页面
router.put('/:id', (req, res) => {
  if (!hasPermission(req.user.email, req.params.id, 'update')) {
    throw new AppError('没有修改该页面的权限', 403);
  }
  const page = pagesService.updatePage(req.params.id, req.body);
  res.json(page);
});

// 删除页面
router.delete('/:id', (req, res) => {
  if (!hasPermission(req.user.email, req.params.id, 'delete')) {
    throw new AppError('没有删除该页面的权限', 403);
  }
  const removed = pagesService.deletePage(req.params.id);
  res.json(removed);
});

// 上传文件（支持多文件 + zip 包）
router.post('/:id/upload', (req, res) => {
  if (!hasPermission(req.user.email, req.params.id, 'update')) {
    throw new AppError('没有修改该页面的权限', 403);
  }
  customPagesService.upload.array('files', 50)(req, res, (err) => {
    if (err) throw new AppError(err.message, 400);
    const result = customPagesService.handleUpload(req.params.id, req.files);
    res.json(result);
  });
});

// 列出文件
router.get('/:id/files', (req, res) => {
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

module.exports = router;
