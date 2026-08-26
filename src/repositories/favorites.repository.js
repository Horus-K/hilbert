const fs = require('fs');
const path = require('path');
const { FAVORITES_DIR } = require('../config');
const { atomicWriteJson, readJsonFile } = require('../utils/json-file');

function favoritesFile(email) {
  return path.join(FAVORITES_DIR, email.replace(/[^a-zA-Z0-9@._-]/g, '_') + '.json');
}

function read(email) {
  const file = favoritesFile(email);
  if (!fs.existsSync(file) && !fs.existsSync(file + '.bak')) return [];
  try {
    return readJsonFile(file, { validate: Array.isArray });
  } catch (err) {
    console.error(`读取收藏配置失败 (${email}):`, err.message);
    return [];
  }
}

function write(email, list) {
  if (!fs.existsSync(FAVORITES_DIR)) fs.mkdirSync(FAVORITES_DIR, { recursive: true });
  atomicWriteJson(favoritesFile(email), list);
}

function removePageFromList(list, pageId) {
  return list.filter(id => id !== pageId);
}

function removePageFromAll(pageId) {
  if (!fs.existsSync(FAVORITES_DIR)) return 0;
  let changedFiles = 0;
  for (const entry of fs.readdirSync(FAVORITES_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const file = path.join(FAVORITES_DIR, entry.name);
    let list;
    try {
      list = readJsonFile(file, { validate: Array.isArray });
    } catch (err) {
      console.error(`清理收藏失败 (${entry.name}):`, err.message);
      continue;
    }
    const next = removePageFromList(list, pageId);
    if (next.length !== list.length) {
      atomicWriteJson(file, next);
      changedFiles += 1;
    }
  }
  return changedFiles;
}

module.exports = { read, write, removePageFromAll, removePageFromList };
