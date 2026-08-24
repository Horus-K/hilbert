const http = require('http');
const https = require('https');
const zlib = require('zlib');
const { getPageRequestAgent, applyDnsOverride } = require('./agents');
const { applyAuthHeaders, clearSession, resolveLoginUrl } = require('./auth-injector');
const { storeResponseCookies } = require('./cookie-jar');
const { buildUpstreamHeaders, stripFrameAncestors, stripHopByHopHeaders } = require('./header-utils');
const { rewriteHtml, rewriteCss, rewriteUrl } = require('./rewriter');

function splitPathAndQuery(originalUrl) {
  const qIdx = originalUrl.indexOf('?');
  return {
    pathname: qIdx === -1 ? originalUrl : originalUrl.slice(0, qIdx),
    search: qIdx === -1 ? '' : originalUrl.slice(qIdx)
  };
}

/**
 * 公开 URL 在挂载前缀之后完整镜像上游 pathname，使普通相对 URL 无需猜测即可保持语义。
 */
function resolveProxyTarget(page, originalUrl, stripPrefix = '') {
  const base = new URL(page.url);
  const incoming = splitPathAndQuery(originalUrl);
  let restPath = incoming.pathname || '/';
  const prefixMatched = stripPrefix &&
    (restPath === stripPrefix || restPath.startsWith(stripPrefix + '/'));
  if (prefixMatched) restPath = restPath.slice(stripPrefix.length) || '/';
  if (!restPath.startsWith('/')) restPath = '/' + restPath;

  const atMountRoot = Boolean(stripPrefix && prefixMatched && restPath === '/');
  const targetUrl = new URL(base.origin);
  targetUrl.pathname = atMountRoot ? base.pathname : restPath;
  targetUrl.search = atMountRoot && !incoming.search ? base.search : incoming.search;

  return {
    base,
    basePath: base.pathname,
    restPath,
    target: targetUrl.href,
    targetUrl
  };
}

function responseIndicatesExpiredAuth(page, proxyRes, targetUrl) {
  const auth = page.auth;
  if (!auth || !['login', 'oauth'].includes(auth.mode)) return false;
  const expiredStatuses = auth.expiredStatuses || [401];
  if (expiredStatuses.includes(proxyRes.statusCode)) return true;
  if (auth.mode !== 'login' || !proxyRes.headers.location) return false;
  try {
    const location = new URL(proxyRes.headers.location, targetUrl);
    const loginUrl = resolveLoginUrl(page, new URL(page.url));
    return location.origin === loginUrl.origin && location.pathname === loginUrl.pathname;
  } catch {
    return false;
  }
}

