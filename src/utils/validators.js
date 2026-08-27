/**
 * URL 合法性校验：仅允许 http/https 协议
 */
function isValidUrl(str) {
  try {
    const u = new URL(str);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function normalizeSessionMode(value) {
  const mode = value === undefined || value === null || value === '' ? 'server' : String(value);
  return mode === 'server' || mode === 'browser' ? mode : undefined;
}

function normalizeResolveIp(value) {
  const address = String(value || '').trim();
  return !address || net.isIP(address) ? address : undefined;
}

function normalizeOrigins(value) {
  if (value === undefined || value === null || value === '') return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value);
  if (entries.length > 20) return undefined;
  const normalized = {};
  for (const [rawAlias, rawOrigin] of entries) {
    const alias = String(rawAlias).trim().toLowerCase();
    if (!/^[a-z0-9](?:[a-z0-9-]{0,29}[a-z0-9])?$/.test(alias) || normalized[alias]) return undefined;
    try {
      const url = new URL(String(rawOrigin).trim());
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
          url.pathname !== '/' || url.search || url.hash) return undefined;
      normalized[alias] = url.origin;
    } catch {
      return undefined;
    }
  }
  return normalized;
}

function normalizeAuthOrigins(value, origins) {
  if (value === undefined || value === null || value === '') return [];
  if (!Array.isArray(value) || value.length > 20) return undefined;
  const normalized = [...new Set(value.map(alias => String(alias).trim().toLowerCase()).filter(Boolean))];
  return normalized.every(alias => origins && origins[alias]) ? normalized : undefined;
}

/**
 * 校验并规范化认证配置
 * 支持五种模式：basic / login / oauth / header / identity
 * 返回值：null = 未启用，undefined = 非法配置，对象 = 规范化后的配置
 */
