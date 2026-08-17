const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const AdmZip = require('adm-zip');
const { CUSTOM_PAGES_DIR, MAX_UPLOAD_SIZE } = require('../config');
const { customPageDir, ensureCustomPageDir, deleteCustomPageDir, copyDirSync, isAllowedExtension } = require('../utils/file-utils');
const { AppError } = require('../utils/errors');

// multer 配置：内存存储 + 扩展名/大小校验
const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    if (isAllowedExtension(file.originalname)) cb(null, true);
    else cb(new Error('不支持的文件类型: ' + path.extname(file.originalname)));
  },
  limits: { fileSize: MAX_UPLOAD_SIZE }
});

// 自定义页面动态路由注册
const customRoutesMap = new Map();

/**
 * 为每个 custom 页面挂载 /hilbert-custom/<id> 静态托管
 */
function registerCustomRoutes() {
  customRoutesMap.clear();
  const pagesRepo = require('../repositories/pages.repository');
  const pages = pagesRepo.read().filter(p => p.type === 'custom');
  for (const page of pages) {
    const dir = customPageDir(page.id);
    if (fs.existsSync(dir)) {
      customRoutesMap.set(page.id, express.static(dir, {
        index: [page.entry || 'index.html']
      }));
    }
  }
}

/**
 * /hilbert-custom/<pageId>/... 统一分发中间件
 */
function customPagesDispatcher(req, res, next) {
  const match = req.path.match(/^\/([^/]+)(\/.*)?$/);
  if (!match) return next();
  const handler = customRoutesMap.get(match[1]);
  if (!handler) return next();
  req.url = match[2] || '/';
  return handler(req, res, next);
}

/**
 * 初始化自定义页面：创建目录 + 默认 index.html
 */
function initCustomPage(pageId, sourceId) {
  ensureCustomPageDir(pageId);
  if (sourceId) {
    const srcDir = customPageDir(sourceId);
    if (fs.existsSync(srcDir)) copyDirSync(srcDir, customPageDir(pageId));
  } else {
    const defaultHtml = '<!DOCTYPE html>\n<html lang="zh-CN">\n<head><meta charset="UTF-8"><title>新页面</title></head>\n<body>\n<h1>自定义页面</h1>\n<p>上传 HTML/CSS/JS 文件开始编辑。</p>\n</body>\n</html>';
    fs.writeFileSync(path.join(customPageDir(pageId), 'index.html'), defaultHtml, 'utf8');
  }
}

/**
 * 处理文件上传（支持单文件或多文件 + zip 包解压）
 */
function handleUpload(pageId, files) {
  const pagesRepo = require('../repositories/pages.repository');
  const pages = pagesRepo.read();
  const page = pages.find(p => p.id === pageId && p.type === 'custom');
  if (!page) throw new AppError('自定义页面不存在', 404);

  const targetDir = ensureCustomPageDir(pageId);
  const uploadedFiles = [];

  if (files && files.length) {
    for (const file of files) {
      if (file.originalname.toLowerCase().endsWith('.zip')) {
        try {
          const zip = new AdmZip(file.buffer);
          for (const entry of zip.getEntries()) {
            if (entry.isDirectory) continue;
            const safeName = path.basename(entry.entryName);
            if (!safeName || safeName.startsWith('.')) continue;
            if (!isAllowedExtension(safeName)) continue;
            const fullPath = path.join(targetDir, safeName);
            if (!fullPath.startsWith(CUSTOM_PAGES_DIR + path.sep)) continue;
            fs.writeFileSync(fullPath, entry.getData());
            uploadedFiles.push(safeName);
          }
        } catch (e) {
          throw new AppError('zip 解压失败: ' + e.message, 400);
        }
      } else {
        const safeName = path.basename(file.originalname);
        if (!isAllowedExtension(safeName)) continue;
        fs.writeFileSync(path.join(targetDir, safeName), file.buffer);
        uploadedFiles.push(safeName);
      }
    }
  }

  return { uploaded: uploadedFiles };
}

/**
 * 列出自定义页面文件
 */
function listFiles(pageId) {
  const dir = customPageDir(pageId);
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter(f => {
    try { return fs.statSync(path.join(dir, f)).isFile(); } catch { return false; }
  }).map(name => ({ name, size: fs.statSync(path.join(dir, name)).size }));
  return files;
}

/**
 * 删除自定义页面中的单个文件
 */
function deleteFile(pageId, filename) {
  const pagesRepo = require('../repositories/pages.repository');
  const pages = pagesRepo.read();
  const page = pages.find(p => p.id === pageId && p.type === 'custom');
  if (!page) throw new AppError('页面不存在', 404);

  const safeName = path.basename(filename);
  if (!safeName || safeName.startsWith('.')) throw new AppError('文件名不合法', 400);
  if (safeName === (page.entry || 'index.html')) throw new AppError('不能删除入口文件', 400);

  const filePath = path.join(customPageDir(pageId), safeName);
  if (!fs.existsSync(filePath)) throw new AppError('文件不存在', 404);
  fs.unlinkSync(filePath);
  return { deleted: safeName };
}

module.exports = {
  upload,
  registerCustomRoutes,
  customPagesDispatcher,
  initCustomPage,
  handleUpload,
  listFiles,
  deleteFile,
  deleteCustomPageDir,
  customPageDir,
  ensureCustomPageDir,
};
