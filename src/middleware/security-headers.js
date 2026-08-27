/**
 * 安全响应头中间件
 */
function securityHeaders(req, res, next) {
  // 外部代理内容运行在隔离 origin，需要由主站 iframe 嵌入；主应用仍禁止跨 origin 嵌入。
  if (!req.app.get('external-proxy-app')) {
    res.setHeader('X-Frame-Options', req.path === '/login.html' ? 'DENY' : 'SAMEORIGIN');
  }
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
