const fs = require('fs');
const { DATA_DIR, GROUPS_FILE } = require('../config');
const pagesRepo = require('./pages.repository');
const { atomicWriteJson, readJsonFile } = require('../utils/json-file');

function ensureGroupsFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(GROUPS_FILE) && !fs.existsSync(GROUPS_FILE + '.bak')) {
    const seeds = [...new Set(pagesRepo.read().map(p => p.group).filter(g => g && g !== '未分组'))];
    atomicWriteJson(GROUPS_FILE, seeds, { backup: false });
  }
}

function read() {
  ensureGroupsFile();
  try {
    return readJsonFile(GROUPS_FILE, { validate: Array.isArray });
  } catch (err) {
    console.error('读取分组配置失败:', err.message);
    return [];
  }
}

function write(groups) {
  ensureGroupsFile();
  atomicWriteJson(GROUPS_FILE, groups);
}

module.exports = { read, write };
