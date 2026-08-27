const MAX_JARS = 5000;
const MAX_COOKIES_PER_JAR = 100;

// 目标站 Cookie 只保存在服务端，避免泄露 Hilbert Cookie，也避免代理页面之间互相污染。
const jars = new Map();
const RESERVED_BROWSER_COOKIES = new Set(['hilbert_token', 'hilbert_proxy_session']);

function browserCookieHeader(value) {
  return String(value || '').split(';').map(part => part.trim()).filter(part => {
    const equals = part.indexOf('=');
    return equals > 0 && !RESERVED_BROWSER_COOKIES.has(part.slice(0, equals).trim().toLowerCase());
  }).join('; ');
}

function rewriteBrowserSetCookies(values) {
  const headers = Array.isArray(values) ? values : values ? [values] : [];
  return headers.flatMap(header => {
    const parts = String(header).split(';');
    const equals = parts[0].indexOf('=');
    if (equals <= 0 || RESERVED_BROWSER_COOKIES.has(parts[0].slice(0, equals).trim().toLowerCase())) return [];
    return [parts.filter((part, index) => index === 0 || !/^\s*domain\s*=/i.test(part)).join(';')];
  });
}

function userKey(user) {
  return String(user && (user.sub || user.id || user.email) || 'anonymous');
}

function jarKey(page, user) {
  return `${page.id}:${userKey(user)}`;
}

function defaultCookiePath(pathname) {
  if (!pathname || pathname[0] !== '/') return '/';
  const lastSlash = pathname.lastIndexOf('/');
  return lastSlash <= 0 ? '/' : pathname.slice(0, lastSlash);
}

function domainMatches(hostname, cookie) {
  const host = hostname.toLowerCase();
  if (cookie.hostOnly) return host === cookie.domain;
  return host === cookie.domain || host.endsWith('.' + cookie.domain);
}

function pathMatches(pathname, cookiePath) {
  if (pathname === cookiePath) return true;
  if (!pathname.startsWith(cookiePath)) return false;
  return cookiePath.endsWith('/') || pathname[cookiePath.length] === '/';
}

function parseSetCookie(header, requestUrl) {
  const parts = String(header || '').split(';');
  const first = parts.shift();
  const eq = first ? first.indexOf('=') : -1;
  if (eq <= 0) return null;

  const name = first.slice(0, eq).trim();
  const value = first.slice(eq + 1).trim();
  if (!name) return null;

  const cookie = {
    name,
    value,
    domain: requestUrl.hostname.toLowerCase(),
    hostOnly: true,
    path: defaultCookiePath(requestUrl.pathname),
    secure: false,
    expiresAt: null
  };

  for (const rawPart of parts) {
    const part = rawPart.trim();
    const attrEq = part.indexOf('=');
    const attrName = (attrEq === -1 ? part : part.slice(0, attrEq)).trim().toLowerCase();
    const attrValue = attrEq === -1 ? '' : part.slice(attrEq + 1).trim();
    if (attrName === 'domain' && attrValue) {
      const domain = attrValue.replace(/^\./, '').toLowerCase();
      if (requestUrl.hostname === domain || requestUrl.hostname.endsWith('.' + domain)) {
        cookie.domain = domain;
        cookie.hostOnly = false;
      }
    } else if (attrName === 'path' && attrValue.startsWith('/')) {
      cookie.path = attrValue;
    } else if (attrName === 'secure') {
      cookie.secure = true;
    } else if (attrName === 'max-age' && /^-?\d+$/.test(attrValue)) {
      cookie.expiresAt = Date.now() + Number(attrValue) * 1000;
    } else if (attrName === 'expires' && attrValue) {
      const expiresAt = Date.parse(attrValue);
      if (Number.isFinite(expiresAt)) cookie.expiresAt = expiresAt;
    }
  }
  return cookie;
}

function getJar(page, user, create = false) {
  const key = jarKey(page, user);
  let jar = jars.get(key);
  if (!jar && create) {
    jar = new Map();
    jars.set(key, jar);
    if (jars.size > MAX_JARS) jars.delete(jars.keys().next().value);
  }
  return jar;
}

function storeResponseCookies(page, user, requestUrl, setCookieHeaders) {
  if (!setCookieHeaders) return;
  const headers = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
  const jar = getJar(page, user, true);
  for (const header of headers) {
    const cookie = parseSetCookie(header, requestUrl);
    if (!cookie) continue;
    const key = `${cookie.domain}\n${cookie.path}\n${cookie.name}`;
    if (cookie.expiresAt !== null && cookie.expiresAt <= Date.now()) jar.delete(key);
    else jar.set(key, cookie);
    while (jar.size > MAX_COOKIES_PER_JAR) jar.delete(jar.keys().next().value);
  }
}

function getCookieHeader(page, user, requestUrl) {
  const jar = getJar(page, user);
  if (!jar) return '';
  const now = Date.now();
  const matches = [];
  for (const [key, cookie] of jar) {
    if (cookie.expiresAt !== null && cookie.expiresAt <= now) {
      jar.delete(key);
      continue;
    }
    if (cookie.secure && requestUrl.protocol !== 'https:') continue;
    if (!domainMatches(requestUrl.hostname, cookie)) continue;
    if (!pathMatches(requestUrl.pathname || '/', cookie.path)) continue;
    matches.push(cookie);
  }
  matches.sort((a, b) => b.path.length - a.path.length);
  return matches.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
}

function clearCookieJar(pageId, user) {
  if (user) {
    jars.delete(`${pageId}:${userKey(user)}`);
    return;
  }
  const prefix = `${pageId}:`;
  for (const key of jars.keys()) {
    if (key.startsWith(prefix)) jars.delete(key);
  }
}

module.exports = {
  browserCookieHeader,
  clearCookieJar,
  getCookieHeader,
  parseSetCookie,
  rewriteBrowserSetCookies,
  storeResponseCookies,
  userKey,
  _jars: jars
};
