const express = require('express');
const router = express.Router();
const requireAdmin = require('../middleware/require-admin');
const { AppError } = require('../utils/errors');
const statusService = require('../services/system-status.service');
const diagnostics = require('../services/diagnostics.service');
const backup = require('../services/backup.service');
const audit = require('../services/audit.service');
const sessions = require('../services/session-registry.service');
const pagesService = require('../services/pages.service');

router.use(requireAdmin);

router.get('/status', (req, res) => {
  res.json(statusService.getStatus());
});

router.get('/audit', (req, res) => {
  res.json(audit.query(req.query || {}));
});

router.get('/backups', (req, res) => {
  res.json(backup.listBackups());
});

router.post('/backups', (req, res) => {
  const created = backup.createBackup({ reason: 'manual' });
  audit.record({ req, action: 'backup.create', resourceType: 'backup', resourceId: created.name, details: created });
  res.status(201).json(created);
});

router.get('/backups/:name/download', (req, res) => {
  const file = backup.backupPath(req.params.name);
  audit.record({ req, action: 'backup.download', resourceType: 'backup', resourceId: req.params.name });
  res.download(file, req.params.name);
});

router.post('/backups/:name/restore', (req, res) => {
  const result = backup.restoreBackup(req.params.name, req.body || {});
  audit.record({ req, action: 'backup.restore', resourceType: 'backup', resourceId: req.params.name, details: result });
  res.json(result);
});

router.delete('/backups/:name', (req, res) => {
  const result = backup.deleteBackup(req.params.name);
  audit.record({ req, action: 'backup.delete', resourceType: 'backup', resourceId: req.params.name });
  res.json(result);
});

router.get('/sessions', (req, res) => {
  const list = sessions.list({
    email: req.query.email,
    type: req.query.type,
    includeExpired: req.query.includeExpired === 'true',
    includeRevoked: req.query.includeRevoked === 'true'
  }).map(session => ({ ...session, current: session.id === req.user.sid }));
  res.json(list);
});

router.post('/sessions/:id/revoke', (req, res) => {
  if (!sessions.revoke(req.params.id, req.user.email)) throw new AppError('会话不存在或已撤销', 404);
  audit.record({ req, action: 'session.revoke', resourceType: 'session', resourceId: req.params.id });
  res.json({ revoked: req.params.id });
});

router.post('/diagnostics/pages/:id', async (req, res, next) => {
  try {
    const page = pagesService.getPageById(req.params.id);
    if (page.type !== 'link') throw new AppError('仅外部链接页面支持代理诊断');
    const result = await diagnostics.diagnosePage(page, req.user);
    audit.record({
      req,
      action: 'proxy.diagnose',
      resourceType: 'page',
      resourceId: page.id,
      outcome: result.ok ? 'success' : 'failure',
      details: result
    });
    res.status(result.ok ? 200 : 502).json(result);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
