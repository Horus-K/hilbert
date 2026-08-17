const fs = require('fs');
const path = require('path');
const { FAVORITES_DIR } = require('../config');

/**
 * 获取用户收藏文件路径（邮箱安全化后作为文件名）
 */
function favoritesFile(email) {
  return path.join(FAVORITES_DIR, email.replace(/[^a-zA-Z0-9@._-]/g, '_') + '.json');
}

/**
 * 读取用户收藏列表
 */
function read(email) {
  const file = favoritesFile(email);
  if (!fs.existsSync(file)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch { return []; }
}

/**
 * 写入用户收藏列表
 */
function write(email, list) {
  if (!fs.existsSync(FAVORITES_DIR)) fs.mkdirSync(FAVORITES_DIR, { recursive: true });
  fs.writeFileSync(favoritesFile(email), JSON.stringify(list, null, 2), 'utf8');
}

module.exports = { read, write };
