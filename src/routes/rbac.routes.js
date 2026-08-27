const express = require('express');
const router = express.Router();
const requireAdmin = require('../middleware/require-admin');
const rbacService = require('../services/rbac.service');

router.get('/roles', requireAdmin, (req, res) => {
  res.json(rbacService.getRoles());
});

router.post('/roles', requireAdmin, (req, res) => {
  res.status(201).json(rbacService.createRole(req.body || {}));
});

router.put('/roles/:id', requireAdmin, (req, res) => {
  res.json(rbacService.updateRole(req.params.id, req.body || {}));
});

router.delete('/roles/:id', requireAdmin, (req, res) => {
  res.json(rbacService.deleteRole(req.params.id));
});

router.get('/assignments', requireAdmin, (req, res) => {
  res.json(rbacService.getAssignments());
});

router.post('/assignments', requireAdmin, (req, res) => {
  res.status(201).json(rbacService.createAssignment(req.body || {}));
});

router.delete('/assignments/:email/:roleId', requireAdmin, (req, res) => {
  res.json(rbacService.deleteAssignment(req.params.email, req.params.roleId));
});

module.exports = router;
