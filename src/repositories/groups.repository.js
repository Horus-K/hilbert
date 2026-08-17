const fs = require('fs');
const { DATA_DIR, GROUPS_FILE } = require('../config');
const pagesRepo = require('./pages.repository');

/**
 * 确保数据目录和分组文件存在
 */
function ensureGroupsFile() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(GROUPS_FILE)) {
    // 首次初始化：用现有页面已使用的分组作为种子
    const seeds = [...new Set(pagesRepo.read().map(p => p.group).filter(g => g && g !== '未分组'))];
    fs.writeFileSync(GROUPS_FILE, JSON.stringify(seeds, null, 2), 'utf8');
  }
}

/**
 * 读取全部分组
 */
function read() {
  ensureGroupsFile();
  try {
    const groups = JSON.parse(fs.readFileSync(GROUPS_FILE, 'utf8'));
    return Array.isArray(groups) ? groups : [];
  } catch {
    return [];
  }
}

/**
 * 写入全部分组
 */
function write(groups) {
  ensureGroupsFile();
  fs.writeFileSync(GROUPS_FILE, JSON.stringify(groups, null, 2), 'utf8');
}

module.exports = { read, write };