function normalizeAuth(auth) {
  if (!auth) return null;
  const mode = auth.mode || 'basic'; // 兼容旧数据：无 mode 视为 basic
  if (!['basic', 'login', 'oauth', 'header', 'identity'].includes(mode)) return undefined;
  if (mode === 'identity') {
    const defaults = {
      userHeader: 'X-Forwarded-User',
      emailHeader: 'X-Forwarded-Mail',
      displayNameHeader: 'X-Forwarded-DisplayName',
      groupsHeader: 'X-Forwarded-Groups',
      idHeader: 'X-Forwarded-User-Id',
      pictureHeader: 'X-Forwarded-User-Picture',
      googleAuthHeader: 'X-Forwarded-Google-Auth',
      googleAccessTokenHeader: 'X-Forwarded-Google-Access-Token'
    };
    const normalized = { mode };
    for (const [key, fallback] of Object.entries(defaults)) {
      const headerName = String(auth[key] || fallback).trim() || fallback;
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(headerName)) return undefined;
      normalized[key] = headerName;
    }

    normalized.forwardGoogleAuth = auth.forwardGoogleAuth === true;
    normalized.forwardGoogleAccessToken = auth.forwardGoogleAccessToken === true;
    const defaultClaims = [
      { claim: 'email', header: normalized.userHeader },
      { claim: 'email', header: normalized.emailHeader },
      { claim: 'displayName', header: normalized.displayNameHeader },
      { claim: 'groups', header: normalized.groupsHeader, format: 'csv' },
      { claim: 'sub', fallbackClaim: 'id', header: normalized.idHeader },
      { claim: 'picture', header: normalized.pictureHeader }
    ];
    const claims = Array.isArray(auth.claims) ? [...auth.claims] : defaultClaims;
    if (normalized.forwardGoogleAuth && !claims.some(mapping => mapping && mapping.claim === 'googleAuth')) {
      claims.push({
        claim: 'googleAuth',
        header: normalized.googleAuthHeader,
        format: 'base64url'
      });
    }
    if (normalized.forwardGoogleAccessToken &&
        !claims.some(mapping => mapping && mapping.claim === 'googleAccessToken')) {
      claims.push({
        claim: 'googleAccessToken',
        header: normalized.googleAccessTokenHeader,
        format: 'text'
      });
    }

    normalized.claims = [];
    for (const mapping of claims) {
      const header = String(mapping && mapping.header || '').trim();
      const claim = String(mapping && mapping.claim || '').trim();
      const fallbackClaim = mapping && mapping.fallbackClaim
        ? String(mapping.fallbackClaim).trim()
        : undefined;
      const format = String(mapping && mapping.format || 'text');
      if (!header || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(header)) return undefined;
      if (!/^[A-Za-z0-9_.-]+$/.test(claim)) return undefined;
      if (fallbackClaim && !/^[A-Za-z0-9_.-]+$/.test(fallbackClaim)) return undefined;
      if (!['text', 'csv', 'json', 'base64url'].includes(format)) return undefined;
      normalized.claims.push({ claim, header, format, ...(fallbackClaim ? { fallbackClaim } : {}) });
    }
    return normalized;
  }
  if (mode === 'header') {
    if (!auth.headerName || !String(auth.headerValue).trim()) return undefined;
    const headerName = String(auth.headerName).trim();
    const headerValue = String(auth.headerValue);
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(headerName)) return undefined;
    if (/[\r\n]/.test(headerValue)) return undefined;
    return { mode, headerName, headerValue };
  }
  if (mode === 'oauth') {
    if (!auth.tokenUrl || !auth.clientId || !auth.clientSecret) return undefined;
    let tokenUrl = String(auth.tokenUrl).trim();
    try {
      const u = new URL(tokenUrl);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
    } catch { return undefined; }
    const normalized = {
      mode,
      tokenUrl,
      clientId: String(auth.clientId).trim(),
      clientSecret: String(auth.clientSecret)
    };
    if (auth.scope) normalized.scope = String(auth.scope).trim();
    return normalized;
  }
  if (!auth.username || !auth.password) return undefined;
  const normalized = { mode, username: String(auth.username), password: String(auth.password) };
  if (mode === 'login') {
    // 登录地址可使用根路径或相对于页面 URL 的路径；运行时强制与目标页面同源。
    let loginPath = String(auth.loginPath || '/login').trim() || '/login';
    normalized.loginPath = loginPath;
    // 登录请求体格式：JSON 或标准表单编码。
    const loginFormat = auth.loginFormat || 'json';
    if (!['json', 'form'].includes(loginFormat)) return undefined;
    normalized.loginFormat = loginFormat;
    // 目标站的用户名/密码字段名，默认 user/password
    const userField = String(auth.userField || 'user').trim();
    const passwordField = String(auth.passwordField || 'password').trim();
    if (!userField || !passwordField) return undefined;
    normalized.userField = userField;
    normalized.passwordField = passwordField;
    if (auth.loginSuccessStatuses !== undefined) {
      if (!Array.isArray(auth.loginSuccessStatuses) ||
          auth.loginSuccessStatuses.some(code => !Number.isInteger(code) || code < 100 || code > 599)) {
        return undefined;
      }
      normalized.loginSuccessStatuses = [...new Set(auth.loginSuccessStatuses)];
    }
    if (auth.expiredStatuses !== undefined) {
      if (!Array.isArray(auth.expiredStatuses) ||
          auth.expiredStatuses.some(code => !Number.isInteger(code) || code < 100 || code > 599)) {
        return undefined;
      }
      normalized.expiredStatuses = [...new Set(auth.expiredStatuses)];
    }
  }
  return normalized;
}

/**
 * 校验并规范化隔离代理 origin 内的自定义挂载路径
 * 返回：null = 未配置（回退默认 /hilbert-proxy/<id>），undefined = 非法，字符串 = 规范化路径
 */
function normalizeMountPath(mountPath) {
  if (mountPath === undefined || mountPath === null) return null;
  let path = String(mountPath).trim();
  if (!path) return null;
  if (!path.startsWith('/')) path = '/' + path;
  path = '/' + path.split('/').filter(Boolean).join('/');
  // 每段仅允许 URL 安全字符，且拒绝纯点段（./..）防止路径逃逸与注入
  if (!/^\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/.test(path)) return undefined;
  if (path.split('/').some(seg => /^\.+$/.test(seg))) return undefined;
  // 保留前缀：系统 API / 静态托管 / 默认挂载根 / 页面查看器
  const reserved = ['hilbert-api', 'hilbert-custom', 'hilbert-proxy', 'page'];
  if (reserved.includes(path.split('/')[1])) return undefined;
  return path;
}

module.exports = {
  isValidUrl,
  normalizeAuth,
  normalizeAuthOrigins,
  normalizeMountPath,
  normalizeOrigins,
  normalizeResolveIp,
  normalizeSessionMode
};
const net = require('node:net');
