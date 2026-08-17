const { createApp } = require('./app');
const { setupWebSocket } = require('./proxy/websocket');
const { migrateInlineMarkdown } = require('./services/markdown.service');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// 启动时把旧版内联的 Markdown 内容迁移为独立文件
migrateInlineMarkdown();

// 创建 Express 应用
const app = createApp();

// 启动 HTTP 服务器
const server = app.listen(PORT, HOST, () => {
  console.log(`后台已启动: http://${HOST}:${PORT}`);
});

// WebSocket 转发
setupWebSocket(server);
