const express = require('express');
const path = require('path');

const app = express();
const host = process.env.GOOGLE_AUTH_TEST_HOST || '0.0.0.0';
const port = Number(process.env.GOOGLE_AUTH_TEST_PORT || 4000);
const basePath = '/web';

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function decodeHeader(value) {
  if (!value || !value.includes('%')) return value || null;
  try {
    return decodeURIComponent(value);
  } catch (_) {
    return value;
  }
}

function getGoogleAuth(req) {
  const value = req.get('X-Forwarded-Google-Auth');
  if (!value) return null;
  try {
    return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch (_) {
    return null;
  }
}

function maskToken(value) {
  if (!value) return null;
  return value.length <= 12 ? '***' : value.slice(0, 6) + '...' + value.slice(-4);
}

function getIdentity(req) {
  const emailFromMailHeader = req.get('X-Forwarded-Mail');
  const emailFromUserHeader = req.get('X-Forwarded-User');
  const groups = decodeHeader(req.get('X-Forwarded-Groups')) || '';
  return {
    id: decodeHeader(req.get('X-Forwarded-User-Id')),
    email: decodeHeader(emailFromMailHeader || emailFromUserHeader),
    displayName: decodeHeader(req.get('X-Forwarded-DisplayName')),
    groups: groups
      .split(',')
      .map(group => group.trim())
      .filter(Boolean),
    picture: decodeHeader(req.get('X-Forwarded-User-Picture')),
    googleAuth: getGoogleAuth(req),
    googleAccessToken: maskToken(req.get('X-Forwarded-Google-Access-Token')),
    sourceHeaders: {
      id: 'X-Forwarded-User-Id',
      email: emailFromMailHeader ? 'X-Forwarded-Mail' : 'X-Forwarded-User',
      displayName: 'X-Forwarded-DisplayName',
      groups: 'X-Forwarded-Groups',
      picture: 'X-Forwarded-User-Picture',
      googleAuth: 'X-Forwarded-Google-Auth',
      googleAccessToken: 'X-Forwarded-Google-Access-Token'
    }
  };
}

function renderPage(identity) {
  const hasIdentity = Boolean(identity.email || identity.id);
  const message = hasIdentity
    ? '以下身份信息由 Hilbert 完成 Google 登录后，通过代理请求头传入。'
    : '未收到 Hilbert 的身份请求头。请通过 Hilbert 的 /web/ 恒等映射打开此页面。';
  return '<!doctype html>\n' +
    '<html lang="zh-CN"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Google Auth 身份透传</title>' +
    '<link rel="stylesheet" href="/web/styles.css"></head><body>' +
    '<main><p class="eyebrow">HILBERT IDENTITY FORWARDING</p>' +
    '<h1>Google Auth 身份信息</h1>' +
    '<p class="message">' + escapeHtml(message) + '</p>' +
    '<pre>' + escapeHtml(JSON.stringify(identity, null, 2)) + '</pre>' +
    '</main></body></html>';
}

app.get(basePath, (req, res, next) => {
  if (req.originalUrl.split('?')[0] !== basePath) return next();
  return res.redirect(302, basePath + '/');
});

app.get(basePath + '/styles.css', (req, res) => {
  res.sendFile(path.join(__dirname, 'styles.css'));
});

app.get(basePath + '/', (req, res) => {
  res.send(renderPage(getIdentity(req)));
});

app.use((req, res) => res.status(404).send('Not found'));

app.listen(port, host, () => {
  console.log('Google Auth 身份透传测试页已启动: http://' + host + ':' + port + basePath + '/');
});
