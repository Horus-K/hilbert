const http = require('http');
const https = require('https');
const { external_proxy: proxyConfig } = require('../../config');
const { applyDnsOverride, getPageRequestAgent } = require('./agents');
const { browserCookieHeader, clearCookieJar, getCookieHeader, storeResponseCookies, userKey } = require('./cookie-jar');
const { sanitizeGoogleAuth } = require('../utils/user-identity');
const { assertTargetAllowed } = require('./target-policy');

// login 模式的会话状态：页面与当前 Hilbert 用户相互隔离。
const loginSessions = new Map();
// oauth 模式的令牌缓存：pageId -> { token, expiresAt }
const tokenCache = new Map();

// Node.js 只接受 Latin-1 请求头值；姓名和分组中的中文需要编码后转发。
function toHeaderValue(value) {
  const text = String(value);
  return /[^\t\x20-\x7e\x80-\xff]/.test(text) ? encodeURIComponent(text) : text;
}

function getClaim(user, path) {
  return String(path).split('.').reduce((value, key) => value == null ? undefined : value[key], user);
}

function formatClaim(value, format) {
  if (format === 'csv' && Array.isArray(value)) return value.join(',');
  if (format === 'json') return JSON.stringify(value);
  if (format === 'base64url') {
    return Buffer.from(typeof value === 'string' ? value : JSON.stringify(value), 'utf8').toString('base64url');
  }
  return value;
}

/**
 * 执行一次声明式登录，并把目标会话 Cookie 写入当前页面/用户的服务端 Cookie jar。
 */
function resolveLoginUrl(page, base) {
  const loginPath = page.auth.loginPath;
  const baseDirectory = new URL(base.href);
  if (!baseDirectory.pathname.endsWith('/')) {
    baseDirectory.pathname = baseDirectory.pathname.slice(0, baseDirectory.pathname.lastIndexOf('/') + 1);
  }
  baseDirectory.search = '';
  baseDirectory.hash = '';
  return new URL(loginPath, baseDirectory);
}

function performLogin(page, base, user) {
  const logicalLoginUrl = resolveLoginUrl(page, base);
  if (logicalLoginUrl.origin !== base.origin) return Promise.reject(new Error('登录地址必须与目标页面同源'));
  return assertTargetAllowed(page, logicalLoginUrl).then(validatedAddresses => new Promise((resolve, reject) => {
    const auth = page.auth;
    const credentials = auth.params || {
      [auth.userField]: auth.username,
      [auth.passwordField]: auth.password,
      ...(auth.extraParams || {})
    };
    const body = auth.loginFormat === 'form'
      ? new URLSearchParams(credentials).toString()
      : JSON.stringify(credentials);
    const contentType = auth.loginFormat === 'form'
      ? 'application/x-www-form-urlencoded'
      : 'application/json';
    const loginOpts = {
      method: 'POST',
      headers: {
        'Content-Type': contentType,
        'Content-Length': Buffer.byteLength(body),
        'Accept': 'application/json'
      }
    };
    const lib = logicalLoginUrl.protocol === 'https:' ? https : http;
    const networkLoginUrl = new URL(logicalLoginUrl.href);
    const loginDnsOpts = applyDnsOverride(page, networkLoginUrl, base, loginOpts.headers, validatedAddresses[0]);
    Object.assign(loginOpts, loginDnsOpts);
    loginOpts.agent = getPageRequestAgent(networkLoginUrl, page);
    const loginReq = lib.request(networkLoginUrl, loginOpts, loginRes => {
      const setCookies = loginRes.headers['set-cookie'] || [];
      const chunks = [];
      loginRes.on('data', c => chunks.push(c));
      loginRes.on('end', () => {
        const acceptedStatuses = auth.loginSuccessStatuses || [];
        const accepted = acceptedStatuses.length
          ? acceptedStatuses.includes(loginRes.statusCode)
          : loginRes.statusCode >= 200 && loginRes.statusCode < 400;
        if (accepted && setCookies.length) {
          storeResponseCookies(page, user, logicalLoginUrl, setCookies);
          resolve();
          return;
        }
        reject(new Error(`目标站登录失败 (HTTP ${loginRes.statusCode})，请检查登录参数、登录路径与请求格式`));
      });
      loginRes.on('error', reject);
    });
    loginReq.on('error', reject);
    loginReq.setTimeout(proxyConfig.timeout_ms, () => loginReq.destroy(new Error('目标站登录超时')));
    loginReq.end(body);
  }));
}

/**
 * 通过 OAuth 2.0 客户端凭证模式获取访问令牌
 */
