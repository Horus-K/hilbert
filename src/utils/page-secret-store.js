const {
  decryptSecret,
  encryptSecret,
  isEncryptedSecret,
  isEncryptedWithPrimary
} = require('./secret-crypto');

const SECRET_FIELD_BY_MODE = {
  basic: ['password'],
  login: ['password'],
  header: ['headerValue'],
  oauth: ['clientSecret']
};

function transformAuth(auth, transform) {
  if (!auth || typeof auth !== 'object') return auth;
  const mode = auth.mode || 'basic';
  const fields = SECRET_FIELD_BY_MODE[mode] || [];
  if (!fields.length) return { ...auth };
  const result = { ...auth };
  for (const field of fields) {
    if (result[field] !== undefined) result[field] = transform(result[field]);
  }
  for (const field of ['extraParams', 'headers', 'params']) {
    if (result[field] && typeof result[field] === 'object') {
      result[field] = Object.fromEntries(
        Object.entries(result[field]).map(([key, value]) => [key, transform(value)])
      );
    }
  }
  return result;
}

function encryptPageSecrets(pages) {
  return pages.map(page => page && page.auth
    ? { ...page, auth: transformAuth(page.auth, encryptSecret) }
    : { ...page });
}

function decryptPageSecrets(pages) {
  return pages.map(page => page && page.auth
    ? { ...page, auth: transformAuth(page.auth, decryptSecret) }
    : { ...page });
}

function secretValues(pages) {
  const values = [];
  for (const page of pages) {
    if (!page || !page.auth) continue;
    const mode = page.auth.mode || 'basic';
    for (const field of (SECRET_FIELD_BY_MODE[mode] || [])) {
      const value = page.auth[field];
      if (value !== undefined && value !== null && value !== '') values.push(value);
    }
    for (const field of ['extraParams', 'headers', 'params']) {
      if (page.auth[field] && typeof page.auth[field] === 'object') {
        values.push(...Object.values(page.auth[field]).filter(value => value !== null && value !== ''));
      }
    }
  }
  return values;
}

function hasPlaintextPageSecrets(pages) {
  return secretValues(pages).some(value => !isEncryptedSecret(value));
}

function needsPageSecretMigration(pages) {
  return secretValues(pages).some(value => !isEncryptedWithPrimary(value));
}

module.exports = {
  decryptPageSecrets,
  encryptPageSecrets,
  hasPlaintextPageSecrets,
  needsPageSecretMigration
};
