// 加载 .env 文件（如果存在），系统环境变量优先级更高
require('dotenv').config();

// 配置项全部从环境变量读取，敏感信息不硬编码
module.exports = {
  // 超级管理员邮箱列表（逗号分隔）：拥有所有页面的所有权限，且是唯一能访问 RBAC 权限配置的用户
  admin_emails: (process.env.ADMIN_EMAIL || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean),
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
    oauth2_include_granted_scopes: process.env.GOOGLE_OAUTH2_INCLUDE_GRANTED_SCOPS !== 'false',
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
