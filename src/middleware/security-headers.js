/**
 * 安全响应头中间件
 */
function securityHeaders(req, res, next) {
  // 防 Clickjacking：登录页 DENY，其他页面 SAMEORIGIN
  res.setHeader('X-Frame-Options', req.path === '/login.html' ? 'DENY' : 'SAMEORIGIN');
  // 防 MIME 类型嗅探
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // XSS 过滤（旧浏览器兜底）
  res.setHeader('X-XSS-Protection', '1; mode=block');
  // Referer 策略
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  // 限制浏览器功能
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
}

module.exports = securityHeaders;
