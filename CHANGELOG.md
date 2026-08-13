# 更新日志

## v1.0.0（首次发版）

首个可用版本：多页面嵌入的后台管理面板。

### 功能

- 页面管理：新增 / 编辑 / 删除，支持 `link`（iframe 嵌入）与 `markdown`（内置文档）两种类型
- Markdown 文档右侧原地编辑，正文以独立 `.md` 文件存储于 `data/pages/`
- 分组管理：页面按分组归类，支持新建 / 删除分组
- 反向代理自动认证：`basic`（Basic Auth 头）/ `login`（表单登录换会话 Cookie，过期自动重登）/ `header`（自定义请求头）
- 深度代理适配（Grafana 已验证）：
  - 剥离 `X-Frame-Options` / CSP，支持 iframe 嵌入
  - HTML/CSS 绝对路径重写 + `appSubUrl` 注入，支持深层路由（仪表盘 URL）与子目录部署
  - Origin/Referer 改写兼容 Grafana CSRF 校验
  - WebSocket 双向透传（Grafana live）
  - 根路径逃逸请求按 Referer 兜底转发
- JSON 文件持久化（`data/` 目录），无数据库依赖
- 健康检查接口 `GET /api/health`，配套 Dockerfile（多阶段构建、非 root、HEALTHCHECK）
