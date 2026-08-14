const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const zlib = require('zlib');
const multer = require('multer');
const AdmZip = require('adm-zip');
const jwt = require('jsonwebtoken');
const { ProxyAgent, fetch: proxyFetch } = require('undici');
const config = require('./config');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// 隐藏技术栈信息：禁止 Express 自动添加 X-Powered-By 头（防指纹识别）
app.disable('x-powered-by');

// 安全响应头：在所有响应中设置（代理转发会由 handleProxyRequest 的 writeHead 覆盖，
// 自动剥离不适用的头如 X-Frame-Options，保证 iframe 嵌入不受影响）
app.use((req, res, next) => {
  // 防 Clickjacking：登录页 DENY（禁止被嵌入），其他页面 SAMEORIGIN
  res.setHeader('X-Frame-Options', req.path === '/login.html' ? 'DENY' : 'SAMEORIGIN');
  // 防 MIME 类型嗅探：浏览器不得猜测响应类型
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // XSS 过滤（旧浏览器兜底）
  res.setHeader('X-XSS-Protection', '1; mode=block');
  // Referer 策略：仅发送 origin，不泄露完整路径（保护代理路径结构）
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  // 限制浏览器功能：禁用不需要的 API（摄像头/麦克风/地理位置等）
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

// 出方向代理连接池：复用与目标站的 TCP/TLS 连接，避免每个请求重新三次握手
const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true });

const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'pages.json');
const GROUPS_FILE = path.join(DATA_DIR, 'groups.json');
const ROLES_FILE = path.join(DATA_DIR, 'roles.json');

// 超级管理员邮箱（从 config.js 读取）
const ADMIN_EMAIL = (config.admin_email || '').toLowerCase();

// 支持的页面类型：link = iframe 嵌入外部链接，markdown = 渲染 Markdown 文档
const PAGE_TYPES = ['link', 'markdown', 'custom'];

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

// 健康检查：供容器编排（Docker HEALTHCHECK / K8s 探针）使用（必须在认证中间件之前，否则探针失败）
app.get('/hilbert-api/health', (req, res) => {
  res.json({ status: 'ok' });
});

// ---------- Google SSO 认证 ----------

const GOOGLE_CONFIG = config.google;

// Google API 出站代理 dispatcher（国内服务器换取 token / 获取用户信息时需走代理）
const googleApiDispatcher = GOOGLE_CONFIG.api_proxy
  ? new ProxyAgent(GOOGLE_CONFIG.api_proxy)
  : undefined;

// state 采用签名令牌（HMAC）：自包含、无状态，服务器重启不丢失
// 生成：随机 nonce + 时间戳 → HMAC 签名 → 拼接为 state 字符串
// 校验：验证签名 + 检查时间戳是否在有效期内
function generateStateToken() {
  const nonce = crypto.randomBytes(16).toString('hex');
  const ts = Date.now().toString(36);
  const payload = nonce + '.' + ts;
  const sig = crypto.createHmac('sha256', GOOGLE_CONFIG.jwt_secret).update(payload).digest('hex');
  return payload + '.' + sig;
}

function verifyStateToken(state) {
  if (!state || typeof state !== 'string') return false;
  const parts = state.split('.');
  if (parts.length !== 3) return false;
  const [nonce, tsHex, sig] = parts;
  const payload = nonce + '.' + tsHex;
  const expected = crypto.createHmac('sha256', GOOGLE_CONFIG.jwt_secret).update(payload).digest('hex');
  if (sig !== expected) return false;
  const ts = parseInt(tsHex, 36);
  if (isNaN(ts) || Date.now() - ts > 10 * 60 * 1000) return false; // 10 分钟有效
  return true;
}

// 登录入口：生成随机 state，拼接 Google OAuth2 授权 URL 并重定向
app.get('/auth/google', (req, res) => {
  const state = generateStateToken();

  const params = new URLSearchParams({
    client_id: GOOGLE_CONFIG.client_id,
    redirect_uri: GOOGLE_CONFIG.oauth2_redirect_uri,
    response_type: GOOGLE_CONFIG.oauth2_response_type,
    scope: GOOGLE_CONFIG.oauth2_scope,
    access_type: GOOGLE_CONFIG.oauth2_access_type,
    include_granted_scopes: String(GOOGLE_CONFIG.oauth2_include_granted_scopes),
    state
  });

  res.redirect(GOOGLE_CONFIG.oauth2_url + '?' + params.toString());
});

// Google 回调：校验 state → 换取 token → 获取用户信息 → 签发 JWT → 写入 Cookie
app.get('/callback', async (req, res) => {
  try {
    const { code, state } = req.query;

    // 校验 state 防 CSRF（签名验证，无需服务端存储）
    if (!verifyStateToken(state)) {
      return res.status(403).send('Invalid state parameter');
    }
    // state 为签名令牌，无需服务端删除（无状态）

    if (!code) {
      return res.status(400).send('Authorization code missing');
    }

    // 用 authorization code 换取 access_token（通过代理访问 Google API）
    const tokenRes = await proxyFetch(GOOGLE_CONFIG.token_url, {
      method: 'POST',
      dispatcher: googleApiDispatcher,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CONFIG.client_id,
        client_secret: GOOGLE_CONFIG.client_secret,
        redirect_uri: GOOGLE_CONFIG.oauth2_redirect_uri,
        grant_type: 'authorization_code'
      }).toString()
    });

    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      console.error('Token exchange failed:', errText);
      return res.status(500).send('Failed to exchange authorization code');
    }

    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;

    // 用 access_token 获取用户信息（通过代理访问 Google API）
    const userRes = await proxyFetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      dispatcher: googleApiDispatcher,
      headers: { Authorization: 'Bearer ' + accessToken }
    });

    if (!userRes.ok) {
      return res.status(500).send('Failed to fetch user info');
    }

    const user = await userRes.json();

    // 登录权限校验：先检查邮箱白名单，再检查域名白名单
    const userEmail = (user.email || '').toLowerCase();
    const allowedEmails = (GOOGLE_CONFIG.allowed_emails || '')
      .split(',')
      .map(e => e.trim().toLowerCase())
      .filter(Boolean);
    const allowedDomain = (GOOGLE_CONFIG.allowed_domain || '').trim().toLowerCase();

    if (allowedEmails.length > 0) {
      // 配置了具体邮箱白名单：只允许列表中的邮箱登录
      if (!allowedEmails.includes(userEmail)) {
        console.warn('Login denied: email not in whitelist:', userEmail);
        return res.status(403).send('您的账号 (' + user.email + ') 未被授权登录');
      }
    } else if (allowedDomain) {
      // 配置了域名白名单：只允许该域名下的邮箱登录
      if (!userEmail.endsWith('@' + allowedDomain)) {
        console.warn('Login denied: domain not allowed:', userEmail);
        return res.status(403).send('仅允许 @' + allowedDomain + ' 域名下的账号登录');
      }
    }

    // 签发 JWT
    const jwtPayload = {
      sub: user.id,
      email: user.email,
      name: user.name,
      picture: user.picture
    };
    const token = jwt.sign(jwtPayload, GOOGLE_CONFIG.jwt_secret, {
      expiresIn: GOOGLE_CONFIG.jwt_expire_hours + 'h'
    });

    // 将 JWT 写入 HttpOnly Cookie
    const isSecure = (req.headers['x-forwarded-proto'] || 'http') === 'https';
    res.cookie('hilbert_token', token, {
      httpOnly: true,
      secure: isSecure,
      sameSite: 'lax',
      path: '/',
      maxAge: GOOGLE_CONFIG.jwt_expire_hours * 60 * 60 * 1000
    });

    res.redirect('/');
  } catch (err) {
    console.error('Callback error:', err);
    res.status(500).send('Authentication failed');
  }
});

