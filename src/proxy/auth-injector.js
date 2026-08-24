const http = require('http');
const https = require('https');
const { applyDnsOverride, httpsAgentNoVerify } = require('./agents');

// login 模式的会话缓存：pageId -> 会话 Cookie 字符串
const sessionCache = new Map();
// oauth 模式的令牌缓存：pageId -> { token, expiresAt }
const tokenCache = new Map();

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
 * 通过 OAuth 2.0 客户端凭证模式获取访问令牌
 */
function fetchOAuthToken(page) {
  return new Promise((resolve, reject) => {
    const auth = page.auth;
    const tokenUrl = new URL(auth.tokenUrl);
    const lib = tokenUrl.protocol === 'https:' ? https : http;

    const params = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: auth.clientId,
      client_secret: auth.clientSecret
    });
    if (auth.scope) params.append('scope', auth.scope);

    const body = params.toString();
    const reqOpts = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        'Accept': 'application/json'
      }
    };

    // 令牌端点可能在不同域名，不应用 DNS 覆盖，但 HTTPS 时支持 resolveIp 的 TLS 处理
    if (page.resolveIp && tokenUrl.protocol === 'https:') {
      reqOpts.agent = httpsAgentNoVerify;
    }

    const req = lib.request(tokenUrl, reqOpts, res => {
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
          const detail = Buffer.concat(chunks).toString('utf8').slice(0, 200);
          reject(new Error(`OAuth 令牌请求失败 (HTTP ${res.statusCode})${detail ? ': ' + detail : ''}`));
        }
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

/**
 * 按认证配置构建转发请求头（HTTP 转发与 WebSocket upgrade 共用）
 * @param {object} user 当前登录用户（JWT 解码结果，含 email/name），identity 模式使用
 */
async function applyAuthHeaders(page, headers, user) {
  const auth = page.auth;
  if (!auth) return;
  if (auth.mode === 'identity') {
    // 透传当前登录用户身份（如 Jenkins Reverse Proxy Auth Plugin 信任的请求头）
    if (user && user.email) {
      headers[(auth.userHeader || 'X-Forwarded-User').toLowerCase()] = user.email;
      headers[(auth.emailHeader || 'X-Forwarded-Mail').toLowerCase()] = user.email;
    }
    if (user && user.displayName) {
      headers[(auth.displayNameHeader || 'X-Forwarded-DisplayName').toLowerCase()] = user.displayName;
    }
    if (user && user.groups) {
      headers[(auth.groupsHeader || 'X-Forwarded-Groups').toLowerCase()] = Array.isArray(user.groups)
        ? user.groups.join(',')
        : user.groups;
    }
    return;
  }
  if (auth.mode === 'header') {
    headers[auth.headerName.toLowerCase()] = auth.headerValue;
  } else if (auth.mode === 'login') {
    let cookie = sessionCache.get(page.id);
    if (!cookie) {
      cookie = await performLogin(page, new URL(page.url));
      sessionCache.set(page.id, cookie);
    }
    headers.cookie = cookie;
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
function clearSession(pageId) {
  sessionCache.delete(pageId);
  tokenCache.delete(pageId);
}

module.exports = { applyAuthHeaders, clearSession, sessionCache };
