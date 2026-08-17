const path = require('path');
const baseConfig = require('../../config');

// 数据路径
const DATA_DIR = path.join(__dirname, '../../data');
const DATA_FILE = path.join(DATA_DIR, 'pages.json');
const GROUPS_FILE = path.join(DATA_DIR, 'groups.json');
const ROLES_FILE = path.join(DATA_DIR, 'roles.json');

// Markdown 文件存储
const PAGES_DIR = path.join(DATA_DIR, 'pages');
const CONTENT_PREFIX = '/data/pages/';

// 自定义页面静态资源存储
const CUSTOM_PAGES_DIR = path.join(DATA_DIR, 'custom-pages');

// 用户收藏存储
const FAVORITES_DIR = path.join(DATA_DIR, 'favorites');

// 业务常量
const PAGE_TYPES = ['link', 'markdown', 'custom', 'direct'];
const ALL_ACTIONS = ['read', 'create', 'update', 'delete'];

// 默认页面配置（首次启动时写入）
const DEFAULT_PAGES = [];

// 文件上传限制
const MAX_UPLOAD_SIZE = 10 * 1024 * 1024; // 10MB
const ALLOWED_EXTENSIONS = new Set([
  '.html', '.htm', '.css', '.js', '.json', '.xml', '.svg',
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.mp3', '.mp4', '.webm', '.ogg', '.wav', '.pdf'
]);

// 超级管理员邮箱列表
const ADMIN_EMAILS = baseConfig.admin_emails || [];
if (ADMIN_EMAILS.length === 0) {
  console.warn('⚠️  未配置超级管理员邮箱 (ADMIN_EMAIL)，RBAC 通配符分配将影响所有用户包括实际管理员');
}

module.exports = {
  ...baseConfig,
  DATA_DIR,
  DATA_FILE,
  GROUPS_FILE,
  ROLES_FILE,
  PAGES_DIR,
  CONTENT_PREFIX,
  CUSTOM_PAGES_DIR,
  FAVORITES_DIR,
  PAGE_TYPES,
  ALL_ACTIONS,
  DEFAULT_PAGES,
  MAX_UPLOAD_SIZE,
  ALLOWED_EXTENSIONS,
  ADMIN_EMAILS,
};
