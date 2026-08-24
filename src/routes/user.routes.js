const express = require('express');
const router = express.Router();
const { isAdmin, getUserPermissions } = require('../services/rbac.service');
const { isDebugModeEnabled } = require('../services/auth.service');

// 当前登录用户信息
// 挂载于 /hilbert-api → 实际路径 /hilbert-api/me
router.get('/me', (req, res) => {
  res.json({
    name: req.user.name || req.user.email,
    displayName: req.user.displayName || req.user.name || req.user.email,
    email: req.user.email,
    groups: Array.isArray(req.user.groups) ? req.user.groups : (req.user.groups ? [req.user.groups] : []),
    picture: req.user.picture || null,
    isAdmin: isAdmin(req.user.email),
    authMode: isDebugModeEnabled() ? 'debug' : 'google'
  });
});

// 当前用户权限查询
// 挂载于 /hilbert-api → 实际路径 /hilbert-api/my-permissions
router.get('/my-permissions', (req, res) => {
  const email = req.user.email;
  res.json({
    isAdmin: isAdmin(email),
    permissions: getUserPermissions(email)
  });
});

// 登出
// 挂载于 /hilbert-api → 实际路径 /hilbert-api/logout
router.post('/logout', (req, res) => {
  res.clearCookie('hilbert_token', { path: '/' });
  res.json({ ok: true });
});

module.exports = router;
