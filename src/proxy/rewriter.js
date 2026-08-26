const URL_ATTRIBUTES = [
  'href', 'src', 'action', 'poster', 'data', 'manifest', 'formaction', 'background', 'cite'
];

function isNonNetworkUrl(value) {
  return /^(?:#|data:|javascript:|mailto:|tel:|blob:|about:)/i.test(value);
}

/**
 * 只重写标准 URL：站内绝对路径、协议相对 URL、以及指向目标站自身的绝对 URL。
 * 普通相对路径保持不变，因为公开路径会镜像上游 pathname，浏览器可自行正确解析。
 */
function rewriteUrl(value, context) {
  const raw = String(value || '');
  const trimmed = raw.trim();
  if (!trimmed || isNonNetworkUrl(trimmed)) return raw;

  const isRootRelative = trimmed.startsWith('/') && !trimmed.startsWith('//');
  const isProtocolRelative = trimmed.startsWith('//');
  const isAbsolute = /^[A-Za-z][A-Za-z\d+.-]*:/.test(trimmed);
  if (!isRootRelative && !isProtocolRelative && !isAbsolute) return raw;

  let url;
  try {
    url = new URL(trimmed, context.upstreamUrl);
  } catch {
    return raw;
  }
  if (!['http:', 'https:'].includes(url.protocol)) return raw;
  for (const [alias, origin] of Object.entries(context.upstreamOrigins || {})) {
    if (url.origin === origin) {
      return `/.hilbert/upstream/${alias}` + url.pathname + url.search + url.hash;
    }
  }
  const primaryOrigin = context.primaryOrigin || context.upstreamOrigin;
  if (url.origin !== primaryOrigin) return raw;
  return context.mountPrefix + url.pathname + url.search + url.hash;
}

function rewriteSrcset(value, context) {
  return String(value).split(',').map(candidate => {
    const trimmed = candidate.trim();
    if (!trimmed) return candidate;
    const match = trimmed.match(/^(\S+)([\s\S]*)$/);
    if (!match) return candidate;
    return rewriteUrl(match[1], context) + match[2];
  }).join(', ');
}

/**
 * CSS 中的 url(...) 与字符串形式 @import 使用同一套标准 URL 映射。
 */
function rewriteCss(css, context) {
  let out = String(css).replace(
    /url\(\s*(?:(['"])(.*?)\1|([^)]*?))\s*\)/gi,
    (full, quote, quotedValue, bareValue) => {
      const value = quote ? quotedValue : bareValue.trim();
      const rewritten = rewriteUrl(value, context);
      return `url(${quote || ''}${rewritten}${quote || ''})`;
    }
  );
  out = out.replace(/(@import\s+)(['"])(.*?)\2/gi, (full, prefix, quote, value) => {
    return `${prefix}${quote}${rewriteUrl(value, context)}${quote}`;
  });
  return out;
}

function rewriteMetaRefreshValue(value, context) {
  return String(value).replace(/(\burl\s*=\s*)([^;]+)$/i, (full, prefix, urlValue) => {
    return prefix + rewriteUrl(urlValue.trim().replace(/^['"]|['"]$/g, ''), context);
  });
}

function findTagEnd(html, start) {
  let quote = '';
  for (let index = start + 1; index < html.length; index += 1) {
    const char = html[index];
    if (quote) {
      if (char === quote) quote = '';
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '>') {
      return index;
    }
  }
  return -1;
}

function parseTagAttributes(tag) {
  const attributes = [];
  let index = 1;
  while (/\s/.test(tag[index] || '')) index += 1;
  if (tag[index] === '/') return attributes;
  while (index < tag.length && !/[\s/>]/.test(tag[index])) index += 1;

  while (index < tag.length) {
    while (/\s/.test(tag[index] || '')) index += 1;
    if (tag[index] === '>' || (tag[index] === '/' && tag[index + 1] === '>')) break;
    const nameStart = index;
    while (index < tag.length && !/[\s=/>]/.test(tag[index])) index += 1;
    if (index === nameStart) {
      index += 1;
      continue;
    }
    const name = tag.slice(nameStart, index).toLowerCase();
    while (/\s/.test(tag[index] || '')) index += 1;
    if (tag[index] !== '=') {
      attributes.push({ name, value: null });
      continue;
    }
    index += 1;
    while (/\s/.test(tag[index] || '')) index += 1;
    const quote = tag[index] === '"' || tag[index] === "'" ? tag[index] : '';
    if (quote) index += 1;
    const valueStart = index;
    if (quote) {
      while (index < tag.length && tag[index] !== quote) index += 1;
    } else {
      while (index < tag.length && !/[\s>]/.test(tag[index])) index += 1;
    }
    const valueEnd = index;
    attributes.push({ name, value: tag.slice(valueStart, valueEnd), valueStart, valueEnd });
    if (quote && tag[index] === quote) index += 1;
  }
  return attributes;
}

function rewriteTag(tag, context) {
  const attributes = parseTagAttributes(tag);
  const isMetaRefresh = /^<\s*meta\b/i.test(tag) && attributes.some(attribute =>
    attribute.name === 'http-equiv' && String(attribute.value).trim().toLowerCase() === 'refresh');
  const replacements = [];
  for (const attribute of attributes) {
    if (attribute.value === null) continue;
    let value = attribute.value;
    if (URL_ATTRIBUTES.includes(attribute.name)) value = rewriteUrl(value, context);
    else if (attribute.name === 'srcset') value = rewriteSrcset(value, context);
    else if (attribute.name === 'style') value = rewriteCss(value, context);
    else if (isMetaRefresh && attribute.name === 'content') value = rewriteMetaRefreshValue(value, context);
    if (value !== attribute.value) replacements.push({ ...attribute, value });
  }
  replacements.sort((left, right) => right.valueStart - left.valueStart);
  let out = tag;
  for (const replacement of replacements) {
    out = out.slice(0, replacement.valueStart) + replacement.value + out.slice(replacement.valueEnd);
  }
  return out;
}

/**
 * 按 HTML 标签边界处理属性，脚本正文始终原样保留，避免正则误改 JavaScript 字符串。
 */
function rewriteHtml(html, context) {
  const source = String(html);
  const lower = source.toLowerCase();
  let output = '';
  let cursor = 0;
  while (cursor < source.length) {
    const tagStart = source.indexOf('<', cursor);
    if (tagStart === -1) return output + source.slice(cursor);
    output += source.slice(cursor, tagStart);

    if (source.startsWith('<!--', tagStart)) {
      const commentEnd = source.indexOf('-->', tagStart + 4);
      if (commentEnd === -1) return output + source.slice(tagStart);
      output += source.slice(tagStart, commentEnd + 3);
      cursor = commentEnd + 3;
      continue;
    }

    const tagEnd = findTagEnd(source, tagStart);
    if (tagEnd === -1) return output + source.slice(tagStart);
    const tag = source.slice(tagStart, tagEnd + 1);
    const nameMatch = tag.match(/^<\s*([A-Za-z][\w:-]*)/);
    const tagName = nameMatch ? nameMatch[1].toLowerCase() : '';
    output += nameMatch ? rewriteTag(tag, context) : tag;
    cursor = tagEnd + 1;

    if (tagName === 'script') {
      const closeStart = lower.indexOf('</script', cursor);
      if (closeStart === -1) return output + source.slice(cursor);
      output += source.slice(cursor, closeStart);
      cursor = closeStart;
    } else if (tagName === 'style') {
      const closeStart = lower.indexOf('</style', cursor);
      if (closeStart === -1) return output + rewriteCss(source.slice(cursor), context);
      output += rewriteCss(source.slice(cursor, closeStart), context);
      cursor = closeStart;
    }
  }
  return output;
}

module.exports = {
  findTagEnd,
  parseTagAttributes,
  rewriteCss,
  rewriteHtml,
  rewriteSrcset,
  rewriteTag,
  rewriteUrl
};
