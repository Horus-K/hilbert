const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'pages.json');
const GROUPS_FILE = path.join(DATA_DIR, 'groups.json');

// 支持的页面类型：link = iframe 嵌入外部链接，markdown = 渲染 Markdown 文档
const PAGE_TYPES = ['link', 'markdown'];

// 默认页面配置（首次启动时写入）
const DEFAULT_PAGES = [
  {
    id: 'grafana-main',
    type: 'link',
    name: 'Grafana 监控面板',
    icon: '📊',
    url: 'https://grafana-sit.abel.ai/dashboard/snapshot/D1QuKevhALazej2ucsYlTL5HQ9Y9hHVP?orgId=0&refresh=10s&from=now-30m&to=now',
    group: '监控'
  }
];

// 只对 /api 路由解析 JSON 请求体：不能全局注册，否则会提前消费 /proxy/ 下
// 转发请求的 application/json 请求体，导致代理永久挂起（如 Grafana 的 /api/ds/query）
app.use('/api', express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 健康检查：供容器编排（Docker HEALTHCHECK / K8s 探针）使用
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

// ---------- 配置文件读写 ----------

function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(DEFAULT_PAGES, null, 2), 'utf8');
  }
}

function readPages() {
  ensureDataFile();
  try {
    const pages = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    // 兼容旧数据：没有 type 字段的一律视为外部链接页面
    return pages.map(p => ({ type: 'link', ...p }));
  } catch (err) {
    console.error('读取配置失败，返回默认配置:', err.message);
    return DEFAULT_PAGES;
  }
}

function writePages(pages) {
  ensureDataFile();
  fs.writeFileSync(DATA_FILE, JSON.stringify(pages, null, 2), 'utf8');
}

