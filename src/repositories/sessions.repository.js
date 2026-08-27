const fs = require('fs');
const { DATA_DIR, SESSIONS_FILE } = require('../config');
const { atomicWriteJson, readJsonFile } = require('../utils/json-file');

let cache = null;

function validData(value) {
  return value && typeof value === 'object' && Array.isArray(value.sessions);
}

function ensureFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(SESSIONS_FILE) && !fs.existsSync(SESSIONS_FILE + '.bak')) {
    atomicWriteJson(SESSIONS_FILE, { version: 1, sessions: [] }, { backup: false });
  }
}

function read() {
  if (cache) return cache;
  ensureFile();
  try {
    cache = readJsonFile(SESSIONS_FILE, { validate: validData });
    return cache;
  } catch (error) {
    console.error('读取会话注册表失败:', error.message);
    return { version: 1, sessions: [] };
  }
}

function write(data) {
  ensureFile();
  atomicWriteJson(SESSIONS_FILE, data);
  cache = data;
}

function invalidate() {
  cache = null;
}

module.exports = { invalidate, read, write };
