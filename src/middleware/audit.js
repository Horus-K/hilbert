const audit = require('../services/audit.service');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function actionFor(req) {
  const path = String(req.originalUrl || req.url || '').split('?')[0];
  return `${req.method} ${path}`;
}

function auditMutations(req, res, next) {
  const url = String(req.originalUrl || '');
  if (SAFE_METHODS.has(req.method) || !url.startsWith('/hilbert-api/') ||
      url.startsWith('/hilbert-api/ops/') || url.startsWith('/hilbert-api/logout')) return next();
  res.on('finish', () => {
    audit.record({
      req,
      action: actionFor(req),
      outcome: res.statusCode < 400 ? 'success' : 'failure',
      statusCode: res.statusCode,
      details: { body: req.body || null }
    });
  });
  next();
}

module.exports = auditMutations;
