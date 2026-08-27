const crypto = require('crypto');
const EventEmitter = require('events');
const sessionsRepo = require('../repositories/sessions.repository');
const { operations } = require('../config');

const TOUCH_INTERVAL_MS = 60 * 1000;
const touchCache = new Map();
const events = new EventEmitter();

function prune(data, now = Date.now()) {
  const cutoff = now - operations.session_retention_days * 24 * 60 * 60 * 1000;
  const sessions = data.sessions.filter(session => {
    const expiresAt = Number(session.expiresAt) || 0;
    const revokedAt = session.revokedAt ? Date.parse(session.revokedAt) : 0;
    return expiresAt > cutoff || revokedAt > cutoff;
  });
  return sessions.length === data.sessions.length ? data : { ...data, sessions };
}

function createSession(input) {
  const now = Date.now();
  let data = prune(sessionsRepo.read(), now);
  const session = {
    id: input.id || crypto.randomUUID(),
    type: input.type || 'main',
    email: String(input.email || '').toLowerCase(),
    displayName: input.displayName || null,
    pageId: input.pageId || null,
    parentSessionId: input.parentSessionId || null,
    createdAt: new Date(now).toISOString(),
    lastSeenAt: new Date(now).toISOString(),
    expiresAt: Number(input.expiresAt) || now,
    revokedAt: null,
    revokedBy: null,
    ip: input.ip || null,
    userAgent: input.userAgent || null
  };
  data = { ...data, sessions: [...data.sessions, session] };
  sessionsRepo.write(data);
  return session;
}

function findSession(id) {
  if (!id) return null;
  return sessionsRepo.read().sessions.find(session => session.id === id) || null;
}

function isRevoked(id) {
  const session = findSession(id);
  return Boolean(session && session.revokedAt);
}

function isActive(id) {
  const session = findSession(id);
  return Boolean(session && !session.revokedAt && Number(session.expiresAt) > Date.now());
}

function touch(id) {
  if (!id) return;
  const now = Date.now();
  if (now - (touchCache.get(id) || 0) < TOUCH_INTERVAL_MS) return;
  const data = sessionsRepo.read();
  const index = data.sessions.findIndex(session => session.id === id && !session.revokedAt);
  if (index === -1) return;
  const sessions = [...data.sessions];
  sessions[index] = { ...sessions[index], lastSeenAt: new Date(now).toISOString() };
  sessionsRepo.write({ ...data, sessions });
  touchCache.set(id, now);
}

function revoke(id, actor) {
  const data = sessionsRepo.read();
  const now = new Date().toISOString();
  let changed = false;
  const revokedIds = [];
  const sessions = data.sessions.map(session => {
    if (session.revokedAt || (session.id !== id && session.parentSessionId !== id)) return session;
    changed = true;
    revokedIds.push(session.id);
    return { ...session, revokedAt: now, revokedBy: actor || null };
  });
  if (changed) {
    sessionsRepo.write({ ...data, sessions });
    events.emit('sessions:revoked', revokedIds);
  }
  return changed;
}

function list(options = {}) {
  const now = Date.now();
  const data = prune(sessionsRepo.read(), now);
  if (data !== sessionsRepo.read()) sessionsRepo.write(data);
  return data.sessions
    .filter(session => !options.email || session.email === String(options.email).toLowerCase())
    .filter(session => !options.type || session.type === options.type)
    .filter(session => options.includeExpired || session.expiresAt > now)
    .filter(session => options.includeRevoked || !session.revokedAt)
    .sort((a, b) => String(b.lastSeenAt).localeCompare(String(a.lastSeenAt)));
}

function getStats() {
  const now = Date.now();
  const sessions = sessionsRepo.read().sessions;
  return {
    total: sessions.length,
    active: sessions.filter(session => !session.revokedAt && session.expiresAt > now).length,
    revoked: sessions.filter(session => Boolean(session.revokedAt)).length,
    mainActive: sessions.filter(session => session.type === 'main' && !session.revokedAt && session.expiresAt > now).length,
    proxyActive: sessions.filter(session => session.type === 'proxy' && !session.revokedAt && session.expiresAt > now).length
  };
}

module.exports = { createSession, events, findSession, getStats, isActive, isRevoked, list, revoke, touch };
