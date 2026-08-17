const fs = require('fs');
const EventEmitter = require('events');
const { DATA_DIR, DATA_FILE, DEFAULT_PAGES } = require('../config');
const { normalizeAuth } = require('../utils/validators');

const events = new EventEmitter();
let cache = null;

/**
 * 确保数据目录和文件存在
 */
function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(DEFAULT_PAGES, null, 2), 'utf8');
  }
}

/**
 * 读取全部页面配置（带内存缓存）
 * 兼容旧数据：没有 type 字段的一律视为外部链接页面；auth 在读入时规范化
 */
function read() {
  if (cache) return cache;
  ensureDataFile();
  try {
    const pages = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    cache = pages.map(p => {
      const page = { type: 'link', ...p };
      if (page.auth) {
        const normalized = normalizeAuth(page.auth);
        if (normalized !== undefined) page.auth = normalized;
      }
      return page;
    });
    return cache;
  } catch (err) {
    console.error('读取配置失败，返回默认配置:', err.message);
    return DEFAULT_PAGES;
  }
}

/**
 * 写入全部页面配置（同步更新缓存 + 触发事件）
 */
function write(pages) {
  ensureDataFile();
  fs.writeFileSync(DATA_FILE, JSON.stringify(pages, null, 2), 'utf8');
  cache = pages;
  events.emit('pages:changed');
}

/**
 * 清除缓存（强制下次从磁盘读取）
 */
function invalidate() {
  cache = null;
}

module.exports = { read, write, invalidate, events };
