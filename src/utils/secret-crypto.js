const crypto = require('crypto');
const { security, google } = require('../config');

const PREFIX = 'enc:v1';
const explicitMaterial = String((security && security.data_encryption_key) || '');
const fallbackMaterial = String((google && google.jwt_secret) || '');
const previousMaterials = Array.isArray(security && security.data_encryption_previous_keys)
  ? security.data_encryption_previous_keys
  : [];

function derive(material, source) {
  if (!material) return null;
  const key = crypto.createHash('sha256').update(material, 'utf8').digest();
  return {
    key,
    source,
    id: crypto.createHash('sha256').update(key).digest('hex').slice(0, 12)
  };
}

const primary = derive(explicitMaterial || fallbackMaterial, explicitMaterial ? 'explicit' : 'jwt-derived');
const decryptKeys = [];
if (primary) decryptKeys.push(primary);
if (explicitMaterial && fallbackMaterial) {
  const derivedFallback = derive(fallbackMaterial, 'jwt-derived-previous');
  if (!decryptKeys.some(item => item.id === derivedFallback.id)) decryptKeys.push(derivedFallback);
}
for (const material of previousMaterials) {
  const previous = derive(material, 'configured-previous');
  if (previous && !decryptKeys.some(item => item.id === previous.id)) decryptKeys.push(previous);
}

function isEncryptedSecret(value) {
  return typeof value === 'string' && value.startsWith(PREFIX + ':');
}

function encryptedKeyId(value) {
  if (!isEncryptedSecret(value)) return null;
  const parts = value.split(':');
  return parts.length === 6 ? parts[2] : null;
}

function isEncryptedWithPrimary(value) {
  return Boolean(primary && encryptedKeyId(value) === primary.id);
}

function requirePrimaryKey() {
  if (!primary) {
    const error = new Error('未配置 DATA_ENCRYPTION_KEY，且 JWT_SECRET 为空，无法加密页面认证 Secret');
    error.code = 'SECRET_ENCRYPTION_UNAVAILABLE';
    throw error;
  }
}

function encryptSecret(value) {
  if (value === undefined || value === null || value === '') return value;
  if (isEncryptedWithPrimary(value)) return value;
  if (isEncryptedSecret(value)) value = decryptSecret(value);
  requirePrimaryKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', primary.key, iv);
  cipher.setAAD(Buffer.from(PREFIX, 'utf8'));
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PREFIX, primary.id, iv.toString('base64url'), tag.toString('base64url'), encrypted.toString('base64url')].join(':');
}

function decryptSecret(value) {
  if (!isEncryptedSecret(value)) return value;
  const parts = value.split(':');
  if (parts.length !== 6 || `${parts[0]}:${parts[1]}` !== PREFIX) {
    const error = new Error('页面认证 Secret 密文格式不合法');
    error.code = 'SECRET_DECRYPT_FAILED';
    throw error;
  }
  const storedKeyId = parts[2];
  const keyInfo = decryptKeys.find(item => item.id === storedKeyId);
  if (!keyInfo) {
    const error = new Error(`页面认证 Secret 使用了未知加密密钥 (keyId=${storedKeyId})`);
    error.code = 'SECRET_KEY_MISMATCH';
    throw error;
  }
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyInfo.key, Buffer.from(parts[3], 'base64url'));
    decipher.setAAD(Buffer.from(PREFIX, 'utf8'));
    decipher.setAuthTag(Buffer.from(parts[4], 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(parts[5], 'base64url')),
      decipher.final()
    ]).toString('utf8');
  } catch (cause) {
    const error = new Error('页面认证 Secret 解密失败');
    error.code = 'SECRET_DECRYPT_FAILED';
    error.cause = cause;
    throw error;
  }
}

function getEncryptionStatus() {
  return {
    enabled: Boolean(primary),
    source: primary ? primary.source : 'unavailable',
    keyId: primary ? primary.id : null,
    algorithm: primary ? 'AES-256-GCM' : null,
    fallbackKeyIds: decryptKeys.slice(1).map(item => item.id)
  };
}

module.exports = {
  decryptSecret,
  encryptSecret,
  encryptedKeyId,
  getEncryptionStatus,
  isEncryptedSecret,
  isEncryptedWithPrimary
};
