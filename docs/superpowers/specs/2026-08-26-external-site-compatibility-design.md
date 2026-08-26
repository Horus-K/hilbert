# 外部网站兼容性增强设计

## 目标

在现有逐页面通配子域名代理上，按顺序提高标准 Web 应用的接入覆盖率，同时保留页面级 RBAC、主站 Cookie 隔离、WebSocket 转发和现有自动认证。

“全部网站”指可通过标准 HTTP/HTTPS、Cookie、重定向、SSE 或 WebSocket 工作的站点。客户端证书、WebAuthn、DRM、WebTransport、反自动化及强制顶层窗口策略不承诺在 iframe 中运行，失败时使用页面专属代理地址的新标签页模式。

## 全局约束

- Node.js `>=24.19.0`，不新增 npm 依赖。
- 默认行为保持 `server` 会话模式，旧页面无需迁移。
- 浏览器会话和 origin 映射仅在逐页面 Host 路由模式启用。
- 浏览器会话不能与 origin 映射组合；映射 origin 默认不接收页面认证，可信 alias 必须显式加入 `authOrigins`。
- `hilbert_token` 与 `hilbert_proxy_session` 永不转发给上游，也不允许上游覆盖。
- 所有新增网络入口执行目标地址策略；云元数据地址始终拒绝。
- 每项非平凡行为先写一个会失败的 `node:test`，再做最小实现。
- 不重写任意 JavaScript 源码，不加入产品专用适配器。

## 七个阶段

### 1. 兼容性基线

用本地真实 HTTP 服务记录当前代理对相对资源、同源绝对 URL、重定向、Cookie、SSE 和 WebSocket 的行为。测试只依赖 Node 标准库，线上网站不进入自动测试。

### 2. 浏览器 Cookie 会话

链接页面增加 `sessionMode: "server" | "browser"`，默认 `server`。`browser` 模式把上游 Cookie 改写为页面 Host-only Cookie，浏览器请求时仅过滤 Hilbert 保留 Cookie，其余 Cookie 转发给上游。该模式支持依赖 `document.cookie` 或用户手动登录的网站。

### 3. Origin 映射

链接页面增加 `origins: { [alias]: "https://origin.example" }` 和可选 `authOrigins: string[]`。代理保留路径 `/.hilbert/upstream/<alias>/...` 映射到对应上游；HTML、CSS、Location、Refresh、Referer 与 WebSocket 共用映射。alias 只接受小写 DNS 标签格式，目标值必须是无路径、查询和片段的 HTTP/HTTPS origin。页面认证默认只发送给主 origin，只有 `authOrigins` 中明确列出的 alias 才接收凭据。

### 4. 交互式登录

所有链接页面提供“在新标签页打开”入口。浏览器会话页面可在同一页面专属 Host 完成人工登录，iframe 随后共享 Cookie。iframe 仅增加用户触发的顶层导航和 Storage Access 权限，不增加无用户操作的顶层跳转权限。

### 5. 网络和资源边界

使用 `net.isIP`、`net.BlockList`、`dns.lookup` 实现目标策略。公网默认允许；私网仅允许 `PAGE_TARGET_ALLOW_PRIVATE_CIDRS` 列出的范围；loopback、link-local 和云元数据地址默认拒绝，其中云元数据地址即使出现在允许列表也拒绝。检查主目标、origin 映射、认证端点、DNS 解析结果、`resolveIp` 和重定向目标。

请求体、可重写响应和请求时间分别受 `PAGE_PROXY_MAX_BODY_BYTES`、`PAGE_PROXY_MAX_REWRITE_BYTES`、`PAGE_PROXY_TIMEOUT_MS` 限制。默认值分别为 10 MiB、5 MiB、30 秒。

### 6. 兼容性诊断

现有诊断增加最多五跳重定向链、Set-Cookie、未知跨 origin Location 和 HTML 中绝对 origin 摘要，并给出 `server`、`browser`、`origin-map` 或 `new-tab` 建议。结果不包含 Cookie 值、认证头或响应正文。

### 7. 运行时拦截决策

复查前六阶段测试与真实失败样本。只有已配置 origin 仍因 JavaScript 动态构造绝对 URL 失败时，才注入最小 fetch/XHR/WebSocket 拦截器；没有样本则不写脚本，并把该阶段记录为“无需实现”。

## 验收

- 旧页面数据和默认代理行为不变。
- 浏览器模式不会向上游泄露 Hilbert Cookie。
- 配置的关联 origin 可经同一页面 Host 转发 HTTP 和 WebSocket。
- 非允许私网、云元数据地址、超限主体和超时请求被明确拒绝。
- 诊断能指出未知 origin 与推荐接入模式。
- `npm test` 全部通过。
