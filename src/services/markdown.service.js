const fs = require('fs');
const path = require('path');
const { DATA_DIR, PAGES_DIR, CONTENT_PREFIX } = require('../config');

/**
 * 判断是否为 Markdown 内容路径（/data/pages/xxx.md）
 */
function isContentPath(value) {
  return typeof value === 'string' && value.startsWith(CONTENT_PREFIX);
}

/**
 * content 路径 -> 实际文件路径（只取 basename，防止路径穿越）
 */
function mdFilePath(contentPath) {
  return path.join(PAGES_DIR, path.basename(contentPath));
}

/**
 * 写入 Markdown 文件，返回内容路径
 */
function writeMdFile(fileName, text) {
  if (!fs.existsSync(PAGES_DIR)) fs.mkdirSync(PAGES_DIR, { recursive: true });
  fs.writeFileSync(path.join(PAGES_DIR, fileName), text, 'utf8');
  return CONTENT_PREFIX + fileName;
}

/**
 * 删除 Markdown 文件
 */
function deleteMdFile(content) {
  if (!isContentPath(content)) return;
  try {
    fs.unlinkSync(mdFilePath(content));
  } catch { /* 文件已不存在则忽略 */ }
}

/**
 * 解析页面：将 Markdown 路径引用回填为实际文本
 */
function resolvePage(page) {
  if (page.type !== 'markdown' || !isContentPath(page.content)) return page;
  let text = '';
  try {
    text = fs.readFileSync(mdFilePath(page.content), 'utf8');
  } catch { /* 文件缺失时返回空内容 */ }
  return { ...page, contentPath: page.content, content: text };
}

/**
 * 启动时把旧版内联的 Markdown 内容迁移为独立文件
 */
function migrateInlineMarkdown() {
  const pagesRepo = require('../repositories/pages.repository');
  const pages = pagesRepo.read();
  let changed = false;
  for (const p of pages) {
    if (p.type === 'markdown' && p.content && !isContentPath(p.content)) {
      p.content = writeMdFile(p.id + '.md', p.content);
      changed = true;
    }
  }
  if (changed) pagesRepo.write(pages);
}

module.exports = { isContentPath, mdFilePath, writeMdFile, deleteMdFile, resolvePage, migrateInlineMarkdown };
