const dns = require('dns').promises;
const http = require('http');
const https = require('https');
const { getPageRequestAgent, applyDnsOverride } = require('../proxy/agents');
const { applyAuthHeaders } = require('../proxy/auth-injector');

const TIMEOUT_MS = 10000;

async function diagnosePage(page, user) {
  const startedAt = Date.now();
  const targetUrl = new URL(page.url);
  let resolvedAddresses = [];
  try {
    if (page.resolveIp) resolvedAddresses = [page.resolveIp];
    else resolvedAddresses = (await dns.lookup(targetUrl.hostname, { all: true })).map(item => item.address);
  } catch { /* HTTP request will provide the actionable error */ }

  const headers = {
    accept: '*/*',
    'accept-encoding': 'identity',
    'user-agent': 'Hilbert-Diagnostics/1.0'
  };
  await applyAuthHeaders(page, headers, user, targetUrl);
  const networkUrl = new URL(targetUrl.href);
  const dnsOptions = applyDnsOverride(page, networkUrl, targetUrl, headers);
  const lib = networkUrl.protocol === 'https:' ? https : http;

  return new Promise(resolve => {
    const request = lib.request(networkUrl, {
      method: 'GET',
      headers,
      agent: getPageRequestAgent(networkUrl, page),
      ...dnsOptions
    }, response => {
      const certificate = response.socket && response.socket.getPeerCertificate
        ? response.socket.getPeerCertificate()
        : null;
      response.resume();
      response.on('end', () => resolve({
        ok: response.statusCode >= 200 && response.statusCode < 500,
        durationMs: Date.now() - startedAt,
        target: `${targetUrl.protocol}//${targetUrl.host}${targetUrl.pathname}`,
        resolvedAddresses,
        resolveIp: page.resolveIp || null,
        statusCode: response.statusCode,
        statusMessage: response.statusMessage,
        contentType: response.headers['content-type'] || null,
        server: response.headers.server || null,
        tls: certificate && Object.keys(certificate).length ? {
          subject: certificate.subject && certificate.subject.CN || null,
          issuer: certificate.issuer && certificate.issuer.CN || null,
          validFrom: certificate.valid_from || null,
          validTo: certificate.valid_to || null,
          authorized: response.socket.authorized,
          authorizationError: response.socket.authorizationError || null
        } : null
      }));
    });
    request.setTimeout(TIMEOUT_MS, () => request.destroy(new Error(`连接超时 (${TIMEOUT_MS}ms)`)));
    request.on('error', error => resolve({
      ok: false,
      durationMs: Date.now() - startedAt,
      target: `${targetUrl.protocol}//${targetUrl.host}${targetUrl.pathname}`,
      resolvedAddresses,
      resolveIp: page.resolveIp || null,
      error: error.message,
      code: error.code || null
    }));
    request.end();
  });
}

module.exports = { diagnosePage };
