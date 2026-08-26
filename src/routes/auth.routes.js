const express = require('express');
const router = express.Router();
const authService = require('../services/auth.service');
const audit = require('../services/audit.service');
const { setAuthCookie } = require('../middleware/auth');

router.get('/google', (req, res) => {
  if (authService.isDebugModeEnabled()) return res.redirect('/auth/debug');
  const state = authService.generateStateToken();
  res.redirect(authService.buildAuthUrl(state));
});

router.get('/debug', (req, res) => {
  if (!authService.isDebugModeEnabled()) return res.status(404).send('Debug mode is disabled');
  const user = authService.getDebugUser();
  const issued = authService.issueMainSession(user, req);
  setAuthCookie(req, res, issued.token);
  audit.record({ req, actor: user.email, sessionId: issued.session.id, action: 'auth.debug.login' });
  return res.redirect('/');
});

router.get('/config', (req, res) => {
  const user = authService.getDebugUser();
  res.json({
    debugMode: authService.isDebugModeEnabled(),
    debugUser: user ? {
      email: user.email,
      name: user.name,
      displayName: user.displayName,
      groups: user.groups,
      picture: user.picture
    } : null
  });
});

module.exports = router;
