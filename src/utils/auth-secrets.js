function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function findHeaderValue(headers, name) {
  const key = Object.keys(headers || {}).find(candidate =>
    candidate.toLowerCase() === String(name).toLowerCase());
  return key === undefined ? undefined : headers[key];
}

function legacyParams(auth) {
  if (auth.mode === 'oauth') {
    return {
      grant_type: 'client_credentials',
      client_id: auth.clientId,
      client_secret: auth.clientSecret,
      ...(auth.scope ? { scope: auth.scope } : {}),
      ...(auth.extraParams || {})
    };
  }
  return {
    [auth.userField || 'user']: auth.username,
    [auth.passwordField || 'password']: auth.password,
    ...(auth.extraParams || {})
  };
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
  const legacyHeaderUpdate = incomingMode === 'header' && existingMode === 'header' &&
    existing.headers && hasOwn(incomingAuth, 'headerName') && !hasOwn(incomingAuth, 'headers');
  if (legacyHeaderUpdate) {
    const oldValue = findHeaderValue(existing.headers, incomingAuth.headerName);
    const value = incomingAuth.headerValue === '' || !hasOwn(incomingAuth, 'headerValue')
      ? oldValue
      : incomingAuth.headerValue;
    if (value !== undefined) merged.headers = { [incomingAuth.headerName]: value };
  }
  for (const field of ['extraParams', 'headers', 'params']) {
    if (incomingMode !== existingMode) continue;
    if (field === 'headers' && legacyHeaderUpdate) continue;
    if (!hasOwn(incomingAuth, field)) {
      if (existing[field]) merged[field] = { ...existing[field] };
      continue;
    }
    const incoming = incomingAuth[field];
    const previous = existing[field] ||
      (field === 'headers' && existing.headerName ? { [existing.headerName]: existing.headerValue } : null) ||
      (field === 'params' && ['login', 'oauth'].includes(existingMode) ? legacyParams(existing) : {});
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) continue;
    merged[field] = Object.fromEntries(Object.entries(incoming).map(([key, value]) => {
      const oldValue = field === 'headers' ? findHeaderValue(previous, key) : previous[key];
      return [key, value === '' ? oldValue ?? value : value];
    }));
  }
  return merged;
}

module.exports = { mergeAuthSecrets };
