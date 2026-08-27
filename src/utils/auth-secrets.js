function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

/**
 * 编辑页面时浏览器不会收到已有 Secret。对应输入留空表示继续使用旧值。
 */
function mergeAuthSecrets(existingAuth, incomingAuth) {
  if (!incomingAuth || typeof incomingAuth !== 'object') return incomingAuth;
  const merged = { ...incomingAuth };
  const existing = existingAuth && typeof existingAuth === 'object' ? existingAuth : null;
  if (!existing) return merged;

  const incomingMode = incomingAuth.mode || 'basic';
  const existingMode = existing.mode || 'basic';
  const passwordModes = new Set(['basic', 'login']);
  if (passwordModes.has(incomingMode) && passwordModes.has(existingMode) &&
      (!hasOwn(incomingAuth, 'password') || incomingAuth.password === '')) {
    if (existing.password) merged.password = existing.password;
  }
  if (incomingMode === 'header' && existingMode === 'header' &&
      (!hasOwn(incomingAuth, 'headerValue') || incomingAuth.headerValue === '')) {
    if (existing.headerValue) merged.headerValue = existing.headerValue;
  }
  if (incomingMode === 'oauth' && existingMode === 'oauth' &&
      (!hasOwn(incomingAuth, 'clientSecret') || incomingAuth.clientSecret === '')) {
    if (existing.clientSecret) merged.clientSecret = existing.clientSecret;
  }
  return merged;
}

module.exports = { mergeAuthSecrets };
