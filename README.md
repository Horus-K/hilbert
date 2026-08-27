# hilbert

可配置多页面嵌入的后台管理面板：ChatGPT 风格深色 UI，左侧页面列表 + 右侧内容区，把散落在各处的监控面板、内部系统、文档聚合到一个入口。

## 功能特性

- **Google SSO 单点登录**：基于 Google OAuth2 的登录流程，JWT 会话管理，支持邮箱白名单（按域名或具体邮箱限制登录）
- **Debug 登录模式**：通过环境变量开启后可跳过 Google OAuth，直接以预设调试用户登录，便于本地开发与联调
- **RBAC 权限管理**：
  - 基于角色的访问控制，支持自定义角色并分配页面级权限（查看/新增/修改/删除）
  - 支持将角色分配给指定邮箱，支持通配符邮箱模式（如 `*@domain.com`）
  - 超级管理员拥有全部权限并可管理 RBAC 配置
  - 权限感知渲染：侧边栏、操作按钮根据当前用户权限动态显示/隐藏
- **三种页面类型**
  - `link`：通过隔离反向代理 origin 嵌入外部系统
  - `markdown`：内置 Markdown 文档，右侧原地编辑，正文以独立 `.md` 文件存储
  - `custom`：自定义前端页面，上传 HTML/CSS/JS 等静态资源，后端独立静态目录托管（`/hilbert-custom/<页面id>/`）
- **分组管理**：页面按分组归类，支持新建/删除分组
- **反向代理自动认证**（核心能力，解决 iframe 无法携带认证的问题）
  - `basic`：自动注入 `Authorization: Basic` 头（适用于 Nginx basic auth 站点）
  - `login`：服务端完成 JSON/表单登录并按状态码策略维护会话 Cookie
  - `header`：注入任意自定义请求头（如 Bearer 令牌）
- **通用隔离代理**
  - 外部内容与 Hilbert UI/API 分别监听不同端口，浏览器侧不同源
  - 推荐每个页面使用独立通配子域名，由严格校验的 Host 同时路由 HTTP 与 WebSocket
  - 短时一次性票据换取页面 Host-only 会话，不向代理子域名共享主站 JWT
  - 标准 HTML/CSS/Location URL 重写，保留相对路径语义；不识别应用私有字段
  - Origin/Referer 按真实上游 URL 映射，WebSocket 双向透传
  - 目标 Cookie 按「页面 + Hilbert 用户」保存在服务端，不向目标站泄露 Hilbert Cookie
  - 可选浏览器 Cookie 模式，支持依赖 `document.cookie` 或需要人工登录的页面
  - 可选关联 origin 映射，将 API、CDN、登录中心和 WebSocket 域名继续收敛到页面专属 Host
  - 目标网络策略、请求体/重写体上限和统一超时阻止代理越权访问或无限缓冲

## 技术栈

Node.js + Express，JSON 文件持久化（无数据库），前端为原生 HTML/CSS/JS（`marked` 渲染 Markdown）。

## 本地运行

```bash
npm install
npm start        # 默认 http://localhost:3000
```

## 配置指南

### 环境变量

复制 `.env.example` 为 `.env` 并填入实际值，或直接设置系统环境变量（优先级更高）：

```bash
cp .env.example .env
# 编辑 .env 填入实际配置
```

> ℹ️ 线上环境（Docker/K8s）无需 `.env` 文件，直接通过 ConfigMap/Secret 注入环境变量即可。

