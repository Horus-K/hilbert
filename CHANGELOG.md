# 更新日志

- 分组改用稳定 `groupId` 关联页面；旧名称关联数据会自动迁移，重命名不再需要同步改写页面。

## Unreleased

- 外部链接新增服务端/浏览器 Cookie 会话模式；浏览器模式支持人工登录和 `document.cookie`，并过滤 Hilbert 保留 Cookie。
- 新增关联 origin 映射，标准 HTML/CSS URL、Location、Refresh、Referer、HTTP 与 WebSocket 共用 `/.hilbert/upstream/<alias>/` 路由；页面认证仅向显式信任的 alias 转发。
- 外部页面菜单新增“在新标签页打开”，iframe 增加用户触发的顶层导航和 Storage Access 权限。
- 新增私网 CIDR 允许列表、云元数据硬拒绝、DNS/`resolveIp` 检查、请求体/重写体上限和统一上游超时。
- 代理诊断新增最多五跳重定向、Cookie 存在性、未知 origin 和接入模式建议，结果不包含 Cookie 值或响应正文。
- 增加 SSE、重定向、浏览器 Cookie、origin 映射和代理资源边界回归测试；未加入无失败样本支撑的 JavaScript 运行时拦截。
- 备份与恢复新增本地 zip 上传恢复选项；上传文件会校验格式和大小，恢复前仍自动创建安全备份。
- 外部页面内容迁移到独立代理 origin，Hilbert UI/API 不再与目标脚本同源。
- 所有外部页面统一使用独立挂载命名空间，动态路由改为单一内存 dispatcher。
- 目标 Cookie 按页面和用户在服务端隔离，Hilbert Cookie 不再转发给目标站。
- HTML/CSS/Location 重写改为标准 URL 语义，移除应用私有字段适配。
- Origin/Referer、登录成功/过期状态与身份 claims 改为通用、可配置策略。
- 恢复“完整 Google 用户资料”和“Google access_token”身份透传开关，并增加资料脱敏与 token 过期保护。
- 修复“清除资源缓存并重新加载”误删侧边栏常驻和分组折叠偏好的问题。
- 页面 API 不再返回密码、Header Token 或 OAuth Client Secret；编辑时 Secret 留空会安全保留原值。
- JSON Repository 改为原子写入、自动生成 .bak，并在主文件损坏时自动恢复。
- 修复分组排序可提交重复项的问题，并补充服务端名称规范化。
- RBAC 权限保存时严格校验页面和动作，合并重复 pageId，修复“全部页面 + 新增页面”状态丢失。
- 删除页面时同步清理角色中的页面权限和所有用户收藏。
- 新增脱敏审计日志、保留策略和设置页查询。
- 新增完整数据备份、下载、恢复前安全备份和确认式恢复。
- 新增系统运行状态与逐页面代理/DNS/TLS/认证诊断。
- 页面认证 Secret 改为 AES-256-GCM 静态加密，支持从 JWT 派生和显式密钥轮换。
- 主站与代理 JWT 增加 sid 注册表，支持查看、级联撤销和立即关闭关联 WebSocket。
- DNS 覆盖保持 TLS 证书验证开启。
- 新增代理核心与 HTTP 集成回归测试。
- 修复点击横向标签页后浏览器 `/page/<页面id>` 路径未同步的问题。
- 实现逐页面通配子域名代理：严格按 Host 提取页面 ID，HTTP 与 WebSocket 使用同一路由及 RBAC 校验。
- 主站通过短时一次性随机票据换取页面 Host-only 会话，不向代理子域名共享 Hilbert JWT。
- 页面公开路径完整镜像上游路径，根路径 API、静态资源和 WebSocket 不再依赖 Referer 猜测。
- 保留共享代理 origin + 挂载路径作为未配置 Host 模板时的兼容模式。
- 新增通配 Host、票据单次消费、页面会话绑定和完整 HTTP/WebSocket 路由回归测试。

## v1.4.1

侧边栏交互优化：改为 hover 自动展开/收起模式。

### 变更

