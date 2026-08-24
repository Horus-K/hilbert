const express = require('express');
const router = express.Router();
const authService = require('../services/auth.service');

// Google 回调：校验 state → 换取 token → 获取用户信息 → 签发 JWT → 写入 Cookie
// 挂载于 / → 实际路径 /callback
router.get('/callback', async (req, res) => {
  try {
    const { code, state } = req.query;

    if (!authService.verifyStateToken(state)) {
      return res.status(403).send('Invalid state parameter');
    }
    if (!code) {
      return res.status(400).send('Authorization code missing');
    }

    const tokenData = await authService.exchangeCodeForToken(code);
    const user = await authService.fetchUserInfo(tokenData.access_token);
    user.googleAccessToken = tokenData.access_token;
    if (Number.isFinite(Number(tokenData.expires_in))) {
      user.googleAccessTokenExpiresAt = Date.now() + Number(tokenData.expires_in) * 1000;
    }

    // 登录权限校验
    const denyReason = authService.checkLoginPermission(user.email);
    if (denyReason) {
      console.warn('Login denied:', denyReason);
      return res.status(403).send(denyReason);
    }

    // 签发 JWT
    const token = authService.signJwt(user);

    // 写入 HttpOnly Cookie
    const isSecure = (req.headers['x-forwarded-proto'] || 'http') === 'https';
    res.cookie('hilbert_token', token, {
      httpOnly: true,
      secure: isSecure,
      sameSite: 'lax',
      path: '/',
      maxAge: authService.GOOGLE_CONFIG.jwt_expire_hours * 60 * 60 * 1000
    });

    res.redirect('/');
  } catch (err) {
    console.error('Callback error:', err);
    res.status(500).send('Authentication failed');
  }
});

module.exports = router;
