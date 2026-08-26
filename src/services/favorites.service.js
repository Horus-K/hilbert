const { AppError } = require('../utils/errors');
const favoritesRepo = require('../repositories/favorites.repository');

/**
 * 获取用户收藏列表
 */
function getAll(email) {
  return favoritesRepo.read(email);
}

/**
 * 切换收藏状态（添加或移除）
 */
function toggle(email, pageId) {
  if (!pageId) throw new AppError('缺少页面 ID');
  const list = favoritesRepo.read(email);
  const idx = list.indexOf(pageId);
  if (idx >= 0) list.splice(idx, 1);
  else list.push(pageId);
  favoritesRepo.write(email, list);
  return list;
}

/**
 * 设置收藏列表（覆盖）
 */
function setAll(email, pageIds) {
  if (!Array.isArray(pageIds)) throw new AppError('参数格式错误');
  favoritesRepo.write(email, pageIds);
  return pageIds;
}

function removePageFromAll(pageId) {
  return favoritesRepo.removePageFromAll(pageId);
}

module.exports = { getAll, toggle, setAll, removePageFromAll };
