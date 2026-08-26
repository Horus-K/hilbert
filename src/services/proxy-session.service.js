const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { external_proxy: proxyConfig, google: googleConfig } = require('../config');
const { requestProtocol } = require('../utils/proxy-origin');
const { sanitizeGoogleAuth } = require('../utils/user-identity');
const sessionRegistry = require('./session-registry.service');

const PROXY_SESSION_COOKIE = 'hilbert_proxy_session';
const TICKET_BYTES = 32;
const MAX_PENDING_TICKETS = 10000;
const pendingTickets = new Map();

function copyProxyUser(user) {
  const source = user || {};
  const result = {
    sub: source.sub || source.id || source.email,
    email: source.email,
    name: source.name,
    displayName: source.displayName,
    groups: Array.isArray(source.groups) ? source.groups : (source.groups ? [source.groups] : []),
    picture: source.picture,
    mainSessionId: source.mainSessionId || source.sid || null
  };
  const mainSessionExpiresAt = Number(source.mainSessionExpiresAt) ||
    (Number.isFinite(Number(source.exp)) ? Number(source.exp) * 1000 : 0);
  if (mainSessionExpiresAt) result.mainSessionExpiresAt = mainSessionExpiresAt;
  if (source.googleAuth) result.googleAuth = sanitizeGoogleAuth(source.googleAuth);
  if (source.googleAccessToken) {
    result.googleAccessToken = source.googleAccessToken;
    result.googleAccessTokenExpiresAt = source.googleAccessTokenExpiresAt || null;
  }
  return result;
}

function cleanExpiredTickets(now = Date.now()) {
  for (const [ticket, payload] of pendingTickets) {
    if (payload.expiresAt <= now) pendingTickets.delete(ticket);
  }
  while (pendingTickets.size > MAX_PENDING_TICKETS) {
    pendingTickets.delete(pendingTickets.keys().next().value);
  }
}

function normalizeNextPath(nextPath) {
  const value = String(nextPath || '/');
  const base = new URL('https://proxy.invalid/');
  let url;
  try {
    url = new URL(value, base);
  } catch {
    throw new Error('代理页面跳转路径不合法');
  }
  if (!value.startsWith('/') || url.origin !== base.origin) {
    throw new Error('代理页面跳转路径不合法');
  }
  return url.pathname + url.search + url.hash;
}

/**
 * 主站签发短时、一次性的随机票据。票据内容只保存在服务端内存，
 * 浏览器 URL 中不携带 Hilbert JWT 或用户资料。
 */
function issueProxyTicket(page, user, nextPath) {
  cleanExpiredTickets();
  const ticket = crypto.randomBytes(TICKET_BYTES).toString('base64url');
  pendingTickets.set(ticket, {
    pageId: page.id,
    user: copyProxyUser(user),
    nextPath: normalizeNextPath(nextPath),
    expiresAt: Date.now() + proxyConfig.ticket_ttl_seconds * 1000
  });
  return ticket;
}

/**
 * 票据无论成功或失败都立即删除，确保单次使用。
 */
function consumeProxyTicket(ticket, expectedPageId) {
  const key = String(ticket || '');
  const payload = pendingTickets.get(key);
  if (payload) pendingTickets.delete(key);
  if (!payload || payload.expiresAt <= Date.now()) return null;
  if (payload.pageId !== expectedPageId) return null;
  return payload;
}

function signProxySession(pageId, user, metadata = {}) {
  const proxyUser = copyProxyUser(user);
  let expiresIn = proxyConfig.session_ttl_minutes * 60;
  if (proxyUser.mainSessionExpiresAt) {
    const remaining = Math.floor((proxyUser.mainSessionExpiresAt - Date.now()) / 1000);
    if (remaining <= 0) throw new Error('主站会话已过期');
    expiresIn = Math.min(expiresIn, remaining);
  }
  const session = sessionRegistry.createSession({
    type: 'proxy',
    email: proxyUser.email,
    displayName: proxyUser.displayName || proxyUser.name || proxyUser.email,
    pageId,
    parentSessionId: proxyUser.mainSessionId,
    expiresAt: Date.now() + expiresIn * 1000,
    ip: metadata.ip || null,
    userAgent: metadata.userAgent || null
  });
  const token = jwt.sign({
    type: 'proxy-session',
    pageId,
    sid: session.id,
    user: proxyUser
  }, googleConfig.jwt_secret, {
    audience: 'hilbert-page-proxy',
    subject: String(proxyUser.sub || proxyUser.email || ''),
    expiresIn
  });
  return { token, session };
}

function verifyProxySession(token, expectedPageId) {
  if (!token) return null;
  try {
    const payload = jwt.verify(token, googleConfig.jwt_secret, {
      audience: 'hilbert-page-proxy'
    });
    if (payload.type !== 'proxy-session' || payload.pageId !== expectedPageId || !payload.user) return null;
    if (payload.sid && !sessionRegistry.isActive(payload.sid)) return null;
    if (payload.sid) sessionRegistry.touch(payload.sid);
    return { ...payload.user, sid: payload.sid || null };
  } catch {
    return null;
  }
}

function readCookie(cookieHeader, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(cookieHeader || '').match(new RegExp(`(?:^|;\\s*)${escaped}=([^;]+)`));
  if (!match) return '';
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return '';
  }
}

function extractProxySession(req, pageId) {
  const token = readCookie(req.headers.cookie, PROXY_SESSION_COOKIE);
  return verifyProxySession(token, pageId);
}

function setProxySessionCookie(req, res, token) {
  res.cookie(PROXY_SESSION_COOKIE, token, {
    httpOnly: true,
    secure: requestProtocol(req) === 'https',
    sameSite: 'lax',
    path: '/',
    maxAge: proxyConfig.session_ttl_minutes * 60 * 1000
  });
}

function clearProxySessionCookie(req, res) {
  res.clearCookie(PROXY_SESSION_COOKIE, {
    httpOnly: true,
    secure: requestProtocol(req) === 'https',
    sameSite: 'lax',
    path: '/'
  });
}

function clearProxyTickets() {
  pendingTickets.clear();
}

module.exports = {
  PROXY_SESSION_COOKIE,
  clearProxySessionCookie,
  clearProxyTickets,
  consumeProxyTicket,
  extractProxySession,
  issueProxyTicket,
  normalizeNextPath,
  readCookie,
  setProxySessionCookie,
  signProxySession,
  verifyProxySession
};
