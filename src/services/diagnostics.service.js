const http = require('http');
const https = require('https');
const { external_proxy: proxyConfig } = require('../../config');
const { getPageRequestAgent, applyDnsOverride } = require('../proxy/agents');
const { applyAuthHeaders } = require('../proxy/auth-injector');
const { assertTargetAllowed } = require('../proxy/target-policy');

const MAX_REDIRECTS = 5;
const MAX_INSPECT_BYTES = 256 * 1024;

function safeTarget(url) {
  return `${url.protocol}//${url.host}${url.pathname}`;
}

function browserOrigin(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'ws:') url.protocol = 'http:';
    if (url.protocol === 'wss:') url.protocol = 'https:';
    return ['http:', 'https:'].includes(url.protocol) ? url.origin : '';
  } catch {
    return '';
  }
}

function referencedOrigins(body) {
  const origins = new Set();
  for (const match of String(body || '').matchAll(/\b(?:https?|wss?):\/\/[^\s"'<>`)]+/gi)) {
    const origin = browserOrigin(match[0]);
    if (origin) origins.add(origin);
  }
  return [...origins].sort();
}

async function requestPage(page, user, targetUrl) {
  const resolvedAddresses = await assertTargetAllowed(page, targetUrl);
  const headers = {
    accept: '*/*',
    'accept-encoding': 'identity',
    'user-agent': 'Hilbert-Diagnostics/1.0'
  };
  await applyAuthHeaders(page, headers, user, targetUrl);
  const networkUrl = new URL(targetUrl.href);
  const dnsOptions = applyDnsOverride(page, networkUrl, targetUrl, headers, resolvedAddresses[0]);
  const lib = networkUrl.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const request = lib.request(networkUrl, {
      method: 'GET',
      headers,
      agent: getPageRequestAgent(networkUrl, page),
      ...dnsOptions
    }, response => {
      const chunks = [];
      let bytes = 0;
      response.on('data', chunk => {
        if (bytes >= MAX_INSPECT_BYTES) return;
        const remaining = MAX_INSPECT_BYTES - bytes;
        chunks.push(chunk.subarray(0, remaining));
        bytes += Math.min(chunk.length, remaining);
      });
      response.on('end', () => {
        const certificate = response.socket && response.socket.getPeerCertificate
          ? response.socket.getPeerCertificate()
          : null;
        resolve({
          statusCode: response.statusCode,
          statusMessage: response.statusMessage,
          headers: response.headers,
          body: Buffer.concat(chunks).toString('utf8'),
          resolvedAddresses,
          certificate
        });
      });
      response.on('error', reject);
    });
    request.setTimeout(proxyConfig.timeout_ms, () => {
      request.destroy(new Error(`连接超时 (${proxyConfig.timeout_ms}ms)`));
    });
    request.on('error', reject);
    request.end();
  });
}

async function diagnosePage(page, user) {
  const startedAt = Date.now();
  const initialUrl = new URL(page.url);
  const knownOrigins = new Set([initialUrl.origin, ...Object.values(page.origins || {})]);
  const unknownOrigins = new Set();
  const redirects = [];
  let targetUrl = initialUrl;
  let response;
  let setsCookies = false;

  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      response = await requestPage(page, user, targetUrl);
      setsCookies ||= Boolean(response.headers['set-cookie']);
      const location = response.headers.location;
      if (!location || response.statusCode < 300 || response.statusCode >= 400) break;

      const nextUrl = new URL(location, targetUrl);
      const nextOrigin = browserOrigin(nextUrl.href);
      redirects.push({ statusCode: response.statusCode, target: safeTarget(nextUrl) });
      if (!knownOrigins.has(nextOrigin)) {
        if (nextOrigin) unknownOrigins.add(nextOrigin);
        break;
      }
      if (redirects.length >= MAX_REDIRECTS) break;
      targetUrl = nextUrl;
    }

    for (const origin of referencedOrigins(response.body)) {
      if (!knownOrigins.has(origin)) unknownOrigins.add(origin);
    }

    const certificate = response.certificate;
    const recommendation = unknownOrigins.size
      ? 'origin-map'
      : redirects.length >= MAX_REDIRECTS
        ? 'new-tab'
        : setsCookies && !page.auth && page.sessionMode !== 'browser'
          ? 'browser'
          : page.sessionMode === 'browser' ? 'browser' : 'server';

    return {
      ok: response.statusCode >= 200 && response.statusCode < 500,
      durationMs: Date.now() - startedAt,
      target: safeTarget(targetUrl),
      resolvedAddresses: response.resolvedAddresses,
      resolveIp: page.resolveIp || null,
      statusCode: response.statusCode,
      statusMessage: response.statusMessage,
      contentType: response.headers['content-type'] || null,
      server: response.headers.server || null,
      redirects,
      setsCookies,
      unknownOrigins: [...unknownOrigins].sort(),
      recommendation,
      tls: certificate && Object.keys(certificate).length ? {
        subject: certificate.subject && certificate.subject.CN || null,
        issuer: certificate.issuer && certificate.issuer.CN || null,
        validFrom: certificate.valid_from || null,
        validTo: certificate.valid_to || null
      } : null
    };
  } catch (error) {
    return {
      ok: false,
      durationMs: Date.now() - startedAt,
      target: safeTarget(targetUrl),
      resolvedAddresses: [],
      resolveIp: page.resolveIp || null,
      redirects,
      setsCookies,
      unknownOrigins: [...unknownOrigins].sort(),
      recommendation: 'new-tab',
      error: error.message,
      code: error.code || (error.message.includes('目标地址') || error.message.includes('云元数据')
        ? 'TARGET_POLICY'
        : null)
    };
  }
}

module.exports = { browserOrigin, diagnosePage, referencedOrigins };