// 全局认证中间件：校验 Cookie 中的 JWT
app.use((req, res, next) => {
  // 白名单：静态资源（防止页面样式丢失）
  const ext = path.extname(req.path);
  if (ext && /^\.(css|js|png|jpg|jpeg|gif|svg|ico|webp|woff|woff2|ttf|eot|otf|mp3|mp4|webm|ogg|wav|pdf|xml|json|map)$/.test(ext)) {
    return next();
  }

  // 白名单：认证相关路由及登录页
  if (req.path === '/auth/google' || req.path === '/callback' || req.path === '/login.html') {
    return next();
  }

  // 白名单：健康检查（Docker 探针）
  if (req.path === '/hilbert-api/health') {
    return next();
  }

  // 校验 JWT（手动解析 Cookie，避免额外依赖）
  const cookieHeader = req.headers.cookie || '';
  const tokenMatch = cookieHeader.match(/(?:^|;\s*)hilbert_token=([^;]+)/);
  const token = tokenMatch ? decodeURIComponent(tokenMatch[1]) : null;
  if (!token) {
    if (req.path.startsWith('/hilbert-api/')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    return res.redirect('/login.html');
  }

  try {
    const decoded = jwt.verify(token, GOOGLE_CONFIG.jwt_secret);
    req.user = decoded;
    next();
  } catch (err) {
    // Token 过期或无效，清除 Cookie
    res.clearCookie('hilbert_token', { path: '/' });
    if (req.path.startsWith('/hilbert-api/')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    return res.redirect('/login.html');
  }
});

// 版本号（在认证中间件之后，受 JWT 保护）
app.get('/hilbert-api/version', (req, res) => {
  const pkg = require('./package.json');
  res.json({ version: pkg.version });
});

// 当前登录用户信息（从 JWT 中提取）
app.get('/hilbert-api/me', (req, res) => {
  res.json({
    name: req.user.name || req.user.email,
    email: req.user.email,
    picture: req.user.picture || null,
    isAdmin: isAdmin(req.user.email)
  });
});

// 当前用户权限查询
app.get('/hilbert-api/my-permissions', (req, res) => {
  const email = req.user.email;
  res.json({
    isAdmin: isAdmin(email),
    permissions: getUserPermissions(email)
  });
});

// 登出：清除 JWT Cookie
app.post('/hilbert-api/logout', (req, res) => {
  res.clearCookie('hilbert_token', { path: '/' });
  res.json({ ok: true });
});

// 只对 /hilbert-api 路由解析 JSON 请求体：不能全局注册，否则会提前消费代理请求的
// application/json 请求体，导致代理永久挂起（如 Grafana 的 /api/ds/query）
app.use('/hilbert-api', express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- RBAC：角色与权限数据存储 ----------

function ensureRolesFile() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(ROLES_FILE)) {
    fs.writeFileSync(ROLES_FILE, JSON.stringify({ roles: [], assignments: [] }, null, 2), 'utf8');
  }
}

let rolesCache = null;

function readRoles() {
  if (rolesCache) return rolesCache;
  ensureRolesFile();
  try {
    rolesCache = JSON.parse(fs.readFileSync(ROLES_FILE, 'utf8'));
    if (!Array.isArray(rolesCache.roles)) rolesCache.roles = [];
    if (!Array.isArray(rolesCache.assignments)) rolesCache.assignments = [];
    return rolesCache;
  } catch (err) {
    console.error('读取角色配置失败:', err.message);
    return { roles: [], assignments: [] };
  }
}

function writeRoles(data) {
  ensureRolesFile();
  fs.writeFileSync(ROLES_FILE, JSON.stringify(data, null, 2), 'utf8');
  rolesCache = data;
}

// ---------- RBAC：权限计算 ----------

const ALL_ACTIONS = ['read', 'create', 'update', 'delete'];

function isAdmin(email) {
  return (email || '').toLowerCase() === ADMIN_EMAIL;
}

// 邮箱通配符匹配：支持 *@domain.com 等通配模式
// pattern 含 * 时按通配匹配（* 匹配任意字符），否则精确匹配
function emailMatchesPattern(email, pattern) {
  const e = (email || '').toLowerCase();
  const p = (pattern || '').toLowerCase();
  if (!p.includes('*')) return e === p;
  // 将通配模式转为正则：转义特殊字符，* 替换为 .*
  const regex = '^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$';
  return new RegExp(regex).test(e);
}

// 获取用户的所有权限（聚合其所有角色的 permissions，支持邮箱通配符匹配）
function getUserPermissions(email) {
  if (isAdmin(email)) {
    return [{ pageId: '*', actions: [...ALL_ACTIONS] }];
  }
  const data = readRoles();
  const userEmail = (email || '').toLowerCase();
  // 匹配所有 assignment：精确匹配 + 通配符模式匹配
  const userAssignments = data.assignments.filter(a => emailMatchesPattern(userEmail, a.email));
  const permMap = new Map(); // pageId -> Set of actions
  for (const assignment of userAssignments) {
    const role = data.roles.find(r => r.id === assignment.roleId);
    if (!role || !Array.isArray(role.permissions)) continue;
    for (const perm of role.permissions) {
      if (!permMap.has(perm.pageId)) permMap.set(perm.pageId, new Set());
      const actions = permMap.get(perm.pageId);
      for (const a of (perm.actions || [])) actions.add(a);
    }
  }
  const result = [];
  for (const [pageId, actions] of permMap) {
    result.push({ pageId, actions: [...actions] });
  }
  return result;
}

// 检查用户是否对指定页面有指定操作权限
function hasPermission(email, pageId, action) {
  if (isAdmin(email)) return true;
  const perms = getUserPermissions(email);
  for (const p of perms) {
    // 通配权限 或 精确匹配页面 ID
    if (p.pageId === '*' || p.pageId === pageId) {
      if (p.actions.includes(action)) return true;
    }
  }
  return false;
}

// 管理员校验中间件
function requireAdmin(req, res, next) {
  if (isAdmin(req.user.email)) return next();
  return res.status(403).json({ error: '需要超级管理员权限' });
}

// ---------- 配置文件读写 ----------

function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(DEFAULT_PAGES, null, 2), 'utf8');
  }
}

