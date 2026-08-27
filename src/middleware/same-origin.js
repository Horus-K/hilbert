const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function expectedOrigin(req) {
  const protocol = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  try {
    return new URL(`${protocol}://${host}`).origin;
  } catch {
    return '';
  }
}

/**
 * 独立 origin 阻止读取主站数据；本中间件同时阻止跨 origin 的状态修改（CSRF）。
 */
function sameOrigin(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  const origin = req.headers.origin;
  if (origin && origin !== expectedOrigin(req)) {
    return res.status(403).json({ error: 'Cross-origin request rejected' });
  }
  const fetchSite = req.headers['sec-fetch-site'];
  if (!origin && fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    return res.status(403).json({ error: 'Cross-origin request rejected' });
  }
  next();
}

module.exports = sameOrigin;
module.exports.expectedOrigin = expectedOrigin;
