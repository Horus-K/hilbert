const SAFE_AUTH_FIELDS = {
  basic: ['mode', 'username'],
  login: [
    'mode', 'username', 'loginPath', 'loginFormat', 'userField', 'passwordField',
    'loginSuccessStatuses', 'expiredStatuses'
  ],
  header: ['mode', 'headerName'],
  oauth: ['mode', 'tokenUrl', 'clientId', 'scope'],
  identity: [
    'mode', 'userHeader', 'emailHeader', 'displayNameHeader', 'groupsHeader',
    'idHeader', 'pictureHeader', 'googleAuthHeader', 'googleAccessTokenHeader',
    'forwardGoogleAuth', 'forwardGoogleAccessToken', 'claims'
  ]
};

function toPublicAuth(auth) {
  if (!auth || typeof auth !== 'object') return auth || undefined;
  const mode = auth.mode || 'basic';
  const result = {};
  for (const field of (SAFE_AUTH_FIELDS[mode] || ['mode'])) {
    if (auth[field] !== undefined) result[field] = auth[field];
  }
  result.mode = mode;
  if (mode === 'basic' || mode === 'login') result.hasPassword = Boolean(auth.password);
  if (mode === 'login') {
    result.paramKeys = Object.keys(auth.params || {
      [auth.userField || 'user']: auth.username,
      [auth.passwordField || 'password']: auth.password,
      ...(auth.extraParams || {})
    });
  }
  if (auth.extraParams) result.extraParamKeys = Object.keys(auth.extraParams);
  if (mode === 'header') {
    result.hasHeaderValue = Boolean(auth.headerValue);
    result.headerNames = Object.keys(auth.headers || (auth.headerName ? { [auth.headerName]: '' } : {}));
  }
  if (mode === 'oauth') {
    result.hasClientSecret = Boolean(auth.clientSecret);
    result.paramKeys = Object.keys(auth.params || {
      grant_type: 'client_credentials',
      client_id: auth.clientId,
      client_secret: auth.clientSecret,
      ...(auth.scope ? { scope: auth.scope } : {}),
      ...(auth.extraParams || {})
    });
  }
  return result;
}

function toPublicPage(page) {
  if (!page || typeof page !== 'object') return page;
  const result = { ...page };
  if (page.auth) result.auth = toPublicAuth(page.auth);
  if (page.logoType) result.logo = `/hilbert-api/pages/${encodeURIComponent(page.id)}/logo`;
  return result;
}

module.exports = { toPublicAuth, toPublicPage };
