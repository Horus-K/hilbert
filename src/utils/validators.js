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
      groupsHeader: 'X-Forwarded-Groups'
    };
    const normalized = { mode };
    for (const [key, fallback] of Object.entries(defaults)) {
      const headerName = String(auth[key] || fallback).trim() || fallback;
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(headerName)) return undefined;
      normalized[key] = headerName;
    }
    return normalized;
  }
  if (mode === 'header') {
    if (!auth.headerName || !String(auth.headerValue).trim()) return undefined;
    return { mode, headerName: String(auth.headerName).trim(), headerValue: String(auth.headerValue) };
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
    // 登录接口路径，默认 /login（Grafana 等均为该路径）
    let loginPath = String(auth.loginPath || '/login').trim() || '/login';
    if (!loginPath.startsWith('/')) loginPath = '/' + loginPath;
    normalized.loginPath = loginPath;
    // 登录请求体格式：json（默认，如 Grafana）/ form（表单编码，如 XXL-JOB）
    const loginFormat = auth.loginFormat || 'json';
    if (!['json', 'form'].includes(loginFormat)) return undefined;
    normalized.loginFormat = loginFormat;
    // 目标站的用户名/密码字段名，默认 user/password
    const userField = String(auth.userField || 'user').trim();
    const passwordField = String(auth.passwordField || 'password').trim();
    if (!userField || !passwordField) return undefined;
    normalized.userField = userField;
    normalized.passwordField = passwordField;
  }
  return normalized;
}

/**
 * 校验并规范化挂载模式的自定义路径（如 /jenkins）
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

module.exports = { isValidUrl, normalizeAuth, normalizeMountPath };
