const express = require('express');
const router = express.Router();
const favoritesService = require('../services/favorites.service');

// 获取当前用户收藏列表
router.get('/', (req, res) => {
  res.json(favoritesService.getAll(req.user.email));
});

// 切换收藏状态
router.post('/toggle', (req, res) => {
  const { pageId } = req.body || {};
  const list = favoritesService.toggle(req.user.email, pageId);
  res.json(list);
});

// 设置收藏列表（覆盖）
router.put('/', (req, res) => {
  const { pageIds } = req.body || {};
  const list = favoritesService.setAll(req.user.email, pageIds);
  res.json(list);
});

module.exports = router;
