const express = require('express');
const router = express.Router();
const authService = require('../services/auth.service');

// 登录入口：生成 state + 重定向 Google OAuth2
// 挂载于 /auth → 实际路径 /auth/google
router.get('/google', (req, res) => {
  if (authService.isDebugModeEnabled()) {
    return res.redirect('/auth/debug');
  }
  const state = authService.generateStateToken();
  res.redirect(authService.buildAuthUrl(state));
});

router.get('/debug', (req, res) => {
  if (!authService.isDebugModeEnabled()) {
    return res.status(404).send('Debug mode is disabled');
  }

  const user = authService.getDebugUser();
  const token = authService.signJwt(user);
  const isSecure = (req.headers['x-forwarded-proto'] || 'http') === 'https';
  res.cookie('hilbert_token', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isSecure,
    path: '/',
    maxAge: authService.GOOGLE_CONFIG.jwt_expire_hours * 60 * 60 * 1000
  });
  return res.redirect('/');
});

router.get('/config', (req, res) => {
  const user = authService.getDebugUser();
  res.json({
    debugMode: authService.isDebugModeEnabled(),
    debugUser: user ? {
      email: user.email,
      name: user.name,
      displayName: user.displayName,
      groups: user.groups,
      picture: user.picture
    } : null
  });
});

module.exports = router;
