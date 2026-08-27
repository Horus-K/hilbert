const fs = require('fs');
const EventEmitter = require('events');
const { DATA_DIR, DATA_FILE, DEFAULT_PAGES, external_proxy: externalProxyConfig } = require('../config');
const { normalizeAuth } = require('../utils/validators');
const { atomicWriteJson, readJsonFile } = require('../utils/json-file');
const {
  decryptPageSecrets,
  encryptPageSecrets,
  hasPlaintextPageSecrets,
  needsPageSecretMigration
} = require('../utils/page-secret-store');

const events = new EventEmitter();
let cache = null;

function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE) && !fs.existsSync(DATA_FILE + '.bak')) {
    atomicWriteJson(DATA_FILE, DEFAULT_PAGES, { backup: false });
  }
}

function migrateSecretsIfNeeded(rawPages, plainPages) {
  if (needsPageSecretMigration(rawPages)) {
    atomicWriteJson(DATA_FILE, encryptPageSecrets(plainPages), { backup: false });
    console.warn('页面认证 Secret 已迁移为静态加密格式');
  }

  const backupPath = DATA_FILE + '.bak';
  if (!fs.existsSync(backupPath)) return;
  try {
    const rawBackup = readJsonFile(backupPath, { validate: Array.isArray });
    if (needsPageSecretMigration(rawBackup)) {
      const plainBackup = decryptPageSecrets(rawBackup);
      atomicWriteJson(backupPath, encryptPageSecrets(plainBackup), { backup: false });
    }
  } catch (error) {
    if (error.code && error.code.startsWith('SECRET_')) throw error;
    console.error('页面配置备份 Secret 迁移失败:', error.message);
  }
}

/**
 * 运行时缓存始终是解密后的对象，磁盘 pages.json 和 .bak 始终写入密文。
 */
function read() {
  if (cache) return cache;
  ensureDataFile();
  try {
    const rawPages = readJsonFile(DATA_FILE, { validate: Array.isArray });
    const plainPages = decryptPageSecrets(rawPages);
    migrateSecretsIfNeeded(rawPages, plainPages);
    cache = plainPages.map(p => {
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
    if (err.code && err.code.startsWith('SECRET_')) throw err;
    console.error('读取页面配置失败，返回默认配置:', err.message);
    return DEFAULT_PAGES;
  }
}

function write(pages) {
  ensureDataFile();
  atomicWriteJson(DATA_FILE, encryptPageSecrets(pages));
  cache = pages;
  events.emit('pages:changed');
}

function invalidate() {
  cache = null;
}

module.exports = { read, write, invalidate, events };
