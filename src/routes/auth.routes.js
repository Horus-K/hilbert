const express = require('express');
const router = express.Router();
const authService = require('../services/auth.service');

// 登录入口：生成 state + 重定向 Google OAuth2
// 挂载于 /auth → 实际路径 /auth/google
router.get('/google', (req, res) => {
  const state = authService.generateStateToken();
  res.redirect(authService.buildAuthUrl(state));
});

module.exports = router;
