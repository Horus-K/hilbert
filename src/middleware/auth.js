const path = require('path');
const jwt = require('jsonwebtoken');
const { GOOGLE_CONFIG } = require('../services/auth.service');

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
  if (req.path === '/auth/google' || req.path === '/callback' || req.path === '/login.html') {
    return next();
  }

  // 白名单：健康检查
  if (req.path === '/hilbert-api/health') {
    return next();
  }

  // 校验 JWT
  const cookieHeader = req.headers.cookie || '';
  const tokenMatch = cookieHeader.match(/(?:^|;\s*)hilbert_token=([^;]+)/);
  const token = tokenMatch ? decodeURIComponent(tokenMatch[1]) : null;
  if (!token) {
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
    if (req.path.startsWith('/hilbert-api/')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    return res.redirect('/login.html');
  }
}

module.exports = auth;