#### 基础配置

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `PORT` | 否 | Hilbert 主站监听端口，默认 `3000` |
| `EXTERNAL_PROXY_PORT` | 否 | 外部页面代理的内部监听端口，默认 `PORT + 1` |
| `EXTERNAL_PROXY_PUBLIC_HOST_TEMPLATE` | 推荐 | 页面公开 Host 模板；`{pageId}` 必须是独立 DNS 标签，例如 `{pageId}.proxy.example.com` |
| `EXTERNAL_PROXY_PUBLIC_PROTOCOL` | 否 | 页面代理公开协议：`http` 或 `https`；未设置时沿用主站请求协议 |
| `EXTERNAL_PROXY_PUBLIC_PORT` | 否 | 页面代理的公开端口；标准 80/443 无需设置，非标准端口时配置 |
| `EXTERNAL_PROXY_TICKET_TTL_SECONDS` | 否 | 一次性页面访问票据有效期，默认 60 秒 |
| `EXTERNAL_PROXY_SESSION_TTL_MINUTES` | 否 | 页面 Host-only 会话有效期，默认 480 分钟 |
| `PAGE_TARGET_ALLOW_PRIVATE_CIDRS` | 内网站点需要 | 允许外部页面代理访问的私网 CIDR，逗号分隔；公网默认允许，`DEBUG_MODE=true` 时自动允许 `127.0.0.1/32` |
| `PAGE_PROXY_MAX_BODY_BYTES` | 否 | 代理请求体上限，默认 `10485760`（10 MiB） |
| `PAGE_PROXY_MAX_REWRITE_BYTES` | 否 | HTML/CSS 可重写响应上限，默认 `5242880`（5 MiB） |
| `PAGE_PROXY_TIMEOUT_MS` | 否 | 上游 HTTP、WebSocket 和自动认证超时，默认 `30000` 毫秒 |
| `EXTERNAL_PROXY_PUBLIC_ORIGIN` | 兼容 | 旧版共享代理 origin；不能与 Host 模板同时配置 |
| `ADMIN_EMAIL` | ✅ | 超级管理员邮箱（多人用逗号分隔），拥有所有权限且可访问 RBAC 配置 |

### 逐页面通配子域名路由

配置 `EXTERNAL_PROXY_PUBLIC_HOST_TEMPLATE` 后，外部页面按请求 Host 确定页面：

```text
https://<pageId>.proxy.example.com/上游路径
```

例如当前本地 HTTPS 环境可配置：

```env
PORT=3000
EXTERNAL_PROXY_PORT=30001
EXTERNAL_PROXY_PUBLIC_HOST_TEMPLATE={pageId}.proxy.local.horus-k.com
EXTERNAL_PROXY_PUBLIC_PROTOCOL=https
EXTERNAL_PROXY_TICKET_TTL_SECONDS=60
EXTERNAL_PROXY_SESSION_TTL_MINUTES=480
```

部署要求：

- DNS 将 `*.proxy.local.horus-k.com` 指向代理入口，TLS 证书覆盖该通配域名。
- 主站与代理 Host 应位于同一可注册域（本例均属于 `horus-k.com`），避免 iframe 第三方 Cookie 策略阻止页面会话。
- `hilbert.local.horus-k.com` 转发到主站端口 `3000`。
- `*.proxy.local.horus-k.com` 转发到代理端口 `30001`。
- 网关必须保留原始 `Host`，并设置正确的 `X-Forwarded-Proto`；HTTP 与 WebSocket 均转发到代理端口。
- 每个页面的公开路径完整镜像上游路径，因此 `/api`、`/cdn-cgi/rum`、`/ws` 等根路径请求仍可根据 Host 确定页面。
- `GET /.hilbert/session` 是票据兑换保留路径，不会转发到上游页面。

页面认证流程：

1. iframe 先访问主站 `GET /hilbert-api/pages/:id/open`，使用主站的 `hilbert_token` 完成用户和 RBAC 校验。
2. 主站生成默认 60 秒有效、只能使用一次的随机票据，跳转到页面专属 Host。
3. 页面 Host 在 `/.hilbert/session` 兑换票据，设置不带 `Domain` 的 `hilbert_proxy_session` HttpOnly Cookie；其有效期不会超过主站会话剩余时间。
4. 后续 HTTP 与 WebSocket 都必须同时匹配“页面 Host + 页面会话 + RBAC 权限”。主站 JWT 不会共享给代理子域名，也不会发送给上游站点。

> 当前票据存储在 Node.js 进程内存中。单实例部署可直接使用；多副本部署需要保证主站票据签发和代理兑换落到同一实例，或后续将票据存储替换为 Redis 等共享存储。

