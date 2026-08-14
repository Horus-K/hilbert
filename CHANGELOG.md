# 更新日志

## v1.2.0

新增 Google SSO 单点登录、RBAC 权限管理、环境变量配置。

### 新增

- **Google SSO 认证**：基于 Google OAuth2 的登录流程，JWT 会话管理，支持邮箱白名单（按域名或具体邮箱限制登录）
- **RBAC 权限管理**：
  - 基于角色的访问控制，支持自定义角色并分配页面级权限（查看/新增/修改/删除）
  - 支持将角色分配给指定邮箱，支持通配符邮箱模式（如 `*@domain.com`）
  - 超级管理员拥有全部权限并可管理 RBAC 配置，仅管理员可访问设置页
  - 权限感知渲染：侧边栏、操作按钮根据当前用户权限动态显示/隐藏
- **环境变量配置**：所有敏感配置（OAuth 凭据、JWT 密钥、管理员邮箱等）统一通过环境变量管理，支持 `.env` 文件或系统环境变量
- **新增 API**：
  - `GET /hilbert-api/me` — 当前用户信息
  - `GET /hilbert-api/my-permissions` — 当前用户权限
  - `GET/POST/PUT/DELETE /hilbert-api/rbac/roles` — 角色管理
  - `GET/POST/DELETE /hilbert-api/rbac/assignments` — 邮箱-角色分配管理

### 变更

- 配置方式从 `config.js` 硬编码默认值改为 `.env` 环境变量，敏感信息不再出现在代码中
- 页面 API（GET/POST/PUT/DELETE）增加权限校验中间件
- 分组管理 API（POST/DELETE）限制为仅超级管理员可操作
- 新增依赖：`dotenv`（环境变量加载）、`jsonwebtoken`（JWT 会话）、`undici`（Google API 出站代理）
- Dockerfile 新增 `config.js` 复制

## v1.1.0

新增自定义前端页面类型、文件管理弹窗化、SVG favicon、侧边栏版本号。

### 新增

- **自定义页面类型 (`custom`)**：上传 HTML/CSS/JS/图片等静态资源（支持 zip 包），后端以独立静态目录托管（`/hilbert-custom/<页面id>/`），iframe 预览
- **文件管理弹窗化**：文件上传/管理集成到新建/编辑页面弹窗中，选择 custom 类型时自动显示文件上传区
- **SVG favicon**：紫蓝渐变圆角背景 + 白色 "H" 字母
- **侧边栏版本号**：左上角「控制台」旁显示当前版本号徽标
- **新增 API**：
  - `POST /hilbert-api/pages/:id/upload` — 上传文件
  - `GET /hilbert-api/pages/:id/files` — 文件列表
  - `DELETE /hilbert-api/pages/:id/files/:filename` — 删除文件
  - `GET /hilbert-api/version` — 版本号

### 变更

- 页面类型从两种扩展为三种（`link` / `markdown` / `custom`）
- 新增依赖：`multer`（文件上传）、`adm-zip`（zip 解压）
- Dockerfile 新增 `custom-pages` 数据目录

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
