const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const { DATA_DIR, external_proxy: proxyConfig } = require('../config');
const { getPageRequestAgent, applyDnsOverride } = require('../proxy/agents');
const { assertTargetAllowed } = require('../proxy/target-policy');

const LOGO_DIR = path.join(DATA_DIR, 'page-icons');
const MAX_LOGO_BYTES = 1024 * 1024;

function logoFile(pageId) {
  return path.join(LOGO_DIR, path.basename(pageId));
}

function deletePageLogo(pageId) {
  try { fs.unlinkSync(logoFile(pageId)); } catch { /* 缓存不存在 */ }
}

async function download(page, target, redirects = 0) {
  const url = new URL(target);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Logo 网址仅支持 http/https');
  const addresses = await assertTargetAllowed(page, url);
  const headers = { accept: 'image/*', 'accept-encoding': 'identity', 'user-agent': 'Hilbert-Logo/1.0' };
  const networkUrl = new URL(url.href);
  const dnsOptions = applyDnsOverride(page, networkUrl, url, headers, addresses[0]);
  const client = networkUrl.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const request = client.get(networkUrl, { headers, agent: getPageRequestAgent(networkUrl, page), ...dnsOptions }, response => {
      const chunks = [];
      let bytes = 0;
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > MAX_LOGO_BYTES) {
          reject(new Error('Logo 大小不能超过 1 MB'));
          return response.destroy();
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          if (redirects >= 3) return reject(new Error('Logo 重定向次数过多'));
          return resolve(download(page, new URL(response.headers.location, url).href, redirects + 1));
        }
        if (response.statusCode < 200 || response.statusCode >= 300) return reject(new Error(`Logo 请求失败 (${response.statusCode})`));
        const mimeType = String(response.headers['content-type'] || '').split(';')[0].toLowerCase();
        if (!mimeType.startsWith('image/')) return reject(new Error('Logo 响应不是支持的图片格式'));
        resolve({ body: Buffer.concat(chunks), mimeType });
      });
      response.on('error', reject);
    });
    request.setTimeout(proxyConfig.timeout_ms, () => request.destroy(new Error(`Logo 获取超时 (${proxyConfig.timeout_ms}ms)`)));
    request.on('error', reject);
  });
}

async function cachePageLogo(page, source) {
  const target = String(source || '').trim() || (page.url ? new URL('/favicon.ico', page.url).href : '');
  deletePageLogo(page.id);
  if (!target) return { cached: false, source: '' };
  try {
    const result = await download(page, target);
    fs.mkdirSync(LOGO_DIR, { recursive: true });
    fs.writeFileSync(logoFile(page.id), result.body);
    return { cached: true, mimeType: result.mimeType, source: target };
  } catch (error) {
    return { cached: false, source: target, warning: error.message };
  }
}

module.exports = { cachePageLogo, deletePageLogo, logoFile };
