const http = require('http');
const https = require('https');
const zlib = require('zlib');
const { httpAgent, httpsAgent, httpsAgentNoVerify, applyDnsOverride } = require('./agents');
const { applyAuthHeaders, clearSession } = require('./auth-injector');
const { rewriteHtml, rewriteCss } = require('./rewriter');

/**
 * 计算代理请求的实际目标地址
 */
function resolveProxyTarget(page, originalUrl, stripPrefix = '') {
  const base = new URL(page.url);
  const basePath = base.pathname.replace(/\/+$/, '');
  const fileLike = /\/[^/]*\.[^/]*$/.test(basePath);

  let rest = stripPrefix && originalUrl.startsWith(stripPrefix)
    ? originalUrl.slice(stripPrefix.length)
    : originalUrl;
  if (!rest.startsWith('/')) rest = '/' + rest;
  const qIdx = rest.indexOf('?');
  const restPath = qIdx === -1 ? rest : rest.slice(0, qIdx);
  const restQuery = qIdx === -1 ? '' : rest.slice(qIdx + 1);
  const query = [...new Set([
    ...base.search.replace(/^\?/, '').split('&'),
    ...restQuery.split('&')
  ].filter(Boolean))].join('&');

  let targetPath;
  if (stripPrefix) {
    targetPath = restPath === '/' ? (basePath || '/') : restPath;
  } else if (restPath === '/') {
    targetPath = basePath || '/';
  } else {
    targetPath = restPath;
  }

  return {
    base, basePath, fileLike, restPath, query,
    target: base.origin + targetPath + (query ? '?' + query : '')
  };
}

/**
 * 代理转发主体
 */
function handleProxyRequest(page, req, res, matchedPath, mountPrefix) {
  // 记录路径归属，供 Referer 兜底的归属链规则使用
  const { recordProxyPath } = require('./route-manager');
  recordProxyPath(page, req.originalUrl.split('?')[0]);

  const resolved = resolveProxyTarget(page, req.originalUrl, mountPrefix || '');
  const { base, target } = resolved;
  const rewritePrefix = mountPrefix || '';

  // 页面 URL 指向深层路径时，对入口根请求先跳转到页面 URL 路径
  const reqPath = req.originalUrl.split('?')[0];
  const atEntryRoot = !mountPrefix && (matchedPath
    ? (reqPath === matchedPath || reqPath === matchedPath + '/')
    : resolved.restPath === '/');
  if (atEntryRoot && resolved.basePath && !resolved.fileLike &&
    (!matchedPath || matchedPath.length < resolved.basePath.length)) {
    return res.redirect(302, resolved.basePath
      + (resolved.query ? '?' + resolved.query : ''));
  }

  const auth = page.auth;
  const lib = base.protocol === 'https:' ? https : http;
  const appUrl = (req.headers['x-forwarded-proto'] || 'http') + '://' + req.headers.host + rewritePrefix + '/';

  // 缓存请求体
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const bodyBuf = Buffer.concat(chunks);
    forward(false).catch(err => {
      if (!res.headersSent) res.status(502).send('代理请求失败: ' + err.message);
      else res.end();
    });

    async function forward(isRetry) {
      const headers = { ...req.headers };
      delete headers.host;
      headers.origin = base.origin;
      headers.referer = base.origin + '/';
      delete headers['transfer-encoding'];
      headers['accept-encoding'] = 'gzip, deflate, br';
      headers['content-length'] = bodyBuf.length;

      await applyAuthHeaders(page, headers);

      await new Promise((resolve, reject) => {
        const hasDnsOverride = !!(page && page.resolveIp);
        const agent = base.protocol === 'https:' ? (hasDnsOverride ? httpsAgentNoVerify : httpsAgent) : httpAgent;
        const targetUrl = new URL(target);
        const dnsOpts = applyDnsOverride(page, targetUrl, base, headers);
        const reqOpts = { method: req.method, headers, agent, ...dnsOpts };
        const proxyReq = lib.request(targetUrl, reqOpts, proxyRes => {
          // login 模式会话过期检测
          const expired = auth && auth.mode === 'login' && !isRetry && (
            proxyRes.statusCode === 401 ||
            ([301, 302, 303, 307, 308].includes(proxyRes.statusCode) &&
              /login/i.test(proxyRes.headers.location || ''))
          );
          if (expired) {
            proxyRes.resume();
            clearSession(page.id);
            resolve(forward(true));
            return;
          }
          const resHeaders = { ...proxyRes.headers };
          // 剥离 iframe 嵌入限制
          delete resHeaders['x-frame-options'];
          delete resHeaders['content-security-policy'];
          delete resHeaders['content-security-policy-report-only'];
          // 重写指向目标站的跳转
          if (resHeaders.location) {
            try {
              const loc = new URL(resHeaders.location, base.origin);
              if (loc.origin === base.origin) {
                resHeaders.location = rewritePrefix + loc.pathname + loc.search;
              }
            } catch { /* 非法 Location 保持原样 */ }
          }

          const contentType = String(resHeaders['content-type'] || '');
          const isHtml = /text\/html/.test(contentType);
          const rewrite = isHtml ? rewriteHtml : (rewritePrefix && /text\/css/.test(contentType)) ? rewriteCss : null;
          if (!rewrite) {
            // 无需重写：压缩响应原样透传
            res.writeHead(proxyRes.statusCode, resHeaders);
            proxyRes.pipe(res);
            proxyRes.on('end', resolve);
            proxyRes.on('error', reject);
            return;
          }
          // HTML/CSS 需文本重写：先解压再重写
          const encoding = String(resHeaders['content-encoding'] || '').toLowerCase();
          if (encoding && !/gzip|deflate|br/.test(encoding)) {
            proxyRes.resume();
            return reject(new Error(`目标站返回了无法解压的编码: ${encoding}`));
          }
          let src = proxyRes;
          if (encoding.includes('br')) {
            src = proxyRes.pipe(zlib.createBrotliDecompress());
          } else if (encoding.includes('gzip') || encoding.includes('deflate')) {
            src = proxyRes.pipe(zlib.createUnzip());
          }
          const bufs = [];
          src.on('data', c => bufs.push(c));
          src.on('end', () => {
            const rewritten = isHtml
              ? rewriteHtml(Buffer.concat(bufs).toString('utf8'), rewritePrefix, appUrl)
              : rewriteCss(Buffer.concat(bufs).toString('utf8'), rewritePrefix);
            delete resHeaders['content-length'];
            delete resHeaders['content-encoding'];
            delete resHeaders['transfer-encoding'];
            resHeaders['content-length'] = Buffer.byteLength(rewritten);
            res.writeHead(proxyRes.statusCode, resHeaders);
            res.end(rewritten);
            resolve();
          });
          src.on('error', reject);
          proxyRes.on('error', reject);
        });
        proxyReq.on('error', reject);
        proxyReq.end(bodyBuf.length ? bodyBuf : undefined);
      });
    }
  });
}

module.exports = { handleProxyRequest, resolveProxyTarget };
