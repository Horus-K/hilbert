const fs = require('fs');
const path = require('path');
const os = require('os');
const pkg = require('../../package.json');
const config = require('../config');
const pagesRepo = require('../repositories/pages.repository');
const groupsRepo = require('../repositories/groups.repository');
const rolesRepo = require('../repositories/roles.repository');
const backup = require('./backup.service');
const audit = require('./audit.service');
const sessions = require('./session-registry.service');
const { getEncryptionStatus } = require('../utils/secret-crypto');
const { isHostRoutingEnabled } = require('../utils/proxy-origin');

function dataWritable() {
  const probe = path.join(config.DATA_DIR, `.health-${process.pid}-${Date.now()}`);
  try {
    fs.mkdirSync(config.DATA_DIR, { recursive: true });
    fs.writeFileSync(probe, 'ok', { mode: 0o600 });
    fs.unlinkSync(probe);
    return true;
  } catch {
    try { fs.unlinkSync(probe); } catch { /* ignore */ }
    return false;
  }
}

function getStatus() {
  const pages = pagesRepo.read();
  const groups = groupsRepo.read();
  const roleData = rolesRepo.read();
  const memory = process.memoryUsage();
  return {
    timestamp: new Date().toISOString(),
    app: {
      version: pkg.version,
      uptimeSeconds: Math.floor(process.uptime()),
      node: process.version,
      pid: process.pid,
      platform: `${process.platform}/${process.arch}`,
      hostname: os.hostname()
    },
    memory: {
      rss: memory.rss,
      heapUsed: memory.heapUsed,
      heapTotal: memory.heapTotal
    },
    data: {
      directory: config.DATA_DIR,
      writable: dataWritable(),
      pages: pages.length,
      groups: groups.length,
      roles: roleData.roles.length,
      assignments: roleData.assignments.length
    },
    proxy: {
      routingMode: isHostRoutingEnabled() ? 'host' : 'mount',
      hostTemplate: config.external_proxy.public_host_template || null,
      protocol: config.external_proxy.public_protocol || null,
      listenPort: config.external_proxy.listen_port,
      publicPort: config.external_proxy.public_port,
      outboundProxyConfigured: Boolean(config.page_proxy)
    },
    auth: {
      mode: config.debug.enabled ? 'debug' : 'google',
      googleConfigured: Boolean(config.google.client_id && config.google.client_secret && config.google.oauth2_redirect_uri),
      allowedDomain: config.google.allowed_domain || null,
      adminCount: config.ADMIN_EMAILS.length
    },
    encryption: getEncryptionStatus(),
    backups: {
      count: backup.listBackups().length,
      retention: config.operations.backup_retention
    },
    audit: {
      ...audit.getStats(),
      retentionDays: config.operations.audit_retention_days
    },
    sessions: sessions.getStats()
  };
}

module.exports = { getStatus };
