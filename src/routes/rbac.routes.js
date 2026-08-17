const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const requireAdmin = require('../middleware/require-admin');
const rolesRepo = require('../repositories/roles.repository');
const { ALL_ACTIONS } = require('../config');
const { AppError } = require('../utils/errors');

// 获取所有角色
router.get('/roles', requireAdmin, (req, res) => {
  const data = rolesRepo.read();
  res.json(data.roles);
});

// 创建角色
router.post('/roles', requireAdmin, (req, res) => {
  const { name, description, permissions } = req.body || {};
  if (!name || !name.trim()) throw new AppError('角色名称不能为空');

  const data = rolesRepo.read();
  if (data.roles.some(r => r.name.trim().toLowerCase() === name.trim().toLowerCase())) {
    throw new AppError('角色名称已存在');
  }

  const validPerms = [];
  if (Array.isArray(permissions)) {
    for (const p of permissions) {
      if (!p.pageId || !Array.isArray(p.actions)) continue;
      const validActions = p.actions.filter(a => ALL_ACTIONS.includes(a));
      if (validActions.length > 0) validPerms.push({ pageId: p.pageId, actions: validActions });
    }
  }

  const role = {
    id: crypto.randomUUID(),
    name: name.trim(),
    description: (description || '').trim(),
    permissions: validPerms
  };
  data.roles.push(role);
  rolesRepo.write(data);
  res.status(201).json(role);
});

// 更新角色
router.put('/roles/:id', requireAdmin, (req, res) => {
  const data = rolesRepo.read();
  const idx = data.roles.findIndex(r => r.id === req.params.id);
  if (idx === -1) throw new AppError('角色不存在', 404);

  const role = data.roles[idx];
  const { name, description, permissions } = req.body || {};

  if (name !== undefined) {
    if (!name.trim()) throw new AppError('角色名称不能为空');
    if (data.roles.some(r => r.id !== role.id && r.name.trim().toLowerCase() === name.trim().toLowerCase())) {
      throw new AppError('角色名称已存在');
    }
    role.name = name.trim();
  }
  if (description !== undefined) role.description = description.trim();
  if (permissions !== undefined && Array.isArray(permissions)) {
    const validPerms = [];
    for (const p of permissions) {
      if (!p.pageId || !Array.isArray(p.actions)) continue;
      const validActions = p.actions.filter(a => ALL_ACTIONS.includes(a));
      if (validActions.length > 0) validPerms.push({ pageId: p.pageId, actions: validActions });
    }
    role.permissions = validPerms;
  }

  data.roles[idx] = role;
  rolesRepo.write(data);
  res.json(role);
});

// 删除角色
router.delete('/roles/:id', requireAdmin, (req, res) => {
  const data = rolesRepo.read();
  const idx = data.roles.findIndex(r => r.id === req.params.id);
  if (idx === -1) throw new AppError('角色不存在', 404);

  data.roles.splice(idx, 1);
  data.assignments = data.assignments.filter(a => a.roleId !== req.params.id);
  rolesRepo.write(data);
  res.json({ deleted: req.params.id });
});

// 获取所有分配关系
router.get('/assignments', requireAdmin, (req, res) => {
  const data = rolesRepo.read();
  res.json(data.assignments);
});

// 为邮箱分配角色
router.post('/assignments', requireAdmin, (req, res) => {
  const { email, roleId } = req.body || {};
  if (!email || !email.trim()) throw new AppError('邮箱不能为空');
  if (!roleId) throw new AppError('角色不能为空');

  const data = rolesRepo.read();
  if (!data.roles.some(r => r.id === roleId)) throw new AppError('角色不存在', 404);

  const normalizedEmail = email.trim().toLowerCase();
  if (normalizedEmail.includes('*')) {
    if (!/^[^@]*\*[^@]*@.+$/.test(normalizedEmail)) {
      throw new AppError('通配符格式不正确，示例：*@domain.com');
    }
  }
  if (data.assignments.some(a => a.email.toLowerCase() === normalizedEmail && a.roleId === roleId)) {
    throw new AppError('该邮箱已分配此角色');
  }

  const assignment = { email: normalizedEmail, roleId };
  data.assignments.push(assignment);
  rolesRepo.write(data);
  res.status(201).json(assignment);
});

// 移除邮箱的角色绑定
router.delete('/assignments/:email/:roleId', requireAdmin, (req, res) => {
  const data = rolesRepo.read();
  const email = decodeURIComponent(req.params.email).toLowerCase();
  const roleId = req.params.roleId;
  const before = data.assignments.length;
  data.assignments = data.assignments.filter(
    a => !(a.email.toLowerCase() === email && a.roleId === roleId)
  );
  if (data.assignments.length === before) throw new AppError('分配关系不存在', 404);

  rolesRepo.write(data);
  res.json({ deleted: true });
});

module.exports = router;
