const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { AUDIT_DIR, operations } = require('../config');

const SENSITIVE_KEY_RE = /password|secret|token|authorization|cookie|header.?value/i;

function sanitize(value, depth = 0) {
  if (depth > 6) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 100).map(item => sanitize(item, depth + 1));
  if (!value || typeof value !== 'object') {
    return typeof value === 'string' && value.length > 1000 ? value.slice(0, 1000) + '…' : value;
  }
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    result[key] = SENSITIVE_KEY_RE.test(key) ? '[REDACTED]' : sanitize(child, depth + 1);
  }
  return result;
}

function auditFileFor(date = new Date()) {
  const stamp = date.toISOString().slice(0, 7);
  return path.join(AUDIT_DIR, `audit-${stamp}.jsonl`);
}

function clientIp(req) {
  return String(req && req.headers && req.headers['x-forwarded-for'] || req && req.socket && req.socket.remoteAddress || '')
    .split(',')[0].trim();
}

function record(event = {}) {
  try {
    fs.mkdirSync(AUDIT_DIR, { recursive: true });
    const req = event.req;
    const entry = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      actor: event.actor || (req && req.user && req.user.email) || null,
      sessionId: event.sessionId || (req && req.user && req.user.sid) || null,
      action: event.action || 'unknown',
      resourceType: event.resourceType || null,
      resourceId: event.resourceId || null,
      outcome: event.outcome || 'success',
      statusCode: event.statusCode || null,
      ip: event.ip || clientIp(req) || null,
      userAgent: event.userAgent || (req && req.headers && req.headers['user-agent']) || null,
      details: sanitize(event.details || {})
    };
    const file = auditFileFor();
    const fd = fs.openSync(file, 'a', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(entry) + '\n', 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    pruneOldFiles();
    return entry;
  } catch (error) {
    console.error('写入审计日志失败:', error.message);
    return null;
  }
}

let lastPruneAt = 0;
function pruneOldFiles(now = Date.now()) {
  if (now - lastPruneAt < 60 * 60 * 1000) return;
  lastPruneAt = now;
  if (!fs.existsSync(AUDIT_DIR)) return;
  const cutoff = now - operations.audit_retention_days * 24 * 60 * 60 * 1000;
  for (const entry of fs.readdirSync(AUDIT_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || !/^audit-\d{4}-\d{2}\.jsonl$/.test(entry.name)) continue;
    const file = path.join(AUDIT_DIR, entry.name);
    try {
      if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
    } catch { /* ignore */ }
  }
}

function query(options = {}) {
  if (!fs.existsSync(AUDIT_DIR)) return [];
  const limit = Math.min(Math.max(Number(options.limit) || 100, 1), 1000);
  const files = fs.readdirSync(AUDIT_DIR)
    .filter(name => /^audit-\d{4}-\d{2}\.jsonl$/.test(name))
    .sort().reverse();
  const result = [];
  for (const name of files) {
    const lines = fs.readFileSync(path.join(AUDIT_DIR, name), 'utf8').split('\r\n').join('\n').split('\n').filter(Boolean).reverse();
    for (const line of lines) {
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (options.actor && !String(entry.actor || '').toLowerCase().includes(String(options.actor).toLowerCase())) continue;
      if (options.action && !String(entry.action || '').includes(String(options.action))) continue;
      if (options.outcome && entry.outcome !== options.outcome) continue;
      if (options.before && entry.timestamp >= options.before) continue;
      if (options.after && entry.timestamp <= options.after) continue;
      result.push(entry);
      if (result.length >= limit) return result;
    }
  }
  return result;
}

function getStats() {
  if (!fs.existsSync(AUDIT_DIR)) return { files: 0, bytes: 0 };
  const files = fs.readdirSync(AUDIT_DIR).filter(name => name.endsWith('.jsonl'));
  return {
    files: files.length,
    bytes: files.reduce((sum, name) => {
      try { return sum + fs.statSync(path.join(AUDIT_DIR, name)).size; } catch { return sum; }
    }, 0)
  };
}

module.exports = { getStats, query, record, sanitize };
