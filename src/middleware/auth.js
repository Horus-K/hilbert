const jwt = require('jsonwebtoken');
const {
  GOOGLE_CONFIG,
  isDebugModeEnabled,
  getDebugUser,
  issueMainSession
} = require('../services/auth.service');
const sessionRegistry = require('../services/session-registry.service');

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

function readToken(req) {
  const match = String(req.headers.cookie || '').match(/(?:^|;\s*)hilbert_token=([^;]+)/);
  if (!match) return '';
  try { return decodeURIComponent(match[1]); } catch { return ''; }
}

function rejectUnauthorized(req, res) {
  res.clearCookie('hilbert_token', { path: '/' });
  if (req.path.startsWith('/hilbert-api/')) return res.status(401).json({ error: 'Unauthorized' });
  return res.redirect('/login.html');
}

function auth(req, res, next) {
  if (PUBLIC_PATHS.has(req.path)) return next();

  const token = readToken(req);
  let decoded = null;
  if (token) {
    try { decoded = jwt.verify(token, GOOGLE_CONFIG.jwt_secret); } catch { decoded = null; }
  }

  if (isDebugModeEnabled()) {
    const debugUser = getDebugUser();
    if (decoded && decoded.sid && decoded.email === debugUser.email && sessionRegistry.isActive(decoded.sid)) {
      sessionRegistry.touch(decoded.sid);
      req.user = { ...debugUser, sid: decoded.sid, exp: decoded.exp };
      return next();
    }
    const issued = issueMainSession(debugUser, req);
    setAuthCookie(req, res, issued.token);
    req.user = {
      ...debugUser,
      sid: issued.session.id,
      exp: Math.floor(issued.session.expiresAt / 1000)
    };
    return next();
  }

  if (!decoded) return rejectUnauthorized(req, res);
  if (decoded.sid && !sessionRegistry.isActive(decoded.sid)) return rejectUnauthorized(req, res);

  // 兼容升级前签发的无 sid JWT：首次请求时换发可审计、可撤销的新会话。
  if (!decoded.sid) {
    const issued = issueMainSession(decoded, req, { expiresAt: Number(decoded.exp) * 1000 });
    setAuthCookie(req, res, issued.token);
    decoded = {
      ...decoded,
      sid: issued.session.id,
      exp: Math.floor(issued.session.expiresAt / 1000)
    };
  } else {
    sessionRegistry.touch(decoded.sid);
  }

  req.user = decoded;
  next();
}

module.exports = auth;
module.exports.readToken = readToken;
module.exports.setAuthCookie = setAuthCookie;
