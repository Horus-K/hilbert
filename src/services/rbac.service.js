const { ADMIN_EMAILS, ALL_ACTIONS } = require('../config');
const rolesRepo = require('../repositories/roles.repository');

/**
 * 判断是否为超级管理员
 */
function isAdmin(email) {
  return ADMIN_EMAILS.includes((email || '').toLowerCase());
}

/**
 * 邮箱通配符匹配：支持 *@domain.com 等通配模式
 */
function emailMatchesPattern(email, pattern) {
  const e = (email || '').toLowerCase();
  const p = (pattern || '').toLowerCase();
  if (!p.includes('*')) return e === p;
  const regex = '^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$';
  return new RegExp(regex).test(e);
}

/**
 * 获取用户的所有权限（聚合其所有角色的 permissions）
 */
function getUserPermissions(email) {
  if (isAdmin(email)) {
    return [{ pageId: '*', actions: [...ALL_ACTIONS] }];
  }
  const data = rolesRepo.read();
  const userEmail = (email || '').toLowerCase();
  const userAssignments = data.assignments.filter(a => emailMatchesPattern(userEmail, a.email));
  const permMap = new Map();
  for (const assignment of userAssignments) {
    const role = data.roles.find(r => r.id === assignment.roleId);
    if (!role || !Array.isArray(role.permissions)) continue;
    for (const perm of role.permissions) {
      if (!permMap.has(perm.pageId)) permMap.set(perm.pageId, new Set());
      const actions = permMap.get(perm.pageId);
      for (const a of (perm.actions || [])) actions.add(a);
    }
  }
  const result = [];
  for (const [pageId, actions] of permMap) {
    result.push({ pageId, actions: [...actions] });
  }
  return result;
}

/**
 * 检查用户是否对指定页面有指定操作权限
 */
function hasPermission(email, pageId, action) {
  if (isAdmin(email)) return true;
  const perms = getUserPermissions(email);
  for (const p of perms) {
    if (p.pageId === '*' || p.pageId === pageId) {
      if (p.actions.includes(action)) return true;
    }
  }
  return false;
}

module.exports = { isAdmin, emailMatchesPattern, getUserPermissions, hasPermission };
