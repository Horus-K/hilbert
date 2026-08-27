const fs = require('fs');
const path = require('path');
const { PAGE_DOCS_DIR, DOC_PREFIX } = require('../config');

/**
 * 判断是否为文档路径
 */
function isDocPath(value) {
  return typeof value === 'string' && value.startsWith(DOC_PREFIX);
}

/**
 * 获取文档文件实际路径
 */
function docFilePath(docPath) {
  return path.join(PAGE_DOCS_DIR, path.basename(docPath));
}

/**
 * 检查页面是否有文档
 */
function hasPageDoc(pageId) {
  if (!fs.existsSync(PAGE_DOCS_DIR)) return false;
  return fs.existsSync(path.join(PAGE_DOCS_DIR, pageId + '.md'));
}

/**
 * 读取页面文档内容
 */
function readPageDoc(pageId) {
  const filePath = path.join(PAGE_DOCS_DIR, pageId + '.md');
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, 'utf8');
}

/**
 * 写入页面文档，返回文档路径引用
 */
function writePageDoc(pageId, text) {
  if (!fs.existsSync(PAGE_DOCS_DIR)) {
    fs.mkdirSync(PAGE_DOCS_DIR, { recursive: true });
  }
  const fileName = pageId + '.md';
  fs.writeFileSync(path.join(PAGE_DOCS_DIR, fileName), text, 'utf8');
  return DOC_PREFIX + fileName;
}

/**
 * 删除页面文档
 */
function deletePageDoc(pageId) {
  const filePath = path.join(PAGE_DOCS_DIR, pageId + '.md');
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch { /* 忽略 */ }
}

/**
 * 解析页面：附加文档状态（hasDoc 字段）
 */
function resolvePageDoc(page) {
  const hasDoc = hasPageDoc(page.id);
  return { ...page, hasDoc };
}

module.exports = { isDocPath, docFilePath, hasPageDoc, readPageDoc, writePageDoc, deletePageDoc, resolvePageDoc };
