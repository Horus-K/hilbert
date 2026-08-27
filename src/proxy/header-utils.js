const HOP_BY_HOP = new Set([
  'connection', 'proxy-connection', 'keep-alive', 'proxy-authenticate',
  'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'
]);

const SUPPORTED_CONTENT_ENCODINGS = ['gzip', 'deflate', 'br'];

/**
 * 代理只能向上游声明浏览器实际接受、且代理自身能够解压的编码。
 * 否则上游可能返回浏览器没有协商过的编码（本地 HTTP 下最常见的是 br），
 * 透传后会触发 ERR_CONTENT_DECODING_FAILED。
 */
function negotiateAcceptEncoding(value) {
  const explicit = new Map();
  let wildcardQuality = null;

  for (const item of String(value || '').split(',')) {
    const [rawName, ...rawParams] = item.trim().split(';');
    const name = rawName.trim().toLowerCase();
    if (!name) continue;

    let quality = 1;
    for (const rawParam of rawParams) {
      const match = rawParam.trim().match(/^q\s*=\s*(0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/i);
      if (match) quality = Number(match[1]);
    }
    if (name === '*') wildcardQuality = quality;
    else explicit.set(name, quality);
  }

  const accepted = [];
  for (const encoding of SUPPORTED_CONTENT_ENCODINGS) {
    const quality = explicit.has(encoding) ? explicit.get(encoding) : wildcardQuality;
    if (quality === null || quality === undefined || quality <= 0) continue;
    accepted.push(quality === 1 ? encoding : `${encoding};q=${quality}`);
  }

  // 不存在共同支持的压缩格式时明确请求 identity，避免上游自行选择编码。
  return accepted.length ? accepted.join(', ') : 'identity';
}

function requestOrigin(req) {
  const protocol = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  try {
    return new URL(`${protocol}://${host}`).origin;
  } catch {
    return '';
  }
}

function stripHopByHopHeaders(headers, preserveUpgrade = false) {
  const out = { ...headers };
  const connectionTokens = String(out.connection || '').split(',').map(v => v.trim().toLowerCase()).filter(Boolean);
  for (const name of [...HOP_BY_HOP, ...connectionTokens]) {
    if (preserveUpgrade && (name === 'connection' || name === 'upgrade')) continue;
    delete out[name];
  }
  return out;
}

function mapProxyUrlToUpstream(value, req, base, mountPrefix, page) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return value;
  }
  if (url.origin !== requestOrigin(req)) return value;
  let pathname = url.pathname;
  const mapped = pathname.match(/^\/\.hilbert\/upstream\/([a-z0-9-]+)(\/.*)?$/);
  if (mapped && page && page.origins && page.origins[mapped[1]]) {
    return page.origins[mapped[1]] + (mapped[2] || '/') + url.search + url.hash;
  }
  if (mountPrefix && (pathname === mountPrefix || pathname.startsWith(mountPrefix + '/'))) {
    pathname = pathname.slice(mountPrefix.length) || '/';
  }
  const primaryOrigin = page && page.url ? new URL(page.url).origin : base.origin;
  return primaryOrigin + pathname + url.search + url.hash;
}

/**
 * 保留浏览器真实语义，只把代理 origin 中的 Origin/Referer 映射到对应上游 URL。
 */
function buildUpstreamHeaders(req, base, mountPrefix, preserveUpgrade = false, page) {
  const headers = stripHopByHopHeaders(req.headers, preserveUpgrade);
  delete headers.host;
  delete headers.cookie;
  headers['accept-encoding'] = negotiateAcceptEncoding(headers['accept-encoding']);
  if (headers.origin === requestOrigin(req)) headers.origin = base.origin;
  if (headers.referer) headers.referer = mapProxyUrlToUpstream(headers.referer, req, base, mountPrefix, page);
  return headers;
}

function stripFrameAncestors(csp) {
  if (!csp) return csp;
  return String(csp).split(';')
    .map(directive => directive.trim())
    .filter(directive => directive && !/^frame-ancestors\b/i.test(directive))
    .join('; ');
}

module.exports = {
  buildUpstreamHeaders,
  mapProxyUrlToUpstream,
  negotiateAcceptEncoding,
  requestOrigin,
  stripFrameAncestors,
  stripHopByHopHeaders
};