页面接入模式：

- `server`（默认）：目标 Cookie 保存在服务端，适合 Basic、Header、OAuth 客户端凭证和自动表单登录。
- `browser`：目标 Cookie 改写为页面 Host-only Cookie，适合用户手动登录以及依赖 `document.cookie` 的应用；仅逐页面 Host 路由可用，不能与自动表单登录同时启用。

#### 关联 origin 怎么填

仅当页面还会访问其他域名时才需要填写；没有跨域请求就留空。建议先运行“代理诊断”，只处理报告中的未知 origin。

例如页面地址是 `https://app.example.com`，页面还会请求 `https://api.example.com`：

```text
api=https://api.example.com
```

格式为 `别名=https://域名`，每行一个，只填 origin，不带路径。系统会把该域名的 HTML、CSS、重定向和 WebSocket 请求转到当前页面的代理 Host。

“转发页面认证到关联 origin”默认留空。只有 `api` 与主页面属于同一可信系统，并且确实需要主页面配置的认证信息时，才填写：

```text
api
```

多个别名用逗号分隔。不要为公共 CDN、统计或其他第三方域名开启认证转发。关联 origin 仅支持默认的 `server` 会话模式。

页面菜单中的“在新标签页打开”仍使用页面专属代理 Host，可用于完成 iframe 内受限的 SSO/MFA 登录，完成后 iframe 共享同一浏览器 Cookie。

兼容性边界：代理不会解析或改写任意 JavaScript bundle。若应用在 JavaScript 中动态拼接未配置的绝对 URL，诊断会报告未知 origin，需先增加 origin 映射；只有出现可复现且必须支持的失败样本时才考虑运行时拦截。客户端证书、WebAuthn、DRM、WebTransport、反自动化和强制顶层窗口策略不保证在 iframe 内运行。

未配置 `EXTERNAL_PROXY_PUBLIC_HOST_TEMPLATE` 时，系统继续兼容旧版共享 origin：

```text
https://proxy.example.com/hilbert-proxy/<pageId>/上游路径
```

旧模式适合兼容已有部署，但根路径请求缺少页面 ID 时只能依赖有限的 Referer 回退，不具备逐页面 origin 隔离能力。

#### Google OAuth2

