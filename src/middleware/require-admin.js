const { isAdmin } = require('../services/rbac.service');

/**
 * 管理员校验中间件
 */
function requireAdmin(req, res, next) {
  if (isAdmin(req.user.email)) return next();
  return res.status(403).json({ error: '需要超级管理员权限' });
}

module.exports = requireAdmin;
