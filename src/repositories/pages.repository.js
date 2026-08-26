const fs = require('fs');
const EventEmitter = require('events');
const { DATA_DIR, DATA_FILE, DEFAULT_PAGES, external_proxy: externalProxyConfig } = require('../config');
const { normalizeAuth } = require('../utils/validators');
const { atomicWriteJson, readJsonFile } = require('../utils/json-file');

const events = new EventEmitter();
let cache = null;

function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE) && !fs.existsSync(DATA_FILE + '.bak')) {
    atomicWriteJson(DATA_FILE, DEFAULT_PAGES, { backup: false });
  }
}

/**
 * 读取全部页面配置（带内存缓存）。主文件损坏时自动从 .bak 恢复。
 */
function read() {
  if (cache) return cache;
  ensureDataFile();
  try {
    const pages = readJsonFile(DATA_FILE, { validate: Array.isArray });
    cache = pages.map(p => {
      const page = { type: 'link', ...p };
      if (page.type === 'link') {
        page.proxyMode = externalProxyConfig.public_host_template ? 'host' : 'mount';
        if (externalProxyConfig.public_host_template) delete page.mountPath;
      }
      if (page.auth) {
        const normalized = normalizeAuth(page.auth);
        if (normalized !== undefined) page.auth = normalized;
      }
      return page;
    });
    return cache;
  } catch (err) {
    console.error('读取页面配置失败，返回默认配置:', err.message);
    return DEFAULT_PAGES;
  }
}

function write(pages) {
  ensureDataFile();
  atomicWriteJson(DATA_FILE, pages);
  cache = pages;
  events.emit('pages:changed');
}

function invalidate() {
  cache = null;
}

module.exports = { read, write, invalidate, events };