function isValidUrl(str) {
  try {
    const u = new URL(str);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

// 校验并规范化认证配置：未启用返回 null，信息不完整返回 undefined（非法）
// 支持三种模式：basic（Basic Auth 头）/ login（表单登录换会话 Cookie）/ header（自定义请求头）
function normalizeAuth(auth) {
  if (!auth) return null;
  const mode = auth.mode || 'basic'; // 兼容旧数据：无 mode 视为 basic
  if (!['basic', 'login', 'header'].includes(mode)) return undefined;
  if (mode === 'header') {
    if (!auth.headerName || !String(auth.headerValue).trim()) return undefined;
    return { mode, headerName: String(auth.headerName).trim(), headerValue: String(auth.headerValue) };
  }
  if (!auth.username || !auth.password) return undefined;
  const normalized = { mode, username: String(auth.username), password: String(auth.password) };
  if (mode === 'login') {
    // 登录接口路径，默认 /login（Grafana 等均为该路径）
    let loginPath = String(auth.loginPath || '/login').trim() || '/login';
    if (!loginPath.startsWith('/')) loginPath = '/' + loginPath;
    normalized.loginPath = loginPath;
  }
  return normalized;
}

// ---------- Markdown 文件存储 ----------
// Markdown 正文单独存放在 data/pages/*.md，pages.json 的 content 字段只记录路径

const PAGES_DIR = path.join(DATA_DIR, 'pages');
const CONTENT_PREFIX = '/data/pages/';

function isContentPath(value) {
  return typeof value === 'string' && value.startsWith(CONTENT_PREFIX);
}

// content 路径 -> 实际文件路径（只取 basename，防止路径穿越）
function mdFilePath(contentPath) {
  return path.join(PAGES_DIR, path.basename(contentPath));
}

function writeMdFile(fileName, text) {
  if (!fs.existsSync(PAGES_DIR)) fs.mkdirSync(PAGES_DIR, { recursive: true });
  fs.writeFileSync(path.join(PAGES_DIR, fileName), text, 'utf8');
  return CONTENT_PREFIX + fileName;
}

function deleteMdFile(content) {
  if (!isContentPath(content)) return;
  try {
    fs.unlinkSync(mdFilePath(content));
  } catch { /* 文件已不存在则忽略 */ }
}

// API 返回前：把路径引用回填为实际文本，前端逻辑保持不变
function resolvePage(page) {
  if (page.type !== 'markdown' || !isContentPath(page.content)) return page;
  let text = '';
  try {
    text = fs.readFileSync(mdFilePath(page.content), 'utf8');
  } catch { /* 文件缺失时返回空内容 */ }
  return { ...page, contentPath: page.content, content: text };
}

// ---------- API：页面配置 ----------

// 获取全部页面
app.get('/api/pages', (req, res) => {
  res.json(readPages().map(resolvePage));
});

// 新增页面
app.post('/api/pages', (req, res) => {
  const { type = 'link', name, url, icon, group, content, auth } = req.body || {};
  if (!PAGE_TYPES.includes(type)) {
    return res.status(400).json({ error: '不支持的页面类型' });
  }
  if (!name || !name.trim()) {
    return res.status(400).json({ error: '页面名称不能为空' });
  }
  if (type === 'link' && !isValidUrl(url)) {
    return res.status(400).json({ error: '请输入合法的 http/https 链接' });
  }
  const pages = readPages();
  const page = {
    id: crypto.randomUUID(),
    type,
    name: name.trim(),
    icon: (icon || (type === 'markdown' ? '📝' : '🔗')).trim(),
    group: (group || '未分组').trim()
  };
  if (type === 'link') {
    page.url = url.trim();
    const normalized = normalizeAuth(auth);
    if (normalized === undefined) {
      return res.status(400).json({ error: '认证信息不完整' });
    }
    if (normalized) page.auth = normalized;
  } else {
    // Markdown 正文存入独立文件，pages.json 只记录路径；未传内容时生成占位文档
    const text = (content && content.trim())
      ? content
      : '# 新文档\n\n点击右上角「编辑」开始编写内容。';
    page.content = writeMdFile(page.id + '.md', text);
  }
  pages.push(page);
  writePages(pages);
  res.status(201).json(resolvePage(page));
});

// 更新页面
app.put('/api/pages/:id', (req, res) => {
  const pages = readPages();
  const idx = pages.findIndex(p => p.id === req.params.id);
  if (idx === -1) {
    return res.status(404).json({ error: '页面不存在' });
  }
  const { type, name, url, icon, group, content, auth } = req.body || {};
  const current = pages[idx];

  if (type !== undefined) {
    if (!PAGE_TYPES.includes(type)) return res.status(400).json({ error: '不支持的页面类型' });
    current.type = type;
  }
  if (name !== undefined) {
    if (!name.trim()) return res.status(400).json({ error: '页面名称不能为空' });
    current.name = name.trim();
  }
  if (url !== undefined) current.url = url.trim();
  if (auth !== undefined) {
    const normalized = normalizeAuth(auth);
    if (normalized === undefined) {
      return res.status(400).json({ error: '认证信息不完整' });
    }
    if (normalized) current.auth = normalized;
    else delete current.auth; // 显式关闭认证
  }
  // 注意：content 不做直接赋值，markdown 页面的 content 字段保存的是文件路径，
  // 请求携带的文本统一在下方一致性校验中落盘
  if (icon !== undefined) current.icon = icon.trim() || (current.type === 'markdown' ? '📝' : '🔗');
  if (group !== undefined) current.group = (group || '未分组').trim();

  // 按最终类型做一致性校验，并清理不属于该类型的字段
  if (current.type === 'link') {
    if (!isValidUrl(current.url)) return res.status(400).json({ error: '请输入合法的 http/https 链接' });
    deleteMdFile(current.content); // 类型切换为 link 时清理旧 md 文件
    delete current.content;
  } else {
    delete current.auth; // markdown 页面不需要认证配置
    delete current.url;
    if (content !== undefined) {
      // 请求携带新文本：写入独立 md 文件（已有路径则复用文件名）
      if (!content.trim()) return res.status(400).json({ error: 'Markdown 内容不能为空' });
      const fileName = isContentPath(current.content) ? path.basename(current.content) : current.id + '.md';
      current.content = writeMdFile(fileName, content);
    } else if (!isContentPath(current.content)) {
      // 旧版内联内容 / 由 link 切换而来无内容：迁移或生成占位独立文件
      const text = (current.content && current.content.trim())
        ? current.content
        : '# 新文档\n\n点击右上角「编辑」开始编写内容。';
      current.content = writeMdFile(current.id + '.md', text);
    }
  }

  pages[idx] = current;
  writePages(pages);
  res.json(resolvePage(current));
});

// 删除页面
app.delete('/api/pages/:id', (req, res) => {
  const pages = readPages();
  const idx = pages.findIndex(p => p.id === req.params.id);
  if (idx === -1) {
    return res.status(404).json({ error: '页面不存在' });
  }
  const [removed] = pages.splice(idx, 1);
  deleteMdFile(removed.content); // 同步删除对应的 md 文件
  writePages(pages);
  res.json(removed);
});

// ---------- API：分组管理 ----------

function ensureGroupsFile() {
  ensureDataFile();
  if (!fs.existsSync(GROUPS_FILE)) {
    // 首次初始化：用现有页面已使用的分组作为种子
    const seeds = [...new Set(readPages().map(p => p.group).filter(g => g && g !== '未分组'))];
    fs.writeFileSync(GROUPS_FILE, JSON.stringify(seeds, null, 2), 'utf8');
  }
}

function readGroups() {
  ensureGroupsFile();
  try {
    const groups = JSON.parse(fs.readFileSync(GROUPS_FILE, 'utf8'));
    return Array.isArray(groups) ? groups : [];
  } catch {
    return [];
  }
}

function writeGroups(groups) {
  ensureGroupsFile();
  fs.writeFileSync(GROUPS_FILE, JSON.stringify(groups, null, 2), 'utf8');
}

// 获取全部分组
app.get('/api/groups', (req, res) => {
  res.json(readGroups());
});

// 新增分组
app.post('/api/groups', (req, res) => {
  const name = ((req.body || {}).name || '').trim();
  if (!name) {
    return res.status(400).json({ error: '分组名称不能为空' });
  }
  if (name === '未分组') {
    return res.status(400).json({ error: '不能使用保留分组名「未分组」' });
  }
  const groups = readGroups();
  if (groups.includes(name)) {
    return res.status(400).json({ error: '分组已存在' });
  }
  groups.push(name);
  writeGroups(groups);
  res.status(201).json(groups);
});

// 删除分组（该分组下的页面移至未分组）
app.delete('/api/groups/:name', (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const groups = readGroups();
  const idx = groups.indexOf(name);
  if (idx === -1) {
    return res.status(404).json({ error: '分组不存在' });
  }
  groups.splice(idx, 1);
  writeGroups(groups);
  const pages = readPages();
  let changed = false;
  for (const p of pages) {
    if (p.group === name) {
      p.group = '未分组';
      changed = true;
    }
  }
  if (changed) writePages(pages);
  res.json(groups);
});

// ---------- 反向代理：自动注入认证 ----------
// iframe 无法自定义请求头，因此配置了认证的页面通过本代理转发，并剥离目标站的 iframe 嵌入限制响应头
// 支持三种认证模式：
//   basic  - 注入 Authorization: Basic 头（Nginx basic auth 类站点）
//   header - 注入自定义请求头（如 Grafana Service Account 的 Bearer 令牌）
//   login  - 服务端用账号密码调目标站登录接口换取会话 Cookie，缓存后注入每个请求，
//            会话过期（401 / 跳转登录页）时自动重新登录并重试

// login 模式的会话缓存：pageId -> 会话 Cookie 字符串
const sessionCache = new Map();

// ---------- 嵌入路径重写 ----------
// 目标站（如 Grafana）的 HTML 中静态资源多为绝对路径（/public/build/xxx.js），
// 经 /proxy/<id>/ 前缀嵌入时浏览器会向本服务器根路径请求这些资源而跳过代理，
// 导致「failed to load its application files」。因此对 HTML/CSS 响应做 URL 重写：
// 绝对路径 → 代理前缀路径，并把 Grafana 的 appSubUrl 注入为代理前缀，
// 使其运行时 API 调用 / 路由 / 懒加载资源也全部走代理

function rewriteHtml(html, prefix, appUrl) {
  return html
    // 让目标站前端在运行时以代理前缀拼接所有 URL（Grafana bootData）；
    // 保留原有子路径（子目录部署时原值非空，拼接后资源/API 路径才完整）
    .replace(/"appSubUrl":"([^"]*)"/, `"appSubUrl":"${prefix}$1"`)
    // appUrl 改为代理的绝对地址，避免目标站构造的绝对链接指回其自身域名
    .replace(/"appUrl":"[^"]*"/, `"appUrl":"${appUrl}"`)
    // 标签属性中的站内绝对路径：href="/xxx" → href="<prefix>/xxx"
    .replace(/((?:href|src|content|action|poster)\s*=\s*["'])\//g, '$1' + prefix + '/')
    // 内联脚本中的 /public 绝对路径赋值（如 __grafana_public_path__）
    .replaceAll('"/public/', `"${prefix}/public/`);
}

function rewriteCss(css, prefix) {
  return css.replace(/url\(\s*(["']?)\//g, 'url($1' + prefix + '/');
}

// 执行一次表单登录，返回会话 Cookie 字符串（登录失败则抛错）
function performLogin(page, base) {
  return new Promise((resolve, reject) => {
    const lib = base.protocol === 'https:' ? https : http;
    const body = JSON.stringify({ user: page.auth.username, password: page.auth.password });
    const loginReq = lib.request(base.origin + page.auth.loginPath, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Accept': 'application/json'
      }
    }, loginRes => {
      const setCookies = loginRes.headers['set-cookie'] || [];
      loginRes.resume(); // 排空响应体
      if (loginRes.statusCode >= 200 && loginRes.statusCode < 300 && setCookies.length) {
        resolve(setCookies.map(c => c.split(';')[0]).join('; '));
      } else {
        reject(new Error(`目标站登录失败 (HTTP ${loginRes.statusCode})，请检查账号密码或登录路径`));
      }
    });
    loginReq.on('error', reject);
    loginReq.end(body);
  });
}

// 计算代理请求的实际目标地址（HTTP 转发与 WebSocket upgrade 共用）
// 路径模型：代理前缀后的子路径一律按目标站根路径解析——HTML 的 <base href>
// 与 appSubUrl 重写后，浏览器发来的请求已携带完整站内路径（含子目录部署场景）。
// 唯一例外是文件式 URL（如 /datamap.html）：子资源按文件所在目录解析，
// 与浏览器相对路径行为一致
function resolveProxyTarget(page, originalUrl) {
  const base = new URL(page.url);
  const basePath = base.pathname.replace(/\/+$/, '');
  const prefix = '/proxy/' + page.id;

  const fileLike = /\/[^/]*\.[^/]*$/.test(basePath);
  const subBase = fileLike ? (basePath.slice(0, basePath.lastIndexOf('/')) || '/') : '';

  // 代理路径后的子路径 + 查询串（合并页面 URL 自带的查询参数，同名参数去重）
  let rest = originalUrl.slice(prefix.length);
  if (!rest.startsWith('/')) rest = '/' + rest;
  const qIdx = rest.indexOf('?');
  const restPath = qIdx === -1 ? rest : rest.slice(0, qIdx);
  const restQuery = qIdx === -1 ? '' : rest.slice(qIdx + 1);
  const query = [...new Set([
    ...base.search.replace(/^\?/, '').split('&'),
    ...restQuery.split('&')
  ].filter(Boolean))].join('&');
  const targetPath = restPath === '/'
    ? (basePath || '/')
    : (!subBase || subBase === '/' ? restPath : subBase + restPath);
  return {
    base, subBase, prefix, restPath, basePath, fileLike, query,
    target: base.origin + targetPath + (query ? '?' + query : '')
  };
}

// 按认证配置构建转发请求头（HTTP 转发与 WebSocket upgrade 共用）
async function applyAuthHeaders(page, headers) {
  const auth = page.auth;
  if (!auth) return;
  if (auth.mode === 'header') {
    headers[auth.headerName.toLowerCase()] = auth.headerValue;
  } else if (auth.mode === 'login') {
    let cookie = sessionCache.get(page.id);
    if (!cookie) {
      cookie = await performLogin(page, new URL(page.url));
      sessionCache.set(page.id, cookie);
    }
    headers.cookie = cookie;
  } else {
    // basic（默认）
    headers.authorization = 'Basic ' +
      Buffer.from(auth.username + ':' + auth.password).toString('base64');
  }
}

app.use('/proxy/:pageId', (req, res) => {
  const page = readPages().find(p => p.id === req.params.pageId);
  if (!page || page.type !== 'link') {
    return res.status(404).send('页面不存在或非链接页面');
  }
  handleProxyRequest(page, req, res);
});

// 代理转发主体：/proxy/:pageId 路由与根路径兜底转发共用
// （overrideUrl 为兜底场景下拼回前缀后的等价请求路径）
function handleProxyRequest(page, req, res, overrideUrl) {
  const resolved = resolveProxyTarget(page, overrideUrl || req.originalUrl);
  const { base, subBase, prefix, target } = resolved;

  // 页面 URL 指向深层路径（如 Grafana 仪表盘 /d/xxx，属 SPA 路由而非目录）时，
  // 根请求先跳转到前缀 + 页面路径，让目标站前端路由看到正确入口；
  // 文件式 URL 除外（根请求直接返回文件本身，相对资源按文件目录解析）
  if (resolved.restPath === '/' && resolved.basePath && !resolved.fileLike) {
    return res.redirect(302, prefix + resolved.basePath
      + (resolved.query ? '?' + resolved.query : ''));
  }

  const auth = page.auth;
  const lib = base.protocol === 'https:' ? https : http;
  // HTML 重写时把 appUrl 改为代理的绝对地址
  const appUrl = (req.headers['x-forwarded-proto'] || 'http') + '://' + req.headers.host + prefix + '/';

  // 先缓存请求体：login 模式会话过期重试时需要重发
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
      delete headers.host; // 由 Node 按目标地址自动设置
      // 把 Origin/Referer 改写为目标站自身域名：Grafana 的 CSRF 校验比较 Origin 与请求 Host，
      // 嵌入场景下浏览器的 Origin（localhost）与目标域名不一致会被拒（403 origin not allowed），
      // 改写后与 Host 一致，兼容「校验 Origin」和「Origin 缺失时回退校验 Referer」两类实现
      headers.origin = base.origin;
      headers.referer = base.origin + '/';
      delete headers['transfer-encoding']; // 请求体已缓存，统一按 content-length 发送
      delete headers['accept-encoding']; // 要求不压缩，便于对 HTML/CSS 做文本重写
      headers['content-length'] = bodyBuf.length;

      await applyAuthHeaders(page, headers);

      await new Promise((resolve, reject) => {
        const proxyReq = lib.request(target, { method: req.method, headers }, proxyRes => {
          // login 模式会话过期检测：401 或被重定向到登录页 → 重新登录后重试一次
          const expired = auth && auth.mode === 'login' && !isRetry && (
            proxyRes.statusCode === 401 ||
            ([301, 302, 303, 307, 308].includes(proxyRes.statusCode) &&
              /login/i.test(proxyRes.headers.location || ''))
          );
          if (expired) {
            proxyRes.resume();
            sessionCache.delete(page.id);
            resolve(forward(true));
            return;
          }
          const resHeaders = { ...proxyRes.headers };
          // 剥离 iframe 嵌入限制，保证目标站能在 iframe 中展示
          delete resHeaders['x-frame-options'];
          delete resHeaders['content-security-policy'];
          delete resHeaders['content-security-policy-report-only'];
          // 把指向目标站的跳转重写回代理路径，避免跳出后丢失认证
          if (resHeaders.location) {
            try {
              const loc = new URL(resHeaders.location, base.origin);
              if (loc.origin === base.origin && loc.pathname.startsWith(subBase || '/')) {
                const sub = subBase && subBase !== '/' ? loc.pathname.slice(subBase.length) : loc.pathname;
                // 与普通请求保持一致：合并页面 URL 自带的查询参数
                const mergedQuery = [base.search.replace(/^\?/, ''), loc.search.replace(/^\?/, '')]
                  .filter(Boolean).join('&');
                resHeaders.location = prefix + (sub.startsWith('/') ? sub : '/' + sub)
                  + (mergedQuery ? '?' + mergedQuery : '');
              }
            } catch { /* 非法 Location 保持原样 */ }
          }

          const contentType = String(resHeaders['content-type'] || '');
          const isHtml = /text\/html/.test(contentType);
          const rewrite = isHtml ? rewriteHtml : /text\/css/.test(contentType) ? rewriteCss : null;
          if (!rewrite) {
            res.writeHead(proxyRes.statusCode, resHeaders);
            proxyRes.pipe(res);
            proxyRes.on('end', resolve);
            proxyRes.on('error', reject);
            return;
          }
          // HTML/CSS：缓冲后重写绝对路径，再修正长度返回
          const bufs = [];
          proxyRes.on('data', c => bufs.push(c));
          proxyRes.on('end', () => {
            const rewritten = isHtml
              ? rewriteHtml(Buffer.concat(bufs).toString('utf8'), prefix, appUrl)
              : rewriteCss(Buffer.concat(bufs).toString('utf8'), prefix);
            delete resHeaders['content-length'];
            delete resHeaders['content-encoding'];
            delete resHeaders['transfer-encoding'];
            resHeaders['content-length'] = Buffer.byteLength(rewritten);
            res.writeHead(proxyRes.statusCode, resHeaders);
            res.end(rewritten);
            resolve();
          });
          proxyRes.on('error', reject);
        });
        proxyReq.on('error', reject);
        proxyReq.end(bodyBuf.length ? bodyBuf : undefined);
      });
    }
  });
}

// 兜底转发：目标站运行时可能生成不走 appSubUrl 的根路径地址
//（如 Grafana 的 /avatar/<hash>），浏览器会直接请求本服务根路径而跳过代理前缀。
// 同源 iframe 的 Referer 携带完整路径，据此识别来源代理页面，
// 把根路径请求转发到对应目标站，避免 404
app.use((req, res, next) => {
  const referer = req.headers.referer;
  if (!referer) return next();
  let match = null;
  try { match = new URL(referer).pathname.match(/^\/proxy\/([^/]+)/); } catch { /* 非法 Referer 忽略 */ }
  if (!match) return next();
  const page = readPages().find(p => p.id === match[1]);
  if (!page || page.type !== 'link') return next();
  handleProxyRequest(page, req, res, '/proxy/' + page.id + req.url);
});

// 启动时把旧版内联的 Markdown 内容迁移为独立文件
function migrateInlineMarkdown() {
  const pages = readPages();
  let changed = false;
  for (const p of pages) {
    if (p.type === 'markdown' && p.content && !isContentPath(p.content)) {
      p.content = writeMdFile(p.id + '.md', p.content);
      changed = true;
    }
  }
  if (changed) writePages(pages);
}
migrateInlineMarkdown();

const server = app.listen(PORT, () => {
  console.log(`后台已启动: http://localhost:${PORT}`);
});

// ---------- WebSocket 转发（Grafana live 等实时通道） ----------
// Express 中间件不处理 upgrade 请求，需在 HTTP server 层接管并双向管道透传
server.on('upgrade', async (req, socket, head) => {
  let match = req.url.match(/^\/proxy\/([^/]+)/);
  let page = match && readPages().find(p => p.id === match[1]);
  // 兜底：同 HTTP 转发，根路径 upgrade 按 Referer 识别来源代理页面
  let urlOverride = null;
  if (!page && req.headers.referer) {
    try { match = new URL(req.headers.referer).pathname.match(/^\/proxy\/([^/]+)/); } catch { match = null; }
    page = match && readPages().find(p => p.id === match[1]);
    if (page) urlOverride = '/proxy/' + page.id + req.url;
  }
  if (!page || page.type !== 'link') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }
  try {
    const { base, target } = resolveProxyTarget(page, urlOverride || req.url);
    const headers = { ...req.headers };
    delete headers.host;
    headers.origin = base.origin; // 同 HTTP 转发：改写为目标站域名，通过 CSRF 校验
    headers.referer = base.origin + '/';
    await applyAuthHeaders(page, headers);

    const lib = base.protocol === 'https:' ? https : http;
    const proxyReq = lib.request(target, { method: 'GET', headers });
    proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
      // 把目标的 101 响应原样写回客户端，然后双向透传数据帧
      let raw = `HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage}\r\n`;
      for (let i = 0; i < proxyRes.rawHeaders.length; i += 2) {
        raw += `${proxyRes.rawHeaders[i]}: ${proxyRes.rawHeaders[i + 1]}\r\n`;
      }
      raw += '\r\n';
      socket.write(raw);
      if (proxyHead.length) socket.write(proxyHead);
      if (head.length) proxySocket.write(head);
      proxySocket.pipe(socket);
      socket.pipe(proxySocket);
    });
    proxyReq.on('error', () => socket.destroy());
    proxyReq.end();
  } catch {
    socket.destroy();
  }
});
