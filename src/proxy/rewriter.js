/**
 * HTML 路径重写：把目标站 HTML 中的绝对路径重写为代理前缀
 * prefix 为空字符串时表示恒等映射（只重写 appUrl）
 */
function rewriteHtml(html, prefix, appUrl) {
  let out = html
    .replace(/"appUrl":"[^"]*"/, `"appUrl":"${appUrl}"`);
  if (prefix) {
    out = out
      .replace(/"appSubUrl":"([^"]*)"/, `"appSubUrl":"${prefix}$1"`)
      .replace(/((?:href|src|content|action|poster)\s*=\s*["'])\//g, '$1' + prefix + '/')
      .replaceAll('"/public/', `"${prefix}/public/`);
  }
  return out;
}

/**
 * CSS 内 url(...) 绝对路径重写为挂载前缀（仅挂载模式使用）
 */
function rewriteCss(css, prefix) {
  return css.replace(/url\(\s*(["']?)\//g, 'url($1' + prefix + '/');
}

module.exports = { rewriteHtml, rewriteCss };