// 页面配置内存缓存：每个代理转发请求（含目标站加载的大量子资源）都要按路径
// 查页面，若每次都同步读盘 + JSON.parse 会阻塞事件循环。读走缓存、写时刷新即可
let pagesCache = null;

function readPages() {
  if (pagesCache) return pagesCache;
  ensureDataFile();
  try {
    const pages = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    // 兼容旧数据：没有 type 字段的一律视为外部链接页面；auth 在读入时规范化
    //（旧配置可能缺 login 模式的 userField/passwordField 等字段，若只在 API 写入时
    // 补齐，存量配置直接用 performLogin 会拼出错误字段名导致登录失败）
    pagesCache = pages.map(p => {
      const page = { type: 'link', ...p };
      if (page.auth) {
        const normalized = normalizeAuth(page.auth);
        if (normalized !== undefined) page.auth = normalized;
      }
      return page;
    });
    return pagesCache;
  } catch (err) {
    console.error('读取配置失败，返回默认配置:', err.message);
    return DEFAULT_PAGES;
  }
}

function writePages(pages) {
  ensureDataFile();
  fs.writeFileSync(DATA_FILE, JSON.stringify(pages, null, 2), 'utf8');
  pagesCache = pages;
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
    // 登录请求体格式：json（默认，如 Grafana）/ form（表单编码，如 XXL-JOB）
    const loginFormat = auth.loginFormat || 'json';
    if (!['json', 'form'].includes(loginFormat)) return undefined;
    normalized.loginFormat = loginFormat;
    // 目标站的用户名/密码字段名，默认 user/password（如 XXL-JOB 为 userName/password）
    const userField = String(auth.userField || 'user').trim();
    const passwordField = String(auth.passwordField || 'password').trim();
    if (!userField || !passwordField) return undefined;
    normalized.userField = userField;
    normalized.passwordField = passwordField;
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

// ---------- 自定义页面静态资源存储 ----------
// 每个 custom 页面分配独立目录 data/custom-pages/<pageId>/，存放 HTML/CSS/JS/图片等

const CUSTOM_PAGES_DIR = path.join(DATA_DIR, 'custom-pages');
const ALLOWED_EXTENSIONS = new Set([
  '.html', '.htm', '.css', '.js', '.json', '.xml', '.svg',
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.mp3', '.mp4', '.webm', '.ogg', '.wav', '.pdf'
]);
const MAX_UPLOAD_SIZE = 10 * 1024 * 1024; // 10MB

function customPageDir(pageId) {
  return path.join(CUSTOM_PAGES_DIR, pageId);
}

function ensureCustomPageDir(pageId) {
  const dir = customPageDir(pageId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function deleteCustomPageDir(pageId) {
  const dir = customPageDir(pageId);
  if (fs.existsSync(dir)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
}

function copyDirSync(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirSync(srcPath, destPath);
    else fs.copyFileSync(srcPath, destPath);
  }
}

function isAllowedExtension(filename) {
  const ext = path.extname(filename).toLowerCase();
  return ALLOWED_EXTENSIONS.has(ext);
}

// multer 配置：内存存储 + 扩展名/大小校验
const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    if (isAllowedExtension(file.originalname)) cb(null, true);
    else cb(new Error('不支持的文件类型: ' + path.extname(file.originalname)));
  },
  limits: { fileSize: MAX_UPLOAD_SIZE }
});

// 处理文件上传（支持单文件或多文件 + zip 包解压）
function handleCustomUpload(req, res) {
  const pageId = req.params.id;
  const pages = readPages();
  const page = pages.find(p => p.id === pageId && p.type === 'custom');
  if (!page) return res.status(404).json({ error: '自定义页面不存在' });

  const targetDir = ensureCustomPageDir(pageId);
  const uploadedFiles = [];

  const processFile = (filename, buffer) => {
    const safeName = path.basename(filename);
    if (!isAllowedExtension(safeName)) return false;
    fs.writeFileSync(path.join(targetDir, safeName), buffer);
    uploadedFiles.push(safeName);
    return true;
  };

  if (req.files && req.files.length) {
    for (const file of req.files) {
      if (file.originalname.toLowerCase().endsWith('.zip')) {
        try {
          const zip = new AdmZip(file.buffer);
          for (const entry of zip.getEntries()) {
            if (entry.isDirectory) continue;
            const safeName = path.basename(entry.entryName);
            if (!safeName || safeName.startsWith('.')) continue;
            if (!isAllowedExtension(safeName)) continue;
            const fullPath = path.join(targetDir, safeName);
            if (!fullPath.startsWith(CUSTOM_PAGES_DIR + path.sep)) continue;
            fs.writeFileSync(fullPath, entry.getData());
            uploadedFiles.push(safeName);
          }
        } catch (e) {
          return res.status(400).json({ error: 'zip 解压失败: ' + e.message });
        }
      } else {
        processFile(file.originalname, file.buffer);
      }
    }
  }

  res.json({ uploaded: uploadedFiles });
}

// 自定义页面动态路由注册：为每个 custom 页面挂载 /hilbert-custom/<id> 静态托管
const customRoutesMap = new Map(); // pageId -> express.static handler

function registerCustomRoutes() {
  customRoutesMap.clear();
  const pages = readPages().filter(p => p.type === 'custom');
  for (const page of pages) {
    const dir = customPageDir(page.id);
    if (fs.existsSync(dir)) {
      customRoutesMap.set(page.id, express.static(dir, {
        index: [page.entry || 'index.html']
      }));
    }
  }
}

