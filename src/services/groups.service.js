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
  const expected = new Set(groups.map(group => group.id));
  if (!order.every(id => typeof id === 'string' && expected.has(id))) {
    throw new AppError('分组列表不匹配');
  }
  const byId = new Map(groups.map(group => [group.id, group]));
  return order.map(id => byId.get(id));
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
  if (groups.some(group => groupKey(group.name) === groupKey(normalizedName))) {
    throw new AppError('分组已存在');
  }
  const next = [...groups, { id: require('crypto').randomUUID(), name: normalizedName }];
  groupsRepo.write(next);
  return next;
}

function reorder(order) {
  const groups = groupsRepo.read();
  const next = validateGroupOrder(order, groups);
  groupsRepo.write(next);
  return next;
}

function rename(id, newName) {
  const normalizedName = normalizeGroupName(newName);
  const groups = groupsRepo.read();
  const idx = groups.findIndex(group => group.id === id);
  if (idx === -1) throw new AppError('分组不存在', 404);
  if (groups.some((group, index) => index !== idx && groupKey(group.name) === groupKey(normalizedName))) {
    throw new AppError('分组名称已存在');
  }

  const nextGroups = [...groups];
  nextGroups[idx] = { ...nextGroups[idx], name: normalizedName };
  groupsRepo.write(nextGroups);
  return nextGroups;
}

function remove(id) {
  const groups = groupsRepo.read();
  const idx = groups.findIndex(group => group.id === id);
  if (idx === -1) throw new AppError('分组不存在', 404);

  const nextGroups = groups.filter(group => group.id !== id);
  const pages = pagesRepo.read();
  const nextPages = pages.map(page => page.groupId === id ? { ...page, groupId: null } : page);

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
