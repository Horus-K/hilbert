const fs = require('fs');
const { DATA_DIR, ROLES_FILE } = require('../config');
const { atomicWriteJson, readJsonFile } = require('../utils/json-file');

let cache = null;

function validRoleData(value) {
  return value && typeof value === 'object' &&
    Array.isArray(value.roles) && Array.isArray(value.assignments);
}

function ensureRolesFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(ROLES_FILE) && !fs.existsSync(ROLES_FILE + '.bak')) {
    atomicWriteJson(ROLES_FILE, { roles: [], assignments: [] }, { backup: false });
  }
}

function read() {
  if (cache) return cache;
  ensureRolesFile();
  try {
    cache = readJsonFile(ROLES_FILE, { validate: validRoleData });
    return cache;
  } catch (err) {
    console.error('读取角色配置失败:', err.message);
    return { roles: [], assignments: [] };
  }
}

function write(data) {
  ensureRolesFile();
  atomicWriteJson(ROLES_FILE, data);
  cache = data;
}

function invalidate() {
  cache = null;
}

module.exports = { read, write, invalidate };