// /hilbert-custom/<pageId>/... 统一分发中间件（只注册一次，通过 Map 动态查找）
function customPagesDispatcher(req, res, next) {
  const match = req.path.match(/^\/([^/]+)(\/.*)?$/);
  if (!match) return next();
  const handler = customRoutesMap.get(match[1]);
  if (!handler) return next();
  req.url = match[2] || '/';
  return handler(req, res, next);
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

// ---------- API：RBAC 角色与权限管理（仅超级管理员） ----------

// 获取所有角色
app.get('/hilbert-api/rbac/roles', requireAdmin, (req, res) => {
  const data = readRoles();
  res.json(data.roles);
});

// 创建角色
app.post('/hilbert-api/rbac/roles', requireAdmin, (req, res) => {
  const { name, description, permissions } = req.body || {};
  if (!name || !name.trim()) {
    return res.status(400).json({ error: '角色名称不能为空' });
  }
  const data = readRoles();
  if (data.roles.some(r => r.name.trim().toLowerCase() === name.trim().toLowerCase())) {
    return res.status(400).json({ error: '角色名称已存在' });
  }
  // 校验权限格式
  const validPerms = [];
  if (Array.isArray(permissions)) {
    for (const p of permissions) {
      if (!p.pageId || !Array.isArray(p.actions)) continue;
      const validActions = p.actions.filter(a => ALL_ACTIONS.includes(a));
      if (validActions.length > 0) {
        validPerms.push({ pageId: p.pageId, actions: validActions });
      }
    }
  }
  const role = {
    id: crypto.randomUUID(),
    name: name.trim(),
    description: (description || '').trim(),
    permissions: validPerms
  };
  data.roles.push(role);
  writeRoles(data);
  res.status(201).json(role);
});

// 更新角色
app.put('/hilbert-api/rbac/roles/:id', requireAdmin, (req, res) => {
  const data = readRoles();
  const idx = data.roles.findIndex(r => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '角色不存在' });
  const role = data.roles[idx];
  const { name, description, permissions } = req.body || {};
  if (name !== undefined) {
    if (!name.trim()) return res.status(400).json({ error: '角色名称不能为空' });
    if (data.roles.some(r => r.id !== role.id && r.name.trim().toLowerCase() === name.trim().toLowerCase())) {
      return res.status(400).json({ error: '角色名称已存在' });
    }
    role.name = name.trim();
  }
  if (description !== undefined) role.description = description.trim();
  if (permissions !== undefined && Array.isArray(permissions)) {
    const validPerms = [];
    for (const p of permissions) {
      if (!p.pageId || !Array.isArray(p.actions)) continue;
      const validActions = p.actions.filter(a => ALL_ACTIONS.includes(a));
      if (validActions.length > 0) {
        validPerms.push({ pageId: p.pageId, actions: validActions });
      }
    }
    role.permissions = validPerms;
  }
  data.roles[idx] = role;
  writeRoles(data);
  res.json(role);
});

// 删除角色（同时清理关联的 assignment）
app.delete('/hilbert-api/rbac/roles/:id', requireAdmin, (req, res) => {
  const data = readRoles();
  const idx = data.roles.findIndex(r => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '角色不存在' });
  data.roles.splice(idx, 1);
  // 清理引用该角色的分配
  data.assignments = data.assignments.filter(a => a.roleId !== req.params.id);
  writeRoles(data);
  res.json({ deleted: req.params.id });
});

// 获取所有分配关系
app.get('/hilbert-api/rbac/assignments', requireAdmin, (req, res) => {
  const data = readRoles();
  res.json(data.assignments);
});

// 为邮箱分配角色（支持通配符模式，如 *@domain.com）
app.post('/hilbert-api/rbac/assignments', requireAdmin, (req, res) => {
  const { email, roleId } = req.body || {};
  if (!email || !email.trim()) {
    return res.status(400).json({ error: '邮箱不能为空' });
  }
  if (!roleId) {
    return res.status(400).json({ error: '角色不能为空' });
  }
  const data = readRoles();
  if (!data.roles.some(r => r.id === roleId)) {
    return res.status(404).json({ error: '角色不存在' });
  }
  const normalizedEmail = email.trim().toLowerCase();
  // 通配符格式校验：含 * 时必须是合法模式（如 *@domain.com）
  if (normalizedEmail.includes('*')) {
    if (!/^[^@]*\*[^@]*@.+$/.test(normalizedEmail)) {
      return res.status(400).json({ error: '通配符格式不正确，示例：*@domain.com' });
    }
  }
  // 防止重复分配
  if (data.assignments.some(a => a.email.toLowerCase() === normalizedEmail && a.roleId === roleId)) {
    return res.status(400).json({ error: '该邮箱已分配此角色' });
  }
  const assignment = { email: normalizedEmail, roleId };
  data.assignments.push(assignment);
  writeRoles(data);
  res.status(201).json(assignment);
});

// 移除邮箱的角色绑定
app.delete('/hilbert-api/rbac/assignments/:email/:roleId', requireAdmin, (req, res) => {
  const data = readRoles();
  const email = decodeURIComponent(req.params.email).toLowerCase();
  const roleId = req.params.roleId;
  const before = data.assignments.length;
  data.assignments = data.assignments.filter(
    a => !(a.email.toLowerCase() === email && a.roleId === roleId)
  );
  if (data.assignments.length === before) {
    return res.status(404).json({ error: '分配关系不存在' });
  }
  writeRoles(data);
  res.json({ deleted: true });
});

// ---------- API：页面配置 ----------

// 获取全部页面（按权限过滤：只返回有 read 权限的页面）
app.get('/hilbert-api/pages', (req, res) => {
  const email = req.user.email;
  const allPages = readPages().map(resolvePage);
  if (isAdmin(email)) return res.json(allPages);
  const filtered = allPages.filter(p => hasPermission(email, p.id, 'read'));
  res.json(filtered);
});

