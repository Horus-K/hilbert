const path = require('path');
const jwt = require('jsonwebtoken');
const {
  GOOGLE_CONFIG,
  isDebugModeEnabled,
  getDebugUser,
  signJwt
} = require('../services/auth.service');

function setAuthCookie(req, res, token) {
  const isSecure = (req.headers['x-forwarded-proto'] || 'http') === 'https';
  res.cookie('hilbert_token', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isSecure,
    path: '/',
    maxAge: GOOGLE_CONFIG.jwt_expire_hours * 60 * 60 * 1000
  });
}

/**
 * 全局认证中间件：校验 Cookie 中的 JWT
 */
function auth(req, res, next) {
  // 白名单：静态资源
  const ext = path.extname(req.path);
  if (ext && /^\.(css|js|png|jpg|jpeg|gif|svg|ico|webp|woff|woff2|ttf|eot|otf|mp3|mp4|webm|ogg|wav|pdf|xml|json|map)$/.test(ext)) {
    return next();
  }

  // 白名单：认证相关路由及登录页
  if (req.path === '/auth/google' || req.path === '/auth/debug' || req.path === '/auth/config' || req.path === '/callback' || req.path === '/login.html') {
    return next();
  }

  // 白名单：健康检查
  if (req.path === '/hilbert-api/health') {
    return next();
  }

  // 调试模式以当前配置为准，不能让浏览器中旧 JWT 的用户信息覆盖它。
  if (isDebugModeEnabled()) {
    const user = getDebugUser();
    req.user = user;
    setAuthCookie(req, res, signJwt(user));
    return next();
  }

  // 校验 JWT
  const cookieHeader = req.headers.cookie || '';
  const tokenMatch = cookieHeader.match(/(?:^|;\s*)hilbert_token=([^;]+)/);
  const token = tokenMatch ? decodeURIComponent(tokenMatch[1]) : null;
  if (!token) {
    if (isDebugModeEnabled()) {
      if (req.path.startsWith('/hilbert-api/')) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      return res.redirect('/auth/debug');
    }
    if (req.path.startsWith('/hilbert-api/')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    return res.redirect('/login.html');
  }

  try {
    const decoded = jwt.verify(token, GOOGLE_CONFIG.jwt_secret);
    req.user = decoded;
    next();
  } catch (err) {
    res.clearCookie('hilbert_token', { path: '/' });
    if (isDebugModeEnabled() && !req.path.startsWith('/hilbert-api/')) {
      return res.redirect('/auth/debug');
    }
    if (req.path.startsWith('/hilbert-api/')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    return res.redirect('/login.html');
  }
}

module.exports = auth;
