const express = require('express');
const router = express.Router();
const requireAdmin = require('../middleware/require-admin');
const groupsService = require('../services/groups.service');

// 获取全部分组
router.get('/', (req, res) => {
  res.json(groupsService.getAll());
});

// 新增分组（仅超级管理员）
router.post('/', requireAdmin, (req, res) => {
  const name = ((req.body || {}).name || '').trim();
  const groups = groupsService.create(name);
  res.status(201).json(groups);
});

// 分组排序（仅超级管理员）—— 必须在 /:name 之前定义
router.put('/order', requireAdmin, (req, res) => {
  const order = (req.body || {}).order;
  const result = groupsService.reorder(order);
  res.json(result);
});

// 重命名分组（仅超级管理员）
router.put('/:id', requireAdmin, (req, res) => {
  const id = req.params.id;
  const newName = ((req.body || {}).name || '').trim();
  const groups = groupsService.rename(id, newName);
  res.json(groups);
});

// 删除分组（仅超级管理员）
router.delete('/:id', requireAdmin, (req, res) => {
  const groups = groupsService.remove(req.params.id);
  res.json(groups);
});

module.exports = router;