function fetchOAuthToken(page) {
  const auth = page.auth;
  const logicalTokenUrl = new URL(auth.tokenUrl);
  return assertTargetAllowed({}, logicalTokenUrl).then(validatedAddresses => new Promise((resolve, reject) => {
    const lib = logicalTokenUrl.protocol === 'https:' ? https : http;

    const params = new URLSearchParams(auth.params || {
      grant_type: 'client_credentials',
      client_id: auth.clientId,
      client_secret: auth.clientSecret,
      ...(auth.scope ? { scope: auth.scope } : {}),
      ...(auth.extraParams || {})
    });

    const body = params.toString();
    const reqOpts = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        'Accept': 'application/json'
      }
    };

    // 令牌端点可能在不同域名，不使用页面手工 resolveIp，但固定到已通过策略检查的 DNS 地址。
    const networkTokenUrl = new URL(logicalTokenUrl.href);
    Object.assign(reqOpts, applyDnsOverride(
      {}, networkTokenUrl, logicalTokenUrl, reqOpts.headers, validatedAddresses[0]
    ));
    reqOpts.agent = getPageRequestAgent(networkTokenUrl, page);

    const req = lib.request(networkTokenUrl, reqOpts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (!data.access_token) {
              reject(new Error('OAuth 令牌响应缺少 access_token'));
              return;
            }
            // 默认 1 小时，提前 60 秒刷新
            const expiresIn = data.expires_in || 3600;
            resolve({
              token: data.access_token,
              expiresAt: Date.now() + (expiresIn - 60) * 1000
            });
          } catch (e) {
            reject(new Error('OAuth 令牌响应解析失败: ' + e.message));
          }
        } else {
          reject(new Error(`OAuth 令牌请求失败 (HTTP ${res.statusCode})`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(proxyConfig.timeout_ms, () => req.destroy(new Error('OAuth 令牌请求超时')));
    req.end(body);
  }));
}

/**
 * 按认证配置构建转发请求头（HTTP 转发与 WebSocket upgrade 共用）
 * @param {object} user 当前登录用户（JWT 解码结果，含 email/name），identity 模式使用
 */
async function applyAuthHeaders(page, headers, user, targetUrl) {
  // 浏览器请求中的 Cookie 属于 Hilbert/代理 origin，绝不能直接转发给目标站。
  const browserCookies = page.sessionMode === 'browser' ? browserCookieHeader(headers.cookie) : '';
  delete headers.cookie;
  if (page.sessionMode === 'browser') {
    if (browserCookies) headers.cookie = browserCookies;
  } else {
    const storedCookie = getCookieHeader(page, user, targetUrl);
    if (storedCookie) headers.cookie = storedCookie;
  }

  const auth = page.auth;
  if (!auth) return;
  const primaryOrigin = page.url ? new URL(page.url).origin : targetUrl.origin;
  if (targetUrl.origin !== primaryOrigin) {
    const alias = Object.entries(page.origins || {}).find(([, origin]) => origin === targetUrl.origin)?.[0];
    if (!alias || !(page.authOrigins || []).includes(alias)) return;
  }
  if (auth.mode === 'identity') {
    for (const mapping of auth.claims || []) {
      let value = getClaim(user, mapping.claim);
      if (value === undefined && mapping.fallbackClaim) value = getClaim(user, mapping.fallbackClaim);
      if (mapping.claim === 'googleAuth' && value) value = sanitizeGoogleAuth(value);
      if (mapping.claim === 'googleAccessToken') {
        const expired = user && user.googleAccessTokenExpiresAt &&
          Number(user.googleAccessTokenExpiresAt) <= Date.now();
        if (expired) continue;
      }
      if (value !== undefined && value !== null && value !== '') {
        headers[mapping.header.toLowerCase()] = toHeaderValue(formatClaim(value, mapping.format));
      }
    }
    return;
  }
  if (auth.mode === 'header') {
    for (const [name, value] of Object.entries(
      auth.headers || { [auth.headerName]: auth.headerValue }
    )) headers[name.toLowerCase()] = value;
  } else if (auth.mode === 'login') {
    const sessionKey = `${page.id}:${userKey(user)}`;
    if (!loginSessions.has(sessionKey)) {
      const pendingLogin = performLogin(page, new URL(page.url), user)
        .then(() => true)
        .catch(err => {
          loginSessions.delete(sessionKey);
          throw err;
        });
      loginSessions.set(sessionKey, pendingLogin);
    }
    await loginSessions.get(sessionKey);
    const loginCookie = getCookieHeader(page, user, targetUrl);
    if (loginCookie) headers.cookie = loginCookie;
    else delete headers.cookie;
  } else if (auth.mode === 'oauth') {
    const cached = tokenCache.get(page.id);
    if (!cached || cached.expiresAt < Date.now()) {
      const result = await fetchOAuthToken(page);
      tokenCache.set(page.id, result);
      headers.authorization = 'Bearer ' + result.token;
    } else {
      headers.authorization = 'Bearer ' + cached.token;
    }
  } else {
    // basic（默认）
    headers.authorization = 'Basic ' +
      Buffer.from(auth.username + ':' + auth.password).toString('base64');
  }
}

/**
 * 清除指定页面的会话缓存（会话过期时调用）
 */
function clearSession(pageId, user) {
  if (user) loginSessions.delete(`${pageId}:${userKey(user)}`);
  else {
    const prefix = `${pageId}:`;
    for (const key of loginSessions.keys()) {
      if (key.startsWith(prefix)) loginSessions.delete(key);
    }
  }
  tokenCache.delete(pageId);
  clearCookieJar(pageId, user);
}

module.exports = {
  applyAuthHeaders,
  clearSession,
  loginSessions,
  resolveLoginUrl
};