- **侧边栏交互重构**：
  - 侧边栏默认收起，采用 overlay 模式覆盖在内容上方（`position: absolute`）
  - 左侧边缘新增 8px 宽的不可见触发区域，鼠标悬停自动展开侧边栏
  - 触发区域带有半透明白色提示条（3px × 40px），hover 时变亮变长，提示用户此处可交互
  - 鼠标离开侧边栏区域后自动收起，带 300ms 防抖避免动画期间误收
  - 点击页面项或进入设置页后侧边栏立即收起
  - 移除原有的手动收起/展开按钮

## v1.4.0

后端架构重构：将 1769 行单体 `server.js` 拆分为 25+ 个模块化文件，采用 Controller-Service-Repository 三层架构。

### 变更

- **后端架构重构**：
  - 引入三层分层架构：Routes（Controller）→ Services → Repositories，职责清晰、依赖单向
  - `server.js` 拆分为 25+ 个独立模块文件，最大文件不超过 200 行
  - 新增 `src/` 目录结构：`config/`、`middleware/`、`routes/`、`services/`、`repositories/`、`proxy/`、`utils/`
- **代理子系统独立封装**：
  - 反向代理拆分为独立 `src/proxy/` 子模块，包含连接池、DNS 覆盖、HTML/CSS 重写、会话缓存、WebSocket 透传
  - 所有高性能机制完整保留，无性能损耗
- **事件驱动路由刷新**：
  - 用 `EventEmitter` 替代原 `writePages` monkey-patch，页面变更自动刷新代理路由与自定义页面托管
- **统一错误处理**：
  - 新增 `AppError` 业务异常类 + `errorHandler` 中间件，业务层抛错即可自动返回正确状态码
- **向后兼容**：
  - 根目录 `server.js` 保持为入口（2 行转发），`npm start` 无需任何修改
  - 所有外部 API 路径与行为保持不变

### 新增文件

- `src/config/index.js` — 统一配置管理
- `src/middleware/` — 安全响应头、JWT 认证、管理员守卫
- `src/routes/` — 6 个路由模块（health、auth、callback、user、rbac、pages、groups、favorites）
- `src/services/` — 7 个服务模块（auth、rbac、pages、markdown、custom-pages、groups、favorites）
- `src/repositories/` — 4 个数据访问模块（pages、groups、roles、favorites）
- `src/proxy/` — 7 个代理模块（agents、rewriter、auth-injector、proxy-handler、route-manager、websocket、index）
- `src/utils/` — 工具模块（errors、validators、file-utils）

## v1.3.0

新增分组编辑与拖拽排序、直链页面类型、用户收藏栏、分组折叠功能。

### 新增

- **分组管理增强**：
  - 支持双击编辑分组名称，inline 编辑模式（回车保存 / Esc 取消）
  - 支持拖拽排序分组顺序（HTML5 Drag & Drop），拖拽完成后自动保存
  - 左侧分组可点击折叠/展开，默认折叠状态，折叠状态持久化到 localStorage
  - 新增 API：`PUT /hilbert-api/groups/:name`（重命名）、`PUT /hilbert-api/groups/order`（排序）
- **直链页面类型 (`direct`)**：点击后在新标签页直接打开目标链接，不走 iframe 嵌入，无需配置认证/代理
  - 页面类型切换新增「↗️ 直链」选项
  - 侧边栏显示 `DL` 类型徽标
  - 页面类型从三种扩展为四种（`link` / `markdown` / `custom` / `direct`）
- **用户收藏栏**：
  - 左侧边栏新增「⭐ 收藏」区域，每个用户可独立收藏不同页面
  - 服务端存储（`data/favorites/<邮箱>.json`），支持跨设备同步
  - 页面项增加星标按钮 ☆/★，点击切换收藏状态
  - 收藏区域显示已收藏页面列表，带金色竖条标识，hover 显示取消收藏按钮
  - 新增 API：`GET/PUT /hilbert-api/favorites`（获取/设置）、`POST /hilbert-api/favorites/toggle`（切换）

### 变更

- 页面类型从三种扩展为四种（`link` / `markdown` / `custom` / `direct`）
- 分组管理描述文字更新，提示支持拖拽和编辑

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
