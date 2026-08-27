const express = require('express');
const router = express.Router();
const authService = require('../services/auth.service');
const audit = require('../services/audit.service');
const { setAuthCookie } = require('../middleware/auth');

router.get('/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!authService.verifyStateToken(state)) {
      audit.record({ req, action: 'auth.google.callback', outcome: 'failure', statusCode: 403, details: { reason: 'invalid_state' } });
      return res.status(403).send('Invalid state parameter');
    }
    if (!code) {
      audit.record({ req, action: 'auth.google.callback', outcome: 'failure', statusCode: 400, details: { reason: 'missing_code' } });
      return res.status(400).send('Authorization code missing');
    }

    const tokenData = await authService.exchangeCodeForToken(code);
    const user = await authService.fetchUserInfo(tokenData.access_token);
    user.googleAccessToken = tokenData.access_token;
    if (Number.isFinite(Number(tokenData.expires_in))) {
      user.googleAccessTokenExpiresAt = Date.now() + Number(tokenData.expires_in) * 1000;
    }

    const denyReason = authService.checkLoginPermission(user.email);
    if (denyReason) {
      audit.record({ req, actor: user.email, action: 'auth.google.login', outcome: 'failure', statusCode: 403, details: { reason: denyReason } });
      return res.status(403).send(denyReason);
    }

    const issued = authService.issueMainSession(user, req);
    setAuthCookie(req, res, issued.token);
    audit.record({ req, actor: user.email, sessionId: issued.session.id, action: 'auth.google.login' });
    res.redirect('/');
  } catch (err) {
    console.error('Callback error:', err);
    audit.record({ req, action: 'auth.google.login', outcome: 'failure', statusCode: 500, details: { error: err.message } });
    res.status(500).send('Authentication failed');
  }
});

module.exports = router;
