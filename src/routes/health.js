const express = require('express');

// 健康检查路由（挂载于 /hilbert-api/health）
const healthRouter = express.Router();
healthRouter.get('/', (req, res) => {
  res.json({ status: 'ok' });
});

// 版本号路由（挂载于 /hilbert-api/version）
const versionRouter = express.Router();
versionRouter.get('/', (req, res) => {
  const pkg = require('../../package.json');
  res.json({ version: pkg.version });
});

module.exports = { healthRouter, versionRouter };
