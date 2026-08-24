const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { ProxyAgent, fetch: proxyFetch } = require('undici');
const config = require('../config');

const GOOGLE_CONFIG = config.google;
const DEBUG_CONFIG = config.debug || { enabled: false, user: {} };

// Google API 出站代理 dispatcher（国内服务器换取 token / 获取用户信息时需走代理）
const googleApiDispatcher = GOOGLE_CONFIG.api_proxy
  ? new ProxyAgent(GOOGLE_CONFIG.api_proxy)
  : undefined;

// ---------- State 令牌（防 CSRF） ----------

/**
 * 生成签名 state 令牌：随机 nonce + 时间戳 → HMAC 签名 → 拼接
 */
function generateStateToken() {
  const nonce = crypto.randomBytes(16).toString('hex');
  const ts = Date.now().toString(36);
  const payload = nonce + '.' + ts;
  const sig = crypto.createHmac('sha256', GOOGLE_CONFIG.jwt_secret).update(payload).digest('hex');
  return payload + '.' + sig;
}

/**
 * 校验 state 令牌签名 + 有效期（10 分钟）
 */
function verifyStateToken(state) {
  if (!state || typeof state !== 'string') return false;
  const parts = state.split('.');
  if (parts.length !== 3) return false;
  const [nonce, tsHex, sig] = parts;
  const payload = nonce + '.' + tsHex;
  const expected = crypto.createHmac('sha256', GOOGLE_CONFIG.jwt_secret).update(payload).digest('hex');
  if (sig !== expected) return false;
  const ts = parseInt(tsHex, 36);
  if (isNaN(ts) || Date.now() - ts > 10 * 60 * 1000) return false;
  return true;
}

/**
 * 构建 Google OAuth2 授权 URL
 */
function buildAuthUrl(state) {
  const params = new URLSearchParams({
    client_id: GOOGLE_CONFIG.client_id,
    redirect_uri: GOOGLE_CONFIG.oauth2_redirect_uri,
    response_type: GOOGLE_CONFIG.oauth2_response_type,
    scope: GOOGLE_CONFIG.oauth2_scope,
    access_type: GOOGLE_CONFIG.oauth2_access_type,
    include_granted_scopes: String(GOOGLE_CONFIG.oauth2_include_granted_scopes),
    state
  });
  return GOOGLE_CONFIG.oauth2_url + '?' + params.toString();
}

/**
 * 用 authorization code 换取 access_token
 */
async function exchangeCodeForToken(code) {
  const tokenRes = await proxyFetch(GOOGLE_CONFIG.token_url, {
    method: 'POST',
    dispatcher: googleApiDispatcher,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: GOOGLE_CONFIG.client_id,
      client_secret: GOOGLE_CONFIG.client_secret,
      redirect_uri: GOOGLE_CONFIG.oauth2_redirect_uri,
      grant_type: 'authorization_code'
    }).toString()
  });

  if (!tokenRes.ok) {
    const errText = await tokenRes.text();
    console.error('Token exchange failed:', errText);
    throw new Error('Failed to exchange authorization code');
  }

  return tokenRes.json();
}

/**
 * 用 access_token 获取 Google 用户信息
 */
async function fetchUserInfo(accessToken) {
  const userRes = await proxyFetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    dispatcher: googleApiDispatcher,
    headers: { Authorization: 'Bearer ' + accessToken }
  });

  if (!userRes.ok) {
    throw new Error('Failed to fetch user info');
  }

  return userRes.json();
}

/**
 * 登录权限校验：先检查邮箱白名单，再检查域名白名单
 * 返回 null 表示通过，返回字符串表示拒绝原因
 */
function checkLoginPermission(userEmail) {
  const email = (userEmail || '').toLowerCase();
  const allowedEmails = (GOOGLE_CONFIG.allowed_emails || '')
    .split(',')
    .map(e => e.trim().toLowerCase())
    .filter(Boolean);
  const allowedDomain = (GOOGLE_CONFIG.allowed_domain || '').trim().toLowerCase();

  if (allowedEmails.length > 0) {
    if (!allowedEmails.includes(email)) {
      return '您的账号 (' + userEmail + ') 未被授权登录';
    }
  } else if (allowedDomain) {
    if (!email.endsWith('@' + allowedDomain)) {
      return '仅允许 @' + allowedDomain + ' 域名下的账号登录';
    }
  }
  return null;
}

/**
 * 签发 JWT 令牌
 */
function signJwt(user) {
  const payload = {
    sub: user.id,
    email: user.email,
    name: user.name,
    displayName: user.displayName || user.name || user.email,
    groups: Array.isArray(user.groups) ? user.groups : (user.groups ? [user.groups] : []),
    picture: user.picture
  };
  // Google userinfo 的原始资料仅写入签名 JWT，按页面配置决定是否继续透传给下游。
  if (user && user.id) payload.googleAuth = user.googleAuth || user;
  if (user && user.googleAccessToken) {
    payload.googleAccessToken = user.googleAccessToken;
    payload.googleAccessTokenExpiresAt = user.googleAccessTokenExpiresAt || null;
  }
  return jwt.sign(payload, GOOGLE_CONFIG.jwt_secret, {
    expiresIn: GOOGLE_CONFIG.jwt_expire_hours + 'h'
  });
}

function isDebugModeEnabled() {
  return !!(DEBUG_CONFIG.enabled && DEBUG_CONFIG.user && DEBUG_CONFIG.user.email);
}

function getDebugUser() {
  if (!isDebugModeEnabled()) return null;
  const user = {
    id: DEBUG_CONFIG.user.id || 'debug-user',
    email: DEBUG_CONFIG.user.email,
    name: DEBUG_CONFIG.user.name || DEBUG_CONFIG.user.displayName || DEBUG_CONFIG.user.email,
    displayName: DEBUG_CONFIG.user.displayName || DEBUG_CONFIG.user.name || DEBUG_CONFIG.user.email,
    groups: Array.isArray(DEBUG_CONFIG.user.groups) ? DEBUG_CONFIG.user.groups : [],
    picture: DEBUG_CONFIG.user.picture || null
  };
  user.googleAuth = {
    id: user.id,
    email: user.email,
    name: user.name,
    picture: user.picture
  };
  return user;
}

module.exports = {
  generateStateToken,
  verifyStateToken,
  buildAuthUrl,
  exchangeCodeForToken,
  fetchUserInfo,
  checkLoginPermission,
  signJwt,
  isDebugModeEnabled,
  getDebugUser,
  GOOGLE_CONFIG,
  DEBUG_CONFIG,
};