// 新增页面
app.post('/hilbert-api/pages', (req, res) => {
  // 权限校验：需要全局 create 权限
  if (!hasPermission(req.user.email, '*', 'create')) {
    return res.status(403).json({ error: '没有创建页面的权限' });
  }
  const { type = 'link', name, url, icon, group, content, auth, proxyMode } = req.body || {};
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
    icon: (icon || ({ markdown: '📝', custom: '🖥️' }[type] || '🔗')).trim(),
    group: (group || '未分组').trim()
  };
  if (type === 'link') {
    page.url = url.trim();
    // 代理模式：mount（/hilbert-proxy/<id> 挂载）由编辑页面手动指定；默认恒等映射（不落盘该字段）
    if (proxyMode === 'mount') page.proxyMode = 'mount';
    const normalized = normalizeAuth(auth);
    if (normalized === undefined) {
      return res.status(400).json({ error: '认证信息不完整' });
    }
    if (normalized) page.auth = normalized;
  } else if (type === 'custom') {
    // 自定义页面：创建资源目录 + 默认 index.html
    ensureCustomPageDir(page.id);
    page.entry = 'index.html';
    // 复制来源页面的自定义目录（复制操作）
    if (req.body.sourceId) {
      const srcDir = customPageDir(req.body.sourceId);
      if (fs.existsSync(srcDir)) copyDirSync(srcDir, customPageDir(page.id));
    } else {
      const defaultHtml = '<!DOCTYPE html>\n<html lang="zh-CN">\n<head><meta charset="UTF-8"><title>新页面</title></head>\n<body>\n<h1>自定义页面</h1>\n<p>上传 HTML/CSS/JS 文件开始编辑。</p>\n</body>\n</html>';
      fs.writeFileSync(path.join(customPageDir(page.id), 'index.html'), defaultHtml, 'utf8');
    }
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
app.put('/hilbert-api/pages/:id', (req, res) => {
  // 权限校验：需要该页面的 update 权限
  if (!hasPermission(req.user.email, req.params.id, 'update')) {
    return res.status(403).json({ error: '没有修改该页面的权限' });
  }
  const pages = readPages();
  const idx = pages.findIndex(p => p.id === req.params.id);
  if (idx === -1) {
    return res.status(404).json({ error: '页面不存在' });
  }
  const { type, name, url, icon, group, content, auth, proxyMode } = req.body || {};
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
  if (proxyMode !== undefined) {
    if (proxyMode === 'mount') current.proxyMode = 'mount';
    else delete current.proxyMode; // 切回恒等映射：移除该字段
  }
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
  if (icon !== undefined) current.icon = icon.trim() || ({ markdown: '📝', custom: '🖥️' }[current.type] || '🔗');
  if (group !== undefined) current.group = (group || '未分组').trim();

  // 按最终类型做一致性校验，并清理不属于该类型的字段
  if (current.type === 'link') {
    if (!isValidUrl(current.url)) return res.status(400).json({ error: '请输入合法的 http/https 链接' });
    deleteMdFile(current.content); // 类型切换为 link 时清理旧 md 文件
    delete current.content;
  } else {
    if (current.type === 'custom') {
      delete current.auth;
      delete current.url;
      if (req.body.entry !== undefined) {
        const entry = String(req.body.entry || 'index.html').trim();
        if (/[/\\]/.test(entry) || entry.includes('..')) return res.status(400).json({ error: '入口文件名不合法' });
        current.entry = entry || 'index.html';
      }
    } else {
      deleteCustomPageDir(current.id); // 类型切换为非 custom 时清理目录
      delete current.entry;
      delete current.auth; // markdown 页面不需要认证配置
      delete current.url;
    }
    if (current.type === 'markdown') {
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
  }

  pages[idx] = current;
  writePages(pages);
  res.json(resolvePage(current));
});

// 删除页面
app.delete('/hilbert-api/pages/:id', (req, res) => {
  // 权限校验：需要该页面的 delete 权限
  if (!hasPermission(req.user.email, req.params.id, 'delete')) {
    return res.status(403).json({ error: '没有删除该页面的权限' });
  }
  const pages = readPages();
  const idx = pages.findIndex(p => p.id === req.params.id);
  if (idx === -1) {
    return res.status(404).json({ error: '页面不存在' });
  }
  const [removed] = pages.splice(idx, 1);
  deleteMdFile(removed.content); // 同步删除对应的 md 文件
  deleteCustomPageDir(removed.id); // 同步删除自定义页面资源目录
  writePages(pages);
  res.json(removed);
});

// ---------- API：自定义页面文件管理 ----------

// 上传文件（支持多文件 + zip 包）
app.post('/hilbert-api/pages/:id/upload', (req, res) => {
  // 权限校验：需要该页面的 update 权限
  if (!hasPermission(req.user.email, req.params.id, 'update')) {
    return res.status(403).json({ error: '没有修改该页面的权限' });
  }
  upload.array('files', 50)(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    handleCustomUpload(req, res);
  });
});

// 列出文件
app.get('/hilbert-api/pages/:id/files', (req, res) => {
  const dir = customPageDir(req.params.id);
  if (!fs.existsSync(dir)) return res.json([]);
  const files = fs.readdirSync(dir).filter(f => {
    try { return fs.statSync(path.join(dir, f)).isFile(); } catch { return false; }
  }).map(name => ({ name, size: fs.statSync(path.join(dir, name)).size }));
  res.json(files);
});

// 删除单个文件
app.delete('/hilbert-api/pages/:id/files/:filename', (req, res) => {
  // 权限校验：需要该页面的 update 权限
  if (!hasPermission(req.user.email, req.params.id, 'update')) {
    return res.status(403).json({ error: '没有修改该页面的权限' });
  }
  const filename = path.basename(req.params.filename);
  if (!filename || filename.startsWith('.')) return res.status(400).json({ error: '文件名不合法' });
  const page = readPages().find(p => p.id === req.params.id && p.type === 'custom');
  if (!page) return res.status(404).json({ error: '页面不存在' });
  if (filename === (page.entry || 'index.html')) return res.status(400).json({ error: '不能删除入口文件' });
  const filePath = path.join(customPageDir(req.params.id), filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: '文件不存在' });
  fs.unlinkSync(filePath);
  res.json({ deleted: filename });
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
app.get('/hilbert-api/groups', (req, res) => {
  res.json(readGroups());
});

// 新增分组（仅超级管理员）
app.post('/hilbert-api/groups', requireAdmin, (req, res) => {
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

// 删除分组（该分组下的页面移至未分组，仅超级管理员）
app.delete('/hilbert-api/groups/:name', requireAdmin, (req, res) => {
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
// 所有 link 页面均经本代理转发：剥离目标站的 iframe 嵌入限制响应头、改写 Origin/Referer
// 通过目标站 CSRF 校验；配置了认证的页面还会自动注入认证头
// 支持三种认证模式：
//   basic  - 注入 Authorization: Basic 头（Nginx basic auth 类站点）
//   header - 注入自定义请求头（如 Grafana Service Account 的 Bearer 令牌）
//   login  - 服务端用账号密码调目标站登录接口换取会话 Cookie，缓存后注入每个请求，
//            会话过期（401 / 跳转登录页）时自动重新登录并重试

// login 模式的会话缓存：pageId -> 会话 Cookie 字符串
const sessionCache = new Map();

// ---------- 嵌入路径重写 ----------
// 两种代理模式：
//   恒等映射（默认）：代理路径即目标路径，目标 HTML 中的绝对路径（/xxl-job-admin/static/... 等）
//   浏览器向本服务器请求时天然走代理，无需拼前缀（拼前缀会导致路径重复而 404）；
//   不在已注册前缀下的路径（如 Grafana 的 /public/、/api/）由 Referer 兜底转发处理
//   挂载（/hilbert-proxy/<id>，页面配置 proxyMode=mount）：用于根路径站点（如 https://notes.abel.ai/，
//   其目标路径与面板根路径冲突）或恒等映射异常的站点，需把 HTML/CSS 中的绝对路径
//   全部重写到挂载前缀下
function rewriteHtml(html, prefix, appUrl) {
  let out = html
    // appUrl 改为代理的绝对地址，避免目标站构造的绝对链接指回其自身域名
    .replace(/"appUrl":"[^"]*"/, `"appUrl":"${appUrl}"`);
  if (prefix) {
    out = out
      // 让目标站前端在运行时以挂载前缀拼接所有 URL（Grafana bootData）
      .replace(/"appSubUrl":"([^"]*)"/, `"appSubUrl":"${prefix}$1"`)
      // 标签属性中的站内绝对路径：href="/xxx" → href="<prefix>/xxx"
      .replace(/((?:href|src|content|action|poster)\s*=\s*["'])\//g, '$1' + prefix + '/')
      // 内联脚本中的 /public 绝对路径赋值（如 __grafana_public_path__）
      .replaceAll('"/public/', `"${prefix}/public/`);
  }
  return out;
}

// 仅挂载模式：CSS 内 url(...) 绝对路径重写为挂载前缀
function rewriteCss(css, prefix) {
  return css.replace(/url\(\s*(["']?)\//g, 'url($1' + prefix + '/');
}

// 执行一次表单登录，返回会话 Cookie 字符串（登录失败则抛错）
function performLogin(page, base) {
  return new Promise((resolve, reject) => {
    const lib = base.protocol === 'https:' ? https : http;
    const auth = page.auth;
    // 按配置选择请求体格式：json（如 Grafana {user, password}）/ form 表单编码
    //（如 XXL-JOB 的 @RequestParam userName/password，不解析 JSON 请求体）
    const credentials = { [auth.userField]: auth.username, [auth.passwordField]: auth.password };
    const body = auth.loginFormat === 'form'
      ? new URLSearchParams(credentials).toString()
      : JSON.stringify(credentials);
    const contentType = auth.loginFormat === 'form'
      ? 'application/x-www-form-urlencoded'
      : 'application/json';
    const loginReq = lib.request(base.origin + auth.loginPath, {
      method: 'POST',
      headers: {
        'Content-Type': contentType,
        'Content-Length': Buffer.byteLength(body),
        'Accept': 'application/json'
      }
    }, loginRes => {
      const setCookies = loginRes.headers['set-cookie'] || [];
      const chunks = [];
      loginRes.on('data', c => chunks.push(c));
      loginRes.on('end', () => {
        if (loginRes.statusCode >= 200 && loginRes.statusCode < 300 && setCookies.length) {
          resolve(setCookies.map(c => c.split(';')[0]).join('; '));
          return;
        }
        // 附带目标站返回体片段，便于排查（如 XXL-JOB 登录失败也返回 200 + JSON 错误信息）
        const detail = Buffer.concat(chunks).toString('utf8').slice(0, 200);
        reject(new Error(`目标站登录失败 (HTTP ${loginRes.statusCode})${detail ? ': ' + detail : ''}，请检查账号密码、登录路径与请求格式`));
      });
      loginRes.on('error', reject);
    });
    loginReq.on('error', reject);
    loginReq.end(body);
  });
}

// 计算代理请求的实际目标地址（HTTP 转发与 WebSocket upgrade 共用）
// stripPrefix: 需剥离的挂载前缀。恒等映射（默认路由与 Referer 兜底）传 ''，目标路径即请求路径；
// 挂载模式（proxyMode=mount 页面的 /hilbert-proxy/<id>）剥离挂载前缀后转发
function resolveProxyTarget(page, originalUrl, stripPrefix = '') {
  const base = new URL(page.url);
  const basePath = base.pathname.replace(/\/+$/, '');

  const fileLike = /\/[^/]*\.[^/]*$/.test(basePath);

  // 挂载前缀后的子路径 + 查询串（合并页面 URL 自带的查询参数，同名参数去重）
  // 挂载模式请求路径正常带挂载前缀；Referer 兜底的逃逸资源不带前缀，此时不剥离，
  // 请求路径即目标路径
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
    // 挂载模式：目标路径 = 请求路径剥离挂载前缀（根请求取页面 URL 路径）
    targetPath = restPath === '/' ? (basePath || '/') : restPath;
  } else if (restPath === '/') {
    // 根请求：取页面 URL 路径
    targetPath = basePath || '/';
  } else {
    // 恒等映射：目标路径 = 请求路径
    targetPath = restPath;
  }
  
  return {
    base, basePath, fileLike, restPath, query,
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

// ---------- 动态代理路由注册 ----------
// 根据页面配置动态注册代理路由，使用页面 URL 的路径作为代理入口
// 例：页面 URL 为 https://xxl-job.example.com/xxl-job-admin/，则代理路径为 /xxl-job-admin/

// 存储已注册的代理路由，用于 WebSocket upgrade 与 Referer 兜底时查找页面
const proxyRoutes = new Map(); // pathPrefix -> { page, mount }（mount=true 为挂载路由）

// 最近经由代理转发的请求路径 -> 页面 id（来源归属链）：浏览器子资源可能以
//「已被代理的资源的 URL」作为 Referer（如 CSS 内 url() 触发的字体/图片请求，
// Referer 为该 CSS 自身的 URL），这类 Referer 本身不在已注册前缀下，
// 用「该路径最近一次由哪个页面转发」完成二次归属
const recentProxyPaths = new Map(); // reqPath -> pageId（插入序，超限淘汰最旧）
const RECENT_PROXY_PATHS_LIMIT = 5000;

function recordProxyPath(page, reqPath) {
  recentProxyPaths.set(reqPath, page.id);
  if (recentProxyPaths.size > RECENT_PROXY_PATHS_LIMIT) {
    recentProxyPaths.delete(recentProxyPaths.keys().next().value);
  }
}

function registerProxyRoutes() {
  proxyRoutes.clear();
  
  const pages = readPages().filter(p => p.type === 'link');
  const routesToRegister = [];
  
  for (const page of pages) {
    try {
      const url = new URL(page.url);
      const fullPath = url.pathname.replace(/\/+$/, '');

      // 挂载模式（编辑页面手动指定 proxyMode=mount）：统一从 /hilbert-proxy/<id> 进入，
      // 适用于根路径站点（与面板根路径冲突无法恒等映射）或恒等映射异常的站点
      if (page.proxyMode === 'mount') {
        const mountPath = '/hilbert-proxy/' + page.id;
        routesToRegister.push({ path: mountPath, page, mount: true, priority: mountPath.length });
        continue;
      }

      if (!fullPath) continue;
      
      // 提取所有可能的前缀路径
      // 例如：/xxl-job-admin/jobinfo -> [/xxl-job-admin, /xxl-job-admin/jobinfo]
      const segments = fullPath.split('/').filter(Boolean);
      const prefixes = [];
      let currentPath = '';
      for (const seg of segments) {
        currentPath += '/' + seg;
        prefixes.push(currentPath);
      }
      
      for (const prefix of prefixes) {
        routesToRegister.push({ path: prefix, page, mount: false, priority: prefix.length });
      }
    } catch { /* 无效 URL 忽略 */ }
  }
  
  // 按优先级排序（路径越长优先级越高）
  routesToRegister.sort((a, b) => b.priority - a.priority);
  
  // 注册路由（去重，同一路径只注册一次）
  const registeredPaths = new Set();
  for (const { path, page, mount } of routesToRegister) {
    if (registeredPaths.has(path)) continue;
    registeredPaths.add(path);
    
    proxyRoutes.set(path, { page, mount });
    
    app.use(path, (req, res, next) => {
      const currentPage = readPages().find(p => p.id === page.id && p.type === 'link');
      // 页面被删除，或代理模式已变更时放行：重注册会压入新路由，
      // 旧路由的中间件仍在栈中，靠模式一致性校验避免陈旧路由接管请求
      if (!currentPage || (currentPage.proxyMode === 'mount') !== mount) return next();
      handleProxyRequest(currentPage, req, res, mount ? null : path, mount ? path : undefined);
    });
  }
}

// 页面变更时重新注册（通过代理 writePages）
const originalWritePages = writePages;
writePages = function(pages) {
  originalWritePages(pages);
  registerProxyRoutes();
  registerCustomRoutes();
};

// 代理转发主体
// matchedPath: 实际匹配的恒等路由路径（恒等映射时目标路径 = 请求路径）
// mountPrefix: 挂载模式页面的挂载路径（/hilbert-proxy/<id>），转发时剥离挂载前缀，并重写 HTML/CSS 绝对路径
function handleProxyRequest(page, req, res, matchedPath, mountPrefix) {
  // 记录路径归属，供 Referer 兜底的归属链规则（findPageByReferer ③）使用
  recordProxyPath(page, req.originalUrl.split('?')[0]);
  const resolved = resolveProxyTarget(page, req.originalUrl, mountPrefix || '');
  const { base, target } = resolved;
  // 重写前缀：挂载模式把绝对路径重写为挂载前缀；恒等映射无需重写
  const rewritePrefix = mountPrefix || '';

  // 页面 URL 指向深层路径（如 Grafana 仪表盘 /d/xxx，属 SPA 路由而非目录）时，
  // 对「代理入口根」的请求先跳转到页面 URL 路径，让目标站前端路由看到正确入口；
  // 文件式 URL 除外（根请求直接返回文件本身，相对资源按文件目录解析）
  // 仅当匹配路径短于页面 URL 路径时才重定向，避免无限循环
  const reqPath = req.originalUrl.split('?')[0];
  const atEntryRoot = !mountPrefix && (matchedPath
    ? (reqPath === matchedPath || reqPath === matchedPath + '/')
    : resolved.restPath === '/');
  if (atEntryRoot && resolved.basePath && !resolved.fileLike &&
    (!matchedPath || matchedPath.length < resolved.basePath.length)) {
    // 重定向到页面 URL 路径（basePath）
    return res.redirect(302, resolved.basePath
      + (resolved.query ? '?' + resolved.query : ''));
  }

  const auth = page.auth;
  const lib = base.protocol === 'https:' ? https : http;
  // HTML 重写时把 appUrl 改为代理的绝对地址（挂载模式拼挂载前缀）
  const appUrl = (req.headers['x-forwarded-proto'] || 'http') + '://' + req.headers.host + rewritePrefix + '/';

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
      // 压缩协商：只声明本服务能解压的编码（浏览器可能额外发送 zstd 等，
      // HTML/CSS 重写遇到无法解压的编码会输出损坏内容）；JS/API 等非重写
      // 响应仍会返回压缩数据并原样透传，减少传输量
      headers['accept-encoding'] = 'gzip, deflate, br';
      headers['content-length'] = bodyBuf.length;

      await applyAuthHeaders(page, headers);

      await new Promise((resolve, reject) => {
        const agent = base.protocol === 'https:' ? httpsAgent : httpAgent;
        const proxyReq = lib.request(target, { method: req.method, headers, agent }, proxyRes => {
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
          // 把指向目标站的跳转重写为本服务器同路径，避免跳出后丢失认证
          //（恒等映射保持原路径；挂载模式拼挂载前缀）
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
          // 恒等映射只重写 HTML 中的 appUrl；挂载模式还需重写 HTML/CSS 绝对路径为挂载前缀
          const rewrite = isHtml ? rewriteHtml : (rewritePrefix && /text\/css/.test(contentType)) ? rewriteCss : null;
          if (!rewrite) {
            // 无需重写（JS/CSS/图片/API 数据等）：压缩响应原样透传，不解压，节省传输
            res.writeHead(proxyRes.statusCode, resHeaders);
            proxyRes.pipe(res);
            proxyRes.on('end', resolve);
            proxyRes.on('error', reject);
            return;
          }
          // HTML(/CSS) 需文本重写：若目标站返回压缩响应，先解压再重写，最后按未压缩返回
          const encoding = String(resHeaders['content-encoding'] || '').toLowerCase();
          // 未知编码（如 zstd）无法解压重写，直接报错，避免输出损坏内容
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



// 按 Referer 识别来源页面（HTTP 兜底与 WebSocket upgrade 共用）：
// 目标站资源不一定落在已注册代理前缀下（如 Grafana 前端运行时动态注入的
// /avatar/...）。返回 { page, mountPrefix }：
//   ① Referer 路径按已注册代理路由前缀做最长匹配：恒等路由命中按原路径转发；
//      挂载路由命中时带挂载前缀——挂载页面的 HTML/CSS 重写覆盖不到 JS 运行时
//      动态插入的绝对路径资源，这类请求会以原路径逃逸到本服务器
//   ② 未命中再按 Referer origin 匹配页面目标 URL 的 origin（如页面经站内跳转
//      到了未注册的路径），仅恒等映射页面适用
//   ③ Referer 指向的路径本身是经由本代理转发过的资源（如 CSS 的 URL）：
//      按该路径最近一次的转发归属确定来源页面
function findPageByReferer(referer) {
  let refUrl;
  try {
    refUrl = new URL(referer);
  } catch {
    return null; // 非法 Referer 忽略
  }
  // ① 已注册代理路由前缀最长匹配（跳过模式已变更的陈旧条目）
  let page = null;
  let mountPrefix = null;
  let bestLen = 0;
  for (const [pathPrefix, entry] of proxyRoutes) {
    if ((entry.page.proxyMode === 'mount') !== entry.mount) continue;
    if ((refUrl.pathname === pathPrefix || refUrl.pathname.startsWith(pathPrefix + '/')) &&
        pathPrefix.length > bestLen) {
      page = entry.page;
      bestLen = pathPrefix.length;
      mountPrefix = entry.mount ? pathPrefix : null;
    }
  }
  if (page) return { page, mountPrefix };
  // ② 目标站 origin 匹配：面板自身 origin（恒等映射页面 URL 无路径时与目标
  // origin 相同）不参与，避免把面板请求误转发给目标站
  const refOrigin = refUrl.origin;
  let best = null;
  for (const p of readPages()) {
    if (p.type !== 'link' || p.proxyMode === 'mount') continue;
    let target;
    try {
      target = new URL(p.url);
    } catch {
      continue;
    }
    if (target.origin === refOrigin) {
      if (!best || target.pathname.length > new URL(best.url).pathname.length) best = p;
    }
  }
  if (best) return { page: best, mountPrefix: null };
  // ③ 归属链：Referer 路径最近一次由哪个页面转发，资源就归属于哪个页面
  const servedBy = recentProxyPaths.get(refUrl.pathname);
  if (servedBy) {
    const p = readPages().find(x => x.id === servedBy && x.type === 'link');
    if (p) {
      return {
        page: p,
        mountPrefix: p.proxyMode === 'mount' ? '/hilbert-proxy/' + p.id : null
      };
    }
  }
  return null;
}

// ---------- Referer 兜底转发 ----------
// 新架构代理路径即目标路径，但目标站的资源可能不在已注册前缀之下
//（如 Grafana 的 /public/build/xxx.js、/api/...、/avatar/...）。此类请求通过
// Referer 识别来源页面后转发（规则见 findPageByReferer）
app.use((req, res, next) => {
  const reqPath = req.url.split('?')[0];
  // 管理 API 不参与兜底；命中已注册代理前缀的请求交给动态路由处理
  if (reqPath.startsWith('/hilbert-api') || reqPath.startsWith('/hilbert-custom')) return next();
  for (const pathPrefix of proxyRoutes.keys()) {
    if (reqPath === pathPrefix || reqPath.startsWith(pathPrefix + '/')) return next();
  }
  const found = findPageByReferer(req.headers.referer);
  if (!found) return next();
  // 恒等映射按原路径转发；挂载页面逃逸资源带挂载前缀（剥离/重写逻辑与挂载路由一致）
  handleProxyRequest(found.page, req, res, '', found.mountPrefix || undefined);
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

// 启动时注册代理路由与自定义页面静态路由（必须在所有函数定义之后）
registerProxyRoutes();
registerCustomRoutes();

// 自定义页面静态资源分发（只注册一次，内部按 pageId 动态查找）
app.use('/hilbert-custom', customPagesDispatcher);

const server = app.listen(PORT, HOST, () => {
  console.log(`后台已启动: http://${HOST}:${PORT}`);
});

// ---------- WebSocket 转发（Grafana live 等实时通道） ----------
// Express 中间件不处理 upgrade 请求，需在 HTTP server 层接管并双向管道透传
server.on('upgrade', async (req, socket, head) => {
  // 通过请求路径匹配代理页面（新架构：代理路径即页面 URL 路径）
  const reqPath = req.url.split('?')[0];
  let page = null;
  let matchedPath = null;
  
  // 查找匹配的代理路由（最长前缀匹配）；跳过模式已变更的陈旧路由
  let mountPrefix;
  for (const [pathPrefix, entry] of proxyRoutes) {
    if ((entry.page.proxyMode === 'mount') !== entry.mount) continue; // 跳过陈旧条目
    if (reqPath === pathPrefix || reqPath.startsWith(pathPrefix + '/')) {
      if (!matchedPath || pathPrefix.length > matchedPath.length) {
        page = entry.page;
        matchedPath = pathPrefix;
        mountPrefix = entry.mount ? pathPrefix : undefined;
      }
    }
  }

  // 未命中时通过 Referer 识别来源页面转发（规则见 findPageByReferer）
  //（如 Grafana live 的 /api/live/ws 不在已注册前缀下）
  if (!page && req.headers.referer) {
    const found = findPageByReferer(req.headers.referer);
    if (found) {
      page = found.page;
      mountPrefix = found.mountPrefix || undefined;
      matchedPath = ''; // 按原路径转发
    }
  }

  if (!page || page.type !== 'link') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }
  
  try {
    const { base, target } = resolveProxyTarget(page, req.url, mountPrefix || '');
    const headers = { ...req.headers };
    delete headers.host;
    headers.origin = base.origin; // 改写为目标站域名，通过 CSRF 校验
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
