const fs = require('fs');
const path = require('path');
const { CUSTOM_PAGES_DIR, ALLOWED_EXTENSIONS } = require('../config');

/**
 * 获取自定义页面目录路径
 */
function customPageDir(pageId) {
  return path.join(CUSTOM_PAGES_DIR, pageId);
}

/**
 * 确保自定义页面目录存在
 */
function ensureCustomPageDir(pageId) {
  const dir = customPageDir(pageId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 删除自定义页面目录
 */
function deleteCustomPageDir(pageId) {
  const dir = customPageDir(pageId);
  if (fs.existsSync(dir)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
}

/**
 * 递归复制目录
 */
function copyDirSync(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirSync(srcPath, destPath);
    else fs.copyFileSync(srcPath, destPath);
  }
}

/**
 * 检查文件扩展名是否允许
 */
function isAllowedExtension(filename) {
  const ext = path.extname(filename).toLowerCase();
  return ALLOWED_EXTENSIONS.has(ext);
}

module.exports = {
  customPageDir,
  ensureCustomPageDir,
  deleteCustomPageDir,
  copyDirSync,
  isAllowedExtension,
};