function rewriteRefreshHeader(value, context) {
  return String(value).replace(/(\burl\s*=\s*)([^;]+)$/i, (full, prefix, url) => {
    return prefix + rewriteUrl(url.trim().replace(/^['"]|['"]$/g, ''), context);
  });
}

/**
 * 代理转发主体。matchedPath 参数仅为旧调用兼容保留；所有页面统一使用 mountPrefix。
 */
function handleProxyRequest(page, req, res, matchedPath, mountPrefix) {
  const rewritePrefix = mountPrefix || '';
  const resolved = resolveProxyTarget(page, req.originalUrl || req.url, rewritePrefix);
  const { base, targetUrl } = resolved;
  const auth = page.auth;
  const lib = targetUrl.protocol === 'https:' ? https : http;

  const { recordProxyPath } = require('./route-manager');
  recordProxyPath(page, (req.originalUrl || req.url).split('?')[0], req.user);

  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    const bodyBuffer = Buffer.concat(chunks);
    forward(false).catch(err => {
      if (!res.headersSent) res.status(502).send('代理请求失败: ' + err.message);
      else res.end();
    });

    async function forward(isRetry) {
      const logicalTargetUrl = new URL(targetUrl.href);
      const headers = buildUpstreamHeaders(req, base, rewritePrefix);
      if (bodyBuffer.length || req.headers['content-length'] !== undefined) {
        headers['content-length'] = String(bodyBuffer.length);
      } else {
        delete headers['content-length'];
      }
      await applyAuthHeaders(page, headers, req.user, logicalTargetUrl);

      await new Promise((resolve, reject) => {
        const networkUrl = new URL(logicalTargetUrl.href);
        const dnsOptions = applyDnsOverride(page, networkUrl, base, headers);
        const requestOptions = {
          method: req.method,
          headers,
          agent: getPageRequestAgent(networkUrl, page),
          ...dnsOptions
        };

        const proxyReq = lib.request(networkUrl, requestOptions, proxyRes => {
          if (!isRetry && responseIndicatesExpiredAuth(page, proxyRes, logicalTargetUrl)) {
            proxyRes.resume();
            clearSession(page.id, req.user);
            resolve(forward(true));
            return;
          }

          storeResponseCookies(page, req.user, logicalTargetUrl, proxyRes.headers['set-cookie']);
          const responseHeaders = stripHopByHopHeaders(proxyRes.headers);
          delete responseHeaders['set-cookie'];
          delete responseHeaders['x-frame-options'];
          for (const name of ['content-security-policy', 'content-security-policy-report-only']) {
            if (!responseHeaders[name]) continue;
            const rewrittenCsp = stripFrameAncestors(responseHeaders[name]);
            if (rewrittenCsp) responseHeaders[name] = rewrittenCsp;
            else delete responseHeaders[name];
          }

          const rewriteContext = {
            mountPrefix: rewritePrefix,
            upstreamOrigin: base.origin,
            upstreamUrl: logicalTargetUrl.href
          };
          if (responseHeaders.location) {
            try {
              responseHeaders.location = rewriteUrl(
                new URL(responseHeaders.location, logicalTargetUrl).href,
                rewriteContext
              );
            } catch {
              // 非法 Location 保持原样，由浏览器按原始响应处理。
            }
          }
          if (responseHeaders.refresh) {
            responseHeaders.refresh = rewriteRefreshHeader(responseHeaders.refresh, rewriteContext);
          }

          const contentType = String(responseHeaders['content-type'] || '').toLowerCase();
          const charsetMatch = contentType.match(/charset\s*=\s*([^;\s]+)/i);
          const charset = charsetMatch ? charsetMatch[1].replace(/["']/g, '').toLowerCase() : 'utf-8';
          const textEncodingSupported = ['utf-8', 'utf8', 'us-ascii', 'ascii'].includes(charset);
          const isHtml = /text\/html|application\/xhtml\+xml/.test(contentType);
          const isCss = /text\/css/.test(contentType);
          const rewrite = textEncodingSupported && isHtml
            ? rewriteHtml
            : textEncodingSupported && isCss
              ? rewriteCss
              : null;

          if (!rewrite) {
            res.writeHead(proxyRes.statusCode, responseHeaders);
            proxyRes.pipe(res);
            proxyRes.on('end', resolve);
            proxyRes.on('error', reject);
            return;
          }

          const encoding = String(responseHeaders['content-encoding'] || '').toLowerCase();
          if (encoding && !/^(?:gzip|deflate|br)$/.test(encoding)) {
            proxyRes.resume();
            reject(new Error(`目标站返回了无法解压的编码: ${encoding}`));
            return;
          }
          let source = proxyRes;
          if (encoding === 'br') source = proxyRes.pipe(zlib.createBrotliDecompress());
          else if (encoding === 'gzip' || encoding === 'deflate') source = proxyRes.pipe(zlib.createUnzip());

          const responseBuffers = [];
          source.on('data', chunk => responseBuffers.push(chunk));
          source.on('end', () => {
            const rewritten = rewrite(Buffer.concat(responseBuffers).toString('utf8'), rewriteContext);
            delete responseHeaders['content-encoding'];
            responseHeaders['content-length'] = String(Buffer.byteLength(rewritten));
            res.writeHead(proxyRes.statusCode, responseHeaders);
            res.end(rewritten);
            resolve();
          });
          source.on('error', reject);
          proxyRes.on('error', reject);
        });
        proxyReq.on('error', reject);
        proxyReq.end(bodyBuffer.length ? bodyBuffer : undefined);
      });
    }
  });
}

module.exports = {
  handleProxyRequest,
  resolveProxyTarget,
  responseIndicatesExpiredAuth,
  rewriteRefreshHeader
};
