// 加载 .env 文件（如果存在），系统环境变量优先级更高
require('dotenv').config();

const appPort = parseInt(process.env.PORT || '3000', 10);
const externalProxyPort = parseInt(process.env.EXTERNAL_PROXY_PORT || String(appPort + 1), 10);
const externalProxyHostTemplate = String(process.env.EXTERNAL_PROXY_PUBLIC_HOST_TEMPLATE || '').trim().toLowerCase();
const externalProxyProtocol = String(process.env.EXTERNAL_PROXY_PUBLIC_PROTOCOL || '').trim().toLowerCase();
const hasExplicitExternalProxyPublicPort = String(process.env.EXTERNAL_PROXY_PUBLIC_PORT || '').trim() !== '';
const externalProxyPublicPort = hasExplicitExternalProxyPublicPort
  ? parseInt(process.env.EXTERNAL_PROXY_PUBLIC_PORT, 10)
  : (externalProxyHostTemplate ? null : externalProxyPort);

function assertPort(name, value) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${name} 必须是 1-65535 之间的端口`);
  }
}

function parsePositiveInt(name, fallback, min, max) {
  const value = parseInt(process.env[name] || String(fallback), 10);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} 必须是 ${min}-${max} 之间的整数`);
  }
  return value;
}

assertPort('PORT', appPort);
assertPort('EXTERNAL_PROXY_PORT', externalProxyPort);
if (externalProxyPublicPort !== null) assertPort('EXTERNAL_PROXY_PUBLIC_PORT', externalProxyPublicPort);
if (externalProxyPort === appPort) throw new Error('EXTERNAL_PROXY_PORT 必须与 PORT 不同');

if (externalProxyProtocol && !['http', 'https'].includes(externalProxyProtocol)) {
  throw new Error('EXTERNAL_PROXY_PUBLIC_PROTOCOL 只能是 http 或 https');
}

if (externalProxyHostTemplate) {
  const labels = externalProxyHostTemplate.split('.');
  if (externalProxyHostTemplate.length > 253) {
    throw new Error('EXTERNAL_PROXY_PUBLIC_HOST_TEMPLATE 超过 DNS hostname 长度限制');
  }
  if (labels.filter(label => label === '{pageid}').length !== 1 || labels.some(label => !label)) {
    throw new Error('EXTERNAL_PROXY_PUBLIC_HOST_TEMPLATE 必须包含一个独立的 {pageId} DNS 标签');
  }
  for (const label of labels) {
    if (label === '{pageid}') continue;
    if (label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)) {
      throw new Error('EXTERNAL_PROXY_PUBLIC_HOST_TEMPLATE 包含非法 DNS 标签');
    }
  }
}

let externalProxyPublicOrigin = '';
if (process.env.EXTERNAL_PROXY_PUBLIC_ORIGIN) {
  if (externalProxyHostTemplate) {
    throw new Error('EXTERNAL_PROXY_PUBLIC_ORIGIN 与 EXTERNAL_PROXY_PUBLIC_HOST_TEMPLATE 不能同时配置');
  }
  const url = new URL(process.env.EXTERNAL_PROXY_PUBLIC_ORIGIN);
  if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('EXTERNAL_PROXY_PUBLIC_ORIGIN 必须是无路径、查询参数和片段的 http/https origin');
  }
  externalProxyPublicOrigin = url.origin;
} else if (!externalProxyHostTemplate && externalProxyPublicPort === appPort) {
  throw new Error('EXTERNAL_PROXY_PUBLIC_PORT 必须与 PORT 不同，以确保浏览器 origin 隔离');
}

// 配置项全部从环境变量读取，敏感信息不硬编码
module.exports = {
  // 超级管理员邮箱列表（逗号分隔）：拥有所有页面的所有权限，且是唯一能访问 RBAC 权限配置的用户
  admin_emails: (process.env.ADMIN_EMAIL || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean),
  // 外部链接页面的统一出站代理；与 Google OAuth API 代理相互独立。
  page_proxy: process.env.PAGE_PROXY || '',
  // 外部页面必须运行在与 Hilbert UI 不同的浏览器 origin 上，避免目标脚本获得主站权限。
  // 配置 HOST_TEMPLATE 后，每个页面按 Host 路由；未配置时兼容旧版共享 origin + 挂载路径。
  external_proxy: {
    listen_port: externalProxyPort,
    public_port: externalProxyPublicPort,
    public_origin: externalProxyPublicOrigin,
    public_host_template: externalProxyHostTemplate,
    public_protocol: externalProxyProtocol,
    ticket_ttl_seconds: parsePositiveInt('EXTERNAL_PROXY_TICKET_TTL_SECONDS', 60, 10, 600),
    session_ttl_minutes: parsePositiveInt('EXTERNAL_PROXY_SESSION_TTL_MINUTES', 480, 1, 10080)
  },
  debug: {
    enabled: process.env.DEBUG_MODE === 'true',
    user: {
      id: process.env.DEBUG_USER_ID || '',
      email: process.env.DEBUG_USER_EMAIL || '',
      name: process.env.DEBUG_USER_NAME || 'Debug User',
      displayName: process.env.DEBUG_USER_DISPLAY_NAME || process.env.DEBUG_USER_NAME || 'Debug User',
      groups: (process.env.DEBUG_USER_GROUPS || '')
        .split(',')
        .map(group => group.trim())
        .filter(Boolean),
      picture: process.env.DEBUG_USER_PICTURE || ''
    }
  },
  google: {
    client_id: process.env.GOOGLE_CLIENT_ID || '',
    client_secret: process.env.GOOGLE_CLIENT_SECRET || '',
    oauth2_scope: process.env.GOOGLE_OAUTH2_SCOPE || '',
    oauth2_access_type: process.env.GOOGLE_OAUTH2_ACCESS_TYPE || 'offline',
    oauth2_include_granted_scopes: process.env.GOOGLE_OAUTH2_INCLUDE_GRANTED_SCOPES !== 'false',
    oauth2_response_type: process.env.GOOGLE_OAUTH2_RESPONSE_TYPE || 'code',
    oauth2_redirect_uri: process.env.GOOGLE_REDIRECT_URI,
    oauth2_url: process.env.GOOGLE_OAUTH2_URL || 'https://accounts.google.com/o/oauth2/v2/auth',
    token_url: process.env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token',
    jwt_expire_hours: parseInt(process.env.JWT_EXPIRE_HOURS || '720', 10),
    jwt_secret: process.env.JWT_SECRET || '',
    // Google API 出站代理（国内服务器需配置，用于换取 token 和获取用户信息）
    api_proxy: process.env.GOOGLE_API_PROXY || '',
    // 登录限制：允许登录的邮箱域名（为空则不限制域名）
    allowed_domain: process.env.GOOGLE_ALLOWED_DOMAIN || '',
    // 登录限制：允许登录的具体邮箱列表（逗号分隔，优先级高于 allowed_domain；为空则不限制具体邮箱）
    allowed_emails: process.env.GOOGLE_ALLOWED_EMAILS || ''
  }
};
