const jwt = require('jsonwebtoken');
const {
  GOOGLE_CONFIG,
  isDebugModeEnabled,
  getDebugUser,
  signJwt
} = require('../services/auth.service');

const PUBLIC_PATHS = new Set([
  '/auth/google',
  '/auth/debug',
  '/auth/config',
  '/callback',
  '/login.html',
  '/hilbert-api/health'
]);

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
  // 仅放行明确的公开入口，不能按扩展名放行任意业务资源。
  if (PUBLIC_PATHS.has(req.path)) {
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