在 [Google Cloud Console](https://console.cloud.google.com/) → APIs & Services → Credentials 中创建 OAuth2 Client ID，将授权回调地址设为 `GOOGLE_REDIRECT_URI` 的值。

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `GOOGLE_CLIENT_ID` | ✅ | OAuth2 客户端 ID |
| `GOOGLE_CLIENT_SECRET` | ✅ | OAuth2 客户端密钥 |
| `GOOGLE_REDIRECT_URI` | ✅ | 回调地址，如 `http://localhost:3000/callback?type=google`，必须与 Google Console 一致 |
| `GOOGLE_OAUTH2_SCOPE` | 否 | 权限范围，默认 `userinfo.email userinfo.profile` |
| `GOOGLE_OAUTH2_ACCESS_TYPE` | 否 | 访问类型，默认 `offline` |
| `GOOGLE_OAUTH2_INCLUDE_GRANTED_SCOPES` | 否 | 是否包含已授权作用域，默认 `true` |
| `GOOGLE_OAUTH2_RESPONSE_TYPE` | 否 | 响应类型，默认 `code` |
| `GOOGLE_OAUTH2_URL` | 否 | Google 授权端点，一般无需修改 |
| `GOOGLE_TOKEN_URL` | 否 | Google Token 端点，一般无需修改 |

#### JWT 会话

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `JWT_SECRET` | ✅ | JWT 签名密钥，建议用 `openssl rand -base64 32` 生成 |
| `JWT_EXPIRE_HOURS` | 否 | 会话过期时间（小时），默认 `720`（30 天） |

#### Debug 登录（本地开发可选）

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `DEBUG_MODE` | 否 | 设为 `true` 后开启 debug 登录模式，自动跳过 Google OAuth |
| `DEBUG_USER_EMAIL` | debug 模式下必填 | 调试用户邮箱 |
| `DEBUG_USER_NAME` | 否 | 调试用户名，默认 `Debug User` |
| `DEBUG_USER_DISPLAY_NAME` | 否 | 调试用户显示名，默认回退到 `DEBUG_USER_NAME` |
| `DEBUG_USER_ID` | 否 | 调试用户 ID，默认 `debug-user` |
| `DEBUG_USER_GROUPS` | 否 | 调试用户组，逗号分隔 |
| `DEBUG_USER_PICTURE` | 否 | 调试用户头像 URL |

> ⚠️ `DEBUG_MODE=true` 仅建议用于本地开发或测试环境，生产环境请保持关闭。

#### 网络代理（可选）

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `GOOGLE_API_PROXY` | 否 | Google API 出站代理地址，国内服务器需要配置（如 `http://127.0.0.1:10808`） |
| `PAGE_PROXY` | 否 | 所有外部链接页面的统一出站代理，覆盖页面请求、自动认证和 WebSocket（如 `http://127.0.0.1:10808`） |

`PAGE_PROXY` 支持 `http://` 和 `https://` 代理地址。留空时页面保持直连；该配置不会影响 Google OAuth，后者仍由 `GOOGLE_API_PROXY` 单独控制。

外部页面目标默认允许公网、拒绝私网。需要访问内网时显式列出范围，例如：

```env
PAGE_TARGET_ALLOW_PRIVATE_CIDRS=10.20.0.0/16,192.168.50.0/24
```

策略同时检查目标 URL、DNS 解析结果、`resolveIp`、关联 origin、自动认证端点和重定向目标。云元数据地址始终拒绝，即使位于允许 CIDR 中。

#### 登录限制（可选）

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `GOOGLE_ALLOWED_DOMAIN` | 否 | 允许登录的邮箱域名（如 `abel.ai`），为空则不限制域名 |
| `GOOGLE_ALLOWED_EMAILS` | 否 | 允许登录的具体邮箱列表（逗号分隔），优先级高于域名限制 |

> 💡 **登录限制优先级**：`GOOGLE_ALLOWED_EMAILS` > `GOOGLE_ALLOWED_DOMAIN` > 不限制。两者都为空时任何 Google 账号均可登录。

### RBAC 权限管理

登录后在设置页的「权限管理」区域配置（仅超级管理员可见）：

1. **创建角色**：定义角色名称并勾选该角色对各页面的操作权限（查看/新增/修改/删除）
   - 勾选「全部页面」后，后续新增的页面也会自动继承所选权限
2. **分配邮箱**：将角色绑定到指定邮箱，支持通配符（如 `*@domain.com` 匹配该域名下所有用户）
3. **超级管理员**：由 `ADMIN_EMAIL` 指定，默认拥有所有权限，无需在 RBAC 中配置

## 可运维性

设置页仅对超级管理员显示以下能力：

- **系统状态**：版本、运行时间、内存、数据目录可写性、页面/RBAC 数量、代理路由、加密状态、审计和会话统计。
- **代理诊断**：按页面执行真实 DNS、TLS、出站代理和认证链路测试，跟踪最多五跳重定向，并报告 Cookie、未知 origin 和推荐接入模式；不返回认证 Secret、Cookie 值或响应正文。
- **备份恢复**：完整备份页面、分组、RBAC、收藏、Markdown、自定义页面和审计日志；恢复前自动创建安全备份。运行中的会话不会被备份或恢复。
- **审计日志**：记录登录、设置修改、备份恢复、代理诊断和会话撤销，敏感字段递归脱敏。
- **会话管理**：JWT 带独立 sid，主站与页面代理会话可查看和撤销；撤销主站会话会级联撤销代理会话并关闭已有 WebSocket。

保留策略通过环境变量配置：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `AUDIT_RETENTION_DAYS` | `90` | 审计日志保留天数 |
| `BACKUP_RETENTION` | `10` | 自动保留的最近备份数量 |
| `SESSION_RETENTION_DAYS` | `7` | 已过期/撤销会话记录的额外保留天数 |
| `DATA_ENCRYPTION_KEY` | 从 JWT 派生 | 页面认证 Secret 主加密密钥 |
| `DATA_ENCRYPTION_PREVIOUS_KEYS` | 空 | 密钥轮换期间用于解密旧密文的旧密钥列表 |

## Docker 部署

```bash
docker build -t hilbert-demo .
docker run -d --name hilbert-demo \
  -p 3000:3000 \
  -p 3001:3001 \
  -v hilbert-demo-data:/app/data \
  hilbert-demo
```

- `-v ...:/app/data`：持久化页面/分组配置与 Markdown 文档，**必须挂载**，否则容器重建后数据丢失
- 健康检查：镜像内置 `HEALTHCHECK`，探测 `GET /hilbert-api/health`；K8s 探针同理
- 镜像以非 root 用户运行

K8s Deployment 片段示例：

```yaml
# ConfigMap（非敏感配置）
apiVersion: v1
kind: ConfigMap
metadata:
  name: hilbert-config
data:
  PORT: "3000"
  EXTERNAL_PROXY_PORT: "3001"
  EXTERNAL_PROXY_PUBLIC_HOST_TEMPLATE: "{pageId}.proxy.example.com"
  EXTERNAL_PROXY_PUBLIC_PROTOCOL: "https"
  EXTERNAL_PROXY_TICKET_TTL_SECONDS: "60"
  EXTERNAL_PROXY_SESSION_TTL_MINUTES: "480"
  ADMIN_EMAIL: "admin@example.com,boss@example.com"
  GOOGLE_CLIENT_ID: "your-client-id.apps.googleusercontent.com"
  GOOGLE_REDIRECT_URI: "https://your-domain.com/callback?type=google"
  GOOGLE_OAUTH2_SCOPE: "https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile"
  JWT_EXPIRE_HOURS: "720"
  GOOGLE_ALLOWED_DOMAIN: "example.com"
---
# Secret（敏感值）
apiVersion: v1
kind: Secret
metadata:
  name: hilbert-secrets
type: Opaque
stringData:
  GOOGLE_CLIENT_SECRET: "your-client-secret"
  JWT_SECRET: "your-jwt-secret"
---
# Deployment
apiVersion: apps/v1
kind: Deployment
metadata:
  name: hilbert
spec:
  template:
    spec:
      containers:
        - name: hilbert
          image: <registry>/hilbert-demo:1.2.0
          ports:
            - containerPort: 3000
            - containerPort: 3001
          envFrom:
            - configMapRef:
                name: hilbert-config
            - secretRef:
                name: hilbert-secrets
          volumeMounts:
            - name: data
              mountPath: /app/data
          readinessProbe:
            httpGet: { path: /hilbert-api/health, port: 3000 }
      volumes:
        - name: data
          persistentVolumeClaim:
            claimName: hilbert-data
```

## 数据存储

所有数据位于 `data/` 目录（已在 `.gitignore` 中排除，首次启动自动创建）：

| 文件 | 内容 |
| --- | --- |
| `data/pages.json` | 页面配置（含认证信息） |
| `data/groups.json` | 分组列表 |
| `data/roles.json` | RBAC 角色与邮箱分配 |
| `data/sessions.json` | 可查看、可撤销的主站及代理会话注册表 |
| `data/audit/*.jsonl` | 按月轮转的脱敏审计日志 |
| `data/backups/*.zip` | 手动备份和恢复前安全备份 |
| `data/pages/*.md` | Markdown 页面正文（每页一个文件） |
| `data/custom-pages/<id>/` | 自定义页面静态资源目录 |

页面认证密码、Header Token 和 OAuth Client Secret 使用 AES-256-GCM 加密后保存在 `pages.json`。生产环境建议设置独立的 `DATA_ENCRYPTION_KEY`；未设置时从 `JWT_SECRET` 派生。轮换密钥时将旧密钥临时加入 `DATA_ENCRYPTION_PREVIOUS_KEYS`，启动后会自动重新加密。页面 API 只返回 `hasPassword` / `hasClientSecret` 等状态，不会把 Secret 返回浏览器。

所有 JSON Repository 使用“同目录临时文件 + fsync + rename”原子写入。每次覆盖前会将上一份合法 JSON 保存为同名 `.bak`；主文件损坏或缺失时会自动从备份恢复。备份文件与主文件包含相同敏感级别的数据，也必须使用相同的文件系统权限保护。

## API 一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/hilbert-api/pages` | 页面列表 |
| POST | `/hilbert-api/pages` | 新建页面（markdown 自动生成占位文档） |
| PUT | `/hilbert-api/pages/:id` | 更新页面 |
| DELETE | `/hilbert-api/pages/:id` | 删除页面（连带 md 文件） |
| GET | `/hilbert-api/pages/:id/open` | 校验权限并进入页面专属代理 Host |
| GET | `/hilbert-api/groups` | 分组列表 |
| POST | `/hilbert-api/groups` | 新建分组 |
| PUT | `/hilbert-api/groups/:id` | 按稳定 ID 重命名分组 |
| DELETE | `/hilbert-api/groups/:id` | 按稳定 ID 删除分组 |
| POST | `/hilbert-api/pages/:id/upload` | 上传自定义页面文件（multipart，支持 zip） |
| GET | `/hilbert-api/pages/:id/files` | 自定义页面文件列表 |
| DELETE | `/hilbert-api/pages/:id/files/:filename` | 删除自定义页面文件 |
| GET | `/hilbert-api/health` | 健康检查 |
| GET | `/hilbert-api/version` | 版本号 |
| GET | `/hilbert-api/me` | 当前登录用户信息 |
| GET | `/hilbert-api/my-permissions` | 当前用户权限列表 |
| GET | `/hilbert-api/rbac/roles` | 角色列表（仅管理员） |
| POST | `/hilbert-api/rbac/roles` | 新建角色（仅管理员） |
| PUT | `/hilbert-api/rbac/roles/:id` | 更新角色（仅管理员） |
| DELETE | `/hilbert-api/rbac/roles/:id` | 删除角色（仅管理员） |
| GET | `/hilbert-api/rbac/assignments` | 邮箱-角色分配列表（仅管理员） |
| POST | `/hilbert-api/rbac/assignments` | 新建分配（仅管理员） |
| DELETE | `/hilbert-api/rbac/assignments/:email/:roleId` | 删除分配（仅管理员） |
| GET | `/hilbert-api/ops/status` | 系统、数据、代理、加密和会话状态（仅管理员） |
| GET | `/hilbert-api/ops/audit` | 查询审计日志（仅管理员） |
| GET/POST | `/hilbert-api/ops/backups` | 查看或创建完整备份（仅管理员） |
| GET | `/hilbert-api/ops/backups/:name/download` | 下载备份（仅管理员） |
| POST | `/hilbert-api/ops/backups/:name/restore` | 恢复备份，确认文本为 RESTORE（仅管理员） |
| POST | `/hilbert-api/ops/backups/upload-restore` | 上传 zip 备份并恢复，multipart 字段为 backup、confirm（仅管理员） |
| GET | `/hilbert-api/ops/sessions` | 查看活跃主站/代理会话（仅管理员） |
| POST | `/hilbert-api/ops/sessions/:id/revoke` | 撤销会话及关联代理会话（仅管理员） |
| POST | `/hilbert-api/ops/diagnostics/pages/:id` | 执行页面代理连通性诊断（仅管理员） |
| GET | `https://<页面id>.proxy.example.com/.hilbert/session` | 使用一次性票据换取页面 Host-only 会话 |
| ANY | `https://<页面id>.proxy.example.com/**` | 按 Host 转发外部页面 HTTP/WebSocket 请求 |
| ANY | `<兼容代理origin>/hilbert-proxy/<页面id>/**` | 未配置 Host 模板时的旧版挂载代理 |
| GET | `/hilbert-custom/<页面id>/**` | 自定义页面静态资源服务 |

## 版本

见 [CHANGELOG.md](./CHANGELOG.md)。当前版本：**v1.5.1**。
