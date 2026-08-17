const http = require('http');
const https = require('https');
const { applyDnsOverride, httpsAgentNoVerify } = require('./agents');

// login 模式的会话缓存：pageId -> 会话 Cookie 字符串
const sessionCache = new Map();

/**
 * 执行一次表单登录，返回会话 Cookie 字符串
 */
function performLogin(page, base) {
  return new Promise((resolve, reject) => {
    const lib = base.protocol === 'https:' ? https : http;
    const auth = page.auth;
    const credentials = { [auth.userField]: auth.username, [auth.passwordField]: auth.password };
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
    // DNS 覆盖
    const loginUrl = new URL(base.origin + auth.loginPath);
    const loginDnsOpts = applyDnsOverride(page, loginUrl, base, loginOpts.headers);
    Object.assign(loginOpts, loginDnsOpts);
    if (page.resolveIp && base.protocol === 'https:') {
      loginOpts.agent = httpsAgentNoVerify;
    }
    const loginReq = lib.request(loginUrl, loginOpts, loginRes => {
      const setCookies = loginRes.headers['set-cookie'] || [];
      const chunks = [];
      loginRes.on('data', c => chunks.push(c));
      loginRes.on('end', () => {
        if (loginRes.statusCode >= 200 && loginRes.statusCode < 300 && setCookies.length) {
          resolve(setCookies.map(c => c.split(';')[0]).join('; '));
          return;
        }
        const detail = Buffer.concat(chunks).toString('utf8').slice(0, 200);
        reject(new Error(`目标站登录失败 (HTTP ${loginRes.statusCode})${detail ? ': ' + detail : ''}，请检查账号密码、登录路径与请求格式`));
      });
      loginRes.on('error', reject);
    });
    loginReq.on('error', reject);
    loginReq.end(body);
  });
}

/**
 * 按认证配置构建转发请求头（HTTP 转发与 WebSocket upgrade 共用）
 */
async function applyAuthHeaders(page, headers) {
  const auth = page.auth;
  if (!auth) return;
  if (auth.mode === 'header') {
    headers[auth.headerName.toLowerCase()] = auth.headerValue;
  } else if (auth.mode === 'login') {
    let cookie = sessionCache.get(page.id);
    if (!cookie) {
      cookie = await performLogin(page, new URL(page.url));
      sessionCache.set(page.id, cookie);
    }
    headers.cookie = cookie;
  } else {
    // basic（默认）
    headers.authorization = 'Basic ' +
      Buffer.from(auth.username + ':' + auth.password).toString('base64');
  }
}

/**
 * 清除指定页面的会话缓存（会话过期时调用）
 */
function clearSession(pageId) {
  sessionCache.delete(pageId);
}

module.exports = { applyAuthHeaders, clearSession, sessionCache };
