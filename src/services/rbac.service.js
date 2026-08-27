const crypto = require('crypto');
const { ADMIN_EMAILS, ALL_ACTIONS } = require('../config');
const { AppError } = require('../utils/errors');
const rolesRepo = require('../repositories/roles.repository');
const pagesRepo = require('../repositories/pages.repository');

const MAX_ROLE_NAME_LENGTH = 20;
const MAX_ROLE_DESCRIPTION_LENGTH = 60;
const EXACT_EMAIL_RE = /^[^\s@]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const DOMAIN_PATTERN_RE = /^\*@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

function isAdmin(email) {
  return ADMIN_EMAILS.includes((email || '').toLowerCase());
}

function emailMatchesPattern(email, pattern) {
  const e = (email || '').toLowerCase();
  const p = (pattern || '').toLowerCase();
  if (!p.includes('*')) return e === p;
  const regex = '^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$';
  return new RegExp(regex).test(e);
}

function normalizeRoleName(name) {
  const value = String(name || '').trim();
  if (!value) throw new AppError('角色名称不能为空');
  if (value.length > MAX_ROLE_NAME_LENGTH) {
    throw new AppError(`角色名称不能超过 ${MAX_ROLE_NAME_LENGTH} 个字符`);
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new AppError('角色名称包含非法控制字符');
  return value;
}

function normalizeRoleDescription(description) {
  const value = String(description || '').trim();
  if (value.length > MAX_ROLE_DESCRIPTION_LENGTH) {
    throw new AppError(`角色描述不能超过 ${MAX_ROLE_DESCRIPTION_LENGTH} 个字符`);
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new AppError('角色描述包含非法控制字符');
  return value;
}

/**
 * 合并相同 pageId 权限、去重 actions，并对 API 输入做严格校验。
 */
function normalizePermissions(permissions, options = {}) {
  const { strictPageIds = true } = options;
  if (!Array.isArray(permissions)) throw new AppError('权限列表格式错误');
  const validPageIds = new Set(pagesRepo.read().map(page => page.id));
  const permissionMap = new Map();

  for (const permission of permissions) {
    if (!permission || typeof permission !== 'object') throw new AppError('权限条目格式错误');
    const pageId = String(permission.pageId || '').trim();
    if (!pageId) throw new AppError('权限条目缺少页面 ID');
    if (strictPageIds && pageId !== '*' && !validPageIds.has(pageId)) {
      throw new AppError(`权限引用了不存在的页面: ${pageId}`);
    }
    if (!Array.isArray(permission.actions)) throw new AppError('权限动作格式错误');
    if (!permissionMap.has(pageId)) permissionMap.set(pageId, new Set());
    const actionSet = permissionMap.get(pageId);
    for (const action of permission.actions) {
      if (!ALL_ACTIONS.includes(action)) throw new AppError(`不支持的权限动作: ${action}`);
      if (action === 'create' && pageId !== '*') {
        throw new AppError('新增页面权限只能配置在全部页面上');
      }
      actionSet.add(action);
    }
  }

  const result = [];
  for (const [pageId, actionSet] of permissionMap) {
    const actions = ALL_ACTIONS.filter(action => actionSet.has(action));
    if (actions.length) result.push({ pageId, actions });
  }
  return result;
}

function canonicalizePermissions(permissions) {
  const permissionMap = new Map();
  for (const permission of (Array.isArray(permissions) ? permissions : [])) {
    if (!permission || typeof permission.pageId !== 'string' || !Array.isArray(permission.actions)) continue;
    const pageId = permission.pageId.trim();
    if (!pageId) continue;
    if (!permissionMap.has(pageId)) permissionMap.set(pageId, new Set());
    const actions = permissionMap.get(pageId);
    for (const action of permission.actions) {
      if (!ALL_ACTIONS.includes(action)) continue;
      if (action === 'create' && pageId !== '*') continue;
      actions.add(action);
    }
  }
  return [...permissionMap].map(([pageId, actions]) => ({
    pageId,
    actions: ALL_ACTIONS.filter(action => actions.has(action))
  })).filter(permission => permission.actions.length);
}

function canonicalizeStoredRoles(data) {
  let changed = false;
  const roles = data.roles.map(role => {
    const permissions = canonicalizePermissions(role.permissions);
    if (JSON.stringify(permissions) !== JSON.stringify(role.permissions || [])) changed = true;
    return { ...role, permissions };
  });
  if (changed) {
    const next = { ...data, roles };
    rolesRepo.write(next);
    return next;
  }
  return data;
}

function getRoles() {
  return canonicalizeStoredRoles(rolesRepo.read()).roles;
}

function createRole(input) {
  const data = canonicalizeStoredRoles(rolesRepo.read());
  const name = normalizeRoleName(input && input.name);
  if (data.roles.some(role => role.name.trim().toLowerCase() === name.toLowerCase())) {
    throw new AppError('角色名称已存在');
  }
  const role = {
    id: crypto.randomUUID(),
    name,
    description: normalizeRoleDescription(input && input.description),
    permissions: normalizePermissions((input && input.permissions) || [])
  };
  rolesRepo.write({ ...data, roles: [...data.roles, role] });
  return role;
}

function updateRole(id, input) {
  const data = canonicalizeStoredRoles(rolesRepo.read());
  const idx = data.roles.findIndex(role => role.id === id);
  if (idx === -1) throw new AppError('角色不存在', 404);
  const current = data.roles[idx];
  const next = { ...current };

  if (input && input.name !== undefined) {
    const name = normalizeRoleName(input.name);
    if (data.roles.some(role => role.id !== id && role.name.trim().toLowerCase() === name.toLowerCase())) {
      throw new AppError('角色名称已存在');
    }
    next.name = name;
  }
  if (input && input.description !== undefined) {
    next.description = normalizeRoleDescription(input.description);
  }
  if (input && input.permissions !== undefined) {
    next.permissions = normalizePermissions(input.permissions);
  }

  const roles = [...data.roles];
  roles[idx] = next;
  rolesRepo.write({ ...data, roles });
  return next;
}

function deleteRole(id) {
  const data = rolesRepo.read();
  if (!data.roles.some(role => role.id === id)) throw new AppError('角色不存在', 404);
  rolesRepo.write({
    roles: data.roles.filter(role => role.id !== id),
    assignments: data.assignments.filter(assignment => assignment.roleId !== id)
  });
  return { deleted: id };
}

function getAssignments() {
  return rolesRepo.read().assignments;
}

function normalizeAssignmentEmail(email) {
  const value = String(email || '').trim().toLowerCase();
  if (!value) throw new AppError('邮箱不能为空');
  if (!(value.includes('*') ? DOMAIN_PATTERN_RE.test(value) : EXACT_EMAIL_RE.test(value))) {
    throw new AppError('邮箱格式不正确，通配格式仅支持 *@domain.com');
  }
  return value;
}

function createAssignment(input) {
  const data = rolesRepo.read();
  const roleId = input && input.roleId;
  if (!roleId) throw new AppError('角色不能为空');
  if (!data.roles.some(role => role.id === roleId)) throw new AppError('角色不存在', 404);
  const email = normalizeAssignmentEmail(input && input.email);
  if (data.assignments.some(item => item.email.toLowerCase() === email && item.roleId === roleId)) {
    throw new AppError('该邮箱已分配此角色');
  }
  const assignment = { email, roleId };
  rolesRepo.write({ ...data, assignments: [...data.assignments, assignment] });
  return assignment;
}

function deleteAssignment(email, roleId) {
  const data = rolesRepo.read();
  const normalizedEmail = String(email || '').toLowerCase();
  const assignments = data.assignments.filter(
    assignment => !(assignment.email.toLowerCase() === normalizedEmail && assignment.roleId === roleId)
  );
  if (assignments.length === data.assignments.length) throw new AppError('分配关系不存在', 404);
  rolesRepo.write({ ...data, assignments });
  return { deleted: true };
}

function removePagePermissionsFromData(data, pageId) {
  let changed = false;
  const roles = data.roles.map(role => {
    const currentPermissions = Array.isArray(role.permissions) ? role.permissions : [];
    const permissions = currentPermissions.filter(permission => permission.pageId !== pageId);
    if (permissions.length === currentPermissions.length) return role;
    changed = true;
    return { ...role, permissions };
  });
  return { changed, data: changed ? { ...data, roles } : data };
}

function removePagePermissions(pageId) {
  const result = removePagePermissionsFromData(rolesRepo.read(), pageId);
  if (result.changed) rolesRepo.write(result.data);
  return result.changed;
}

function getUserPermissions(email) {
  if (isAdmin(email)) return [{ pageId: '*', actions: [...ALL_ACTIONS] }];
  const data = rolesRepo.read();
  const userEmail = (email || '').toLowerCase();
  const userAssignments = data.assignments.filter(assignment => emailMatchesPattern(userEmail, assignment.email));
  const permMap = new Map();
  for (const assignment of userAssignments) {
    const role = data.roles.find(candidate => candidate.id === assignment.roleId);
    if (!role || !Array.isArray(role.permissions)) continue;
    for (const permission of role.permissions) {
      if (!permMap.has(permission.pageId)) permMap.set(permission.pageId, new Set());
      const actions = permMap.get(permission.pageId);
      for (const action of (permission.actions || [])) {
        if (ALL_ACTIONS.includes(action)) actions.add(action);
      }
    }
  }
  return [...permMap].map(([pageId, actions]) => ({ pageId, actions: [...actions] }));
}

function hasPermission(email, pageId, action) {
  if (isAdmin(email)) return true;
  return getUserPermissions(email).some(permission =>
    (permission.pageId === '*' || permission.pageId === pageId) && permission.actions.includes(action)
  );
}

module.exports = {
  createAssignment,
  createRole,
  deleteAssignment,
  deleteRole,
  emailMatchesPattern,
  getAssignments,
  getRoles,
  getUserPermissions,
  hasPermission,
  isAdmin,
  normalizeAssignmentEmail,
  normalizePermissions,
  removePagePermissions,
  removePagePermissionsFromData,
  updateRole
};
