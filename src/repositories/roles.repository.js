const fs = require('fs');
const { DATA_DIR, ROLES_FILE } = require('../config');

let cache = null;

/**
 * 确保数据目录和角色文件存在
 */
function ensureRolesFile() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(ROLES_FILE)) {
    fs.writeFileSync(ROLES_FILE, JSON.stringify({ roles: [], assignments: [] }, null, 2), 'utf8');
  }
}

/**
 * 读取角色与权限数据（带内存缓存）
 */
function read() {
  if (cache) return cache;
  ensureRolesFile();
  try {
    cache = JSON.parse(fs.readFileSync(ROLES_FILE, 'utf8'));
    if (!Array.isArray(cache.roles)) cache.roles = [];
    if (!Array.isArray(cache.assignments)) cache.assignments = [];
    return cache;
  } catch (err) {
    console.error('读取角色配置失败:', err.message);
    return { roles: [], assignments: [] };
  }
}

/**
 * 写入角色与权限数据
 */
function write(data) {
  ensureRolesFile();
  fs.writeFileSync(ROLES_FILE, JSON.stringify(data, null, 2), 'utf8');
  cache = data;
}

module.exports = { read, write };
