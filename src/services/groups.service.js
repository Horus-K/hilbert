const { AppError } = require('../utils/errors');
const groupsRepo = require('../repositories/groups.repository');
const pagesRepo = require('../repositories/pages.repository');

/**
 * 获取全部分组
 */
function getAll() {
  return groupsRepo.read();
}

/**
 * 新增分组
 */
function create(name) {
  if (!name || !name.trim()) throw new AppError('分组名称不能为空');
  if (name.trim() === '未分组') throw new AppError('不能使用保留分组名「未分组」');

  const groups = groupsRepo.read();
  if (groups.includes(name.trim())) throw new AppError('分组已存在');

  groups.push(name.trim());
  groupsRepo.write(groups);
  return groups;
}

/**
 * 分组排序
 */
function reorder(order) {
  if (!Array.isArray(order)) throw new AppError('参数格式错误');

  const groups = groupsRepo.read();
  if (order.length !== groups.length || !order.every(g => groups.includes(g))) {
    throw new AppError('分组列表不匹配');
  }

  groupsRepo.write(order);
  return order;
}

/**
 * 重命名分组（同步更新页面的 group 字段）
 */
function rename(oldName, newName) {
  if (!newName || !newName.trim()) throw new AppError('分组名称不能为空');
  if (newName.trim() === '未分组') throw new AppError('不能使用保留分组名「未分组」');

  const groups = groupsRepo.read();
  const idx = groups.indexOf(oldName);
  if (idx === -1) throw new AppError('分组不存在', 404);
  if (groups.includes(newName) && newName !== oldName) throw new AppError('分组名称已存在');

  groups[idx] = newName;
  groupsRepo.write(groups);

  // 同步更新页面的 group 字段
  const pages = pagesRepo.read();
  let changed = false;
  for (const p of pages) {
    if (p.group === oldName) {
      p.group = newName;
      changed = true;
    }
  }
  if (changed) pagesRepo.write(pages);

  return groups;
}

/**
 * 删除分组（该分组下的页面移至未分组）
 */
function remove(name) {
  const groups = groupsRepo.read();
  const idx = groups.indexOf(name);
  if (idx === -1) throw new AppError('分组不存在', 404);

  groups.splice(idx, 1);
  groupsRepo.write(groups);

  const pages = pagesRepo.read();
  let changed = false;
  for (const p of pages) {
    if (p.group === name) {
      p.group = '未分组';
      changed = true;
    }
  }
  if (changed) pagesRepo.write(pages);

  return groups;
}

module.exports = { getAll, create, reorder, rename, remove };
