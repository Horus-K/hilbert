const express = require('express');
const router = express.Router();
const path = require('path');

/**
 * GET /page/:id — 独立页面 URL（返回 SPA，由客户端根据 URL 加载对应页面）
 * 每个页面拥有独立浏览器地址，刷新或直接访问均可直达
 */
router.get('/:id', (req, res) => {
  res.sendFile(path.join(__dirname, '../../public/index.html'));
});

module.exports = router;
