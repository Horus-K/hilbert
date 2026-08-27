const fs = require('fs');
const crypto = require('crypto');
const { DATA_DIR, GROUPS_FILE } = require('../config');
const pagesRepo = require('./pages.repository');
const { atomicWriteJson, readJsonFile } = require('../utils/json-file');

function ensureGroupsFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(GROUPS_FILE) && !fs.existsSync(GROUPS_FILE + '.bak')) {
    const seeds = [...new Set(pagesRepo.read().map(p => p.group).filter(g => g && g !== '未分组'))]
      .map(name => ({ id: crypto.randomUUID(), name }));
    atomicWriteJson(GROUPS_FILE, seeds, { backup: false });
  }
}

function read() {
  ensureGroupsFile();
  try {
    const stored = readJsonFile(GROUPS_FILE, { validate: Array.isArray });
    const groups = stored.map(group => typeof group === 'string'
      ? { id: crypto.randomUUID(), name: group }
      : group);
    const idsByName = new Map(groups.map(group => [group.name, group.id]));
    const pages = pagesRepo.read();
    const migratedPages = pages.map(page => {
      if (page.groupId !== undefined) return page;
      const next = { ...page, groupId: idsByName.get(page.group) || null };
      delete next.group;
      return next;
    });
    if (migratedPages.some((page, index) => page !== pages[index])) pagesRepo.write(migratedPages);
    const groupsChanged = groups.some((group, index) => group !== stored[index]);
    if (groupsChanged) atomicWriteJson(GROUPS_FILE, groups, { backup: false });
    if (groupsChanged || migratedPages.some((page, index) => page !== pages[index])) {
      console.warn('分组与页面关联已迁移为稳定 groupId');
    }
    return groups;
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
