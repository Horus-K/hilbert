const SENSITIVE_PROVIDER_KEYS = new Set([
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'googleaccesstoken',
  'googleaccesstokenexpiresat'
]);

function normalizedKey(key) {
  return String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * 复制第三方用户资料，同时递归移除 OAuth token 字段。
 * 用于 X-Forwarded-Google-Auth，确保“完整资料”不暗含访问令牌。
 */
function sanitizeGoogleAuth(value) {
  if (Array.isArray(value)) return value.map(sanitizeGoogleAuth);
  if (!value || typeof value !== 'object') return value;

  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_PROVIDER_KEYS.has(normalizedKey(key))) continue;
    result[key] = sanitizeGoogleAuth(child);
  }
  return result;
}

module.exports = { sanitizeGoogleAuth };
