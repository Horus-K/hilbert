const { AppError } = require('../utils/errors');
const groupsRepo = require('../repositories/groups.repository');
const pagesRepo = require('../repositories/pages.repository');

const RESERVED_GROUP = '未分组';
const MAX_GROUP_NAME_LENGTH = 20;

function normalizeGroupName(name) {
  const value = String(name || '').trim().normalize('NFKC');
  if (!value) throw new AppError('分组名称不能为空');
  if (value.length > MAX_GROUP_NAME_LENGTH) {
    throw new AppError(`分组名称不能超过 ${MAX_GROUP_NAME_LENGTH} 个字符`);
  }
  if (/[\u0000-\u001f\u007f]/.test(value) || /[\/\\]/.test(value)) {
    throw new AppError('分组名称包含非法字符');
  }
  if (value === RESERVED_GROUP) throw new AppError(`不能使用保留分组名「${RESERVED_GROUP}」`);
  return value;
}

function groupKey(name) {
  return String(name).normalize('NFKC').toLocaleLowerCase('zh-CN');
}

function validateGroupOrder(order, groups) {
  if (!Array.isArray(order)) throw new AppError('参数格式错误');
  if (order.length !== groups.length || new Set(order).size !== order.length) {
    throw new AppError('分组列表不匹配或包含重复项');
  }
  const expected = new Set(groups);
  if (!order.every(group => typeof group === 'string' && expected.has(group))) {
    throw new AppError('分组列表不匹配');
  }
  return [...order];
}

function writeGroupsWithPageChanges(nextGroups, pages, nextPages) {
  const pagesChanged = nextPages.some((page, index) => page !== pages[index]);
  if (pagesChanged) pagesRepo.write(nextPages);
  try {
    groupsRepo.write(nextGroups);
  } catch (error) {
    if (pagesChanged) {
      try { pagesRepo.write(pages); } catch (rollbackError) {
        console.error('分组变更回滚页面数据失败:', rollbackError.message);
      }
    }
    throw error;
  }
}

function getAll() {
  return groupsRepo.read();
}

function create(name) {
  const normalizedName = normalizeGroupName(name);
  const groups = groupsRepo.read();
  if (groups.some(group => groupKey(group) === groupKey(normalizedName))) {
    throw new AppError('分组已存在');
  }
  const next = [...groups, normalizedName];
  groupsRepo.write(next);
  return next;
}

function reorder(order) {
  const groups = groupsRepo.read();
  const next = validateGroupOrder(order, groups);
  groupsRepo.write(next);
  return next;
}

function rename(oldName, newName) {
  const normalizedName = normalizeGroupName(newName);
  const groups = groupsRepo.read();
  const idx = groups.indexOf(oldName);
  if (idx === -1) throw new AppError('分组不存在', 404);
  if (groups.some((group, index) => index !== idx && groupKey(group) === groupKey(normalizedName))) {
    throw new AppError('分组名称已存在');
  }

  const nextGroups = [...groups];
  nextGroups[idx] = normalizedName;
  const pages = pagesRepo.read();
  const nextPages = pages.map(page => page.group === oldName ? { ...page, group: normalizedName } : page);

  writeGroupsWithPageChanges(nextGroups, pages, nextPages);
  return nextGroups;
}

function remove(name) {
  const groups = groupsRepo.read();
  const idx = groups.indexOf(name);
  if (idx === -1) throw new AppError('分组不存在', 404);

  const nextGroups = groups.filter(group => group !== name);
  const pages = pagesRepo.read();
  const nextPages = pages.map(page => page.group === name ? { ...page, group: RESERVED_GROUP } : page);

  writeGroupsWithPageChanges(nextGroups, pages, nextPages);
  return nextGroups;
}

module.exports = {
  RESERVED_GROUP,
  create,
  getAll,
  groupKey,
  normalizeGroupName,
  remove,
  rename,
  reorder,
  validateGroupOrder
};
