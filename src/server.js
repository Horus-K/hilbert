const { createApp } = require('./app');
const { createProxyApp } = require('./proxy/proxy-app');
const { setupWebSocket } = require('./proxy/websocket');
const { migrateInlineMarkdown } = require('./services/markdown.service');
const { external_proxy: externalProxyConfig } = require('../config');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// 启动时把旧版内联的 Markdown 内容迁移为独立文件
migrateInlineMarkdown();

// 创建 Express 应用
const app = createApp();
const proxyApp = createProxyApp();

// 启动 HTTP 服务器
const server = app.listen(PORT, HOST, () => {
  console.log(`后台已启动: http://${HOST}:${PORT}`);
});

// 外部页面使用独立监听端口，浏览器侧与 Hilbert UI 形成不同 origin。
const proxyServer = proxyApp.listen(externalProxyConfig.listen_port, HOST, () => {
  console.log(`外部页面代理已启动: http://${HOST}:${externalProxyConfig.listen_port}`);
});

// WebSocket 仅在隔离的代理 origin 上转发。
setupWebSocket(proxyServer);

module.exports = { server, proxyServer };
