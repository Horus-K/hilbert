const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const pagesService = require('../services/pages.service');
const { hasPermission, isAdmin } = require('../services/rbac.service');

/**
 * GET /page/:id — 独立页面查看器（每个页面拥有独立浏览器 URL）
 */
router.get('/:id', (req, res) => {
  const email = req.user.email;
  const allPages = pagesService.getAllPages(email, isAdmin, hasPermission);
  const page = allPages.find(p => p.id === req.params.id);

  if (!page) {
    return res.status(404).send('页面不存在或无权访问');
  }

  // 直链页面：直接重定向到目标 URL
  if (page.type === 'direct') {
    return res.redirect(page.url);
  }

  // 读取 page.html 模板并注入页面数据
  const templatePath = path.join(__dirname, '../../public/page.html');
  let html = fs.readFileSync(templatePath, 'utf8');

  // 计算 iframe 源地址
  let iframeSrc = '';
  if (page.type === 'link') {
    const pageUrl = new URL(page.url);
    const pagePath = pageUrl.pathname.replace(/\/+$/, '');
    iframeSrc = (page.proxyMode === 'mount'
      ? '/hilbert-proxy/' + page.id + '/'
      : (pagePath || '/')) + (pageUrl.search || '');
  } else if (page.type === 'custom') {
    iframeSrc = '/hilbert-custom/' + page.id + '/' + (page.entry || 'index.html');
  } else if (page.type === 'iframe') {
    iframeSrc = page.url;
  }

  // 构建页面数据（markdown 不传大段正文，由客户端调 API 加载）
  const pageData = {
    id: page.id,
    name: page.name,
    icon: page.icon,
    type: page.type,
    iframeSrc
  };

  const dataScript = `<script>window.__PAGE_DATA__=${JSON.stringify(pageData).replace(/</g, '\\u003c')}</script>`;
  html = html.replace('</head>', `${dataScript}\n</head>`);

  // 设置页面标题
  const title = (page.icon || '') + ' ' + page.name;
  html = html.replace('<title>页面查看</title>', `<title>${title.replace(/</g, '&lt;')}</title>`);

  res.type('html').send(html);
});

/**
 * GET /page/:id/content — 获取 Markdown 页面正文（供独立查看器异步加载）
 */
router.get('/:id/content', (req, res) => {
  const email = req.user.email;
  const allPages = pagesService.getAllPages(email, isAdmin, hasPermission);
  const page = allPages.find(p => p.id === req.params.id);

  if (!page) {
    return res.status(404).json({ error: '页面不存在或无权访问' });
  }

  if (page.type !== 'markdown') {
    return res.status(400).json({ error: '仅 Markdown 页面支持内容接口' });
  }

  res.json({ content: page.content || '' });
});

module.exports = router;
