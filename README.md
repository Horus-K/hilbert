# hilbert-demo

可配置多页面嵌入的后台管理面板：ChatGPT 风格深色 UI，左侧页面列表 + 右侧内容区，把散落在各处的监控面板、内部系统、文档聚合到一个入口。

## 功能特性

- **Google SSO 单点登录**：基于 Google OAuth2 的登录流程，JWT 会话管理，支持邮箱白名单（按域名或具体邮箱限制登录）
- **RBAC 权限管理**：
  - 基于角色的访问控制，支持自定义角色并分配页面级权限（查看/新增/修改/删除）
  - 支持将角色分配给指定邮箱，支持通配符邮箱模式（如 `*@domain.com`）
  - 超级管理员拥有全部权限并可管理 RBAC 配置
  - 权限感知渲染：侧边栏、操作按钮根据当前用户权限动态显示/隐藏
- **三种页面类型**
  - `link`：iframe 嵌入外部系统（Grafana、xxl-job、内部工具等）
  - `markdown`：内置 Markdown 文档，右侧原地编辑，正文以独立 `.md` 文件存储
  - `custom`：自定义前端页面，上传 HTML/CSS/JS 等静态资源，后端独立静态目录托管（`/hilbert-custom/<页面id>/`）
- **分组管理**：页面按分组归类，支持新建/删除分组
- **反向代理自动认证**（核心能力，解决 iframe 无法携带认证的问题）
  - `basic`：自动注入 `Authorization: Basic` 头（适用于 Nginx basic auth 站点）
  - `login`：服务端自动完成表单登录换取会话 Cookie（适用于 Grafana 等），会话过期自动重登重试
  - `header`：注入任意自定义请求头（如 Bearer 令牌）
- **深度代理适配**（以 Grafana 为例已验证）
  - 剥离 `X-Frame-Options` / CSP 使目标站可被 iframe 嵌入
  - Origin/Referer 改写绕过 CSRF 校验、WebSocket 双向透传（Grafana live）
  - 两种代理模式（编辑页面可选）：
    - **恒等映射**（默认）：代理路径直接使用目标页面 URL 路径（如 `/xxl-job-admin/`），绝对路径无需重写
    - **挂载** `/hilbert-proxy/<页面id>`：适用于 URL 无路径的根路径站点（与面板根路径冲突）或恒等映射异常的站点，自动做 HTML/CSS 绝对路径重写 + `appSubUrl` 注入

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
| `PORT` | 否 | 服务监听端口，默认 `3000` |
| `ADMIN_EMAIL` | ✅ | 超级管理员邮箱（多人用逗号分隔），拥有所有权限且可访问 RBAC 配置 |

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

#### 网络代理（可选）

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `GOOGLE_API_PROXY` | 否 | Google API 出站代理地址，国内服务器需要配置（如 `http://127.0.0.1:10808`） |

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

## Docker 部署

```bash
docker build -t hilbert-demo .
docker run -d --name hilbert-demo \
  -p 3000:3000 \
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
| `data/pages/*.md` | Markdown 页面正文（每页一个文件） |
| `data/custom-pages/<id>/` | 自定义页面静态资源目录 |

> ⚠️ 认证账号密码以明文保存在 `pages.json` 中，请通过文件系统权限控制访问，不要将该文件提交到仓库或外发。

## API 一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/hilbert-api/pages` | 页面列表 |
| POST | `/hilbert-api/pages` | 新建页面（markdown 自动生成占位文档） |
| PUT | `/hilbert-api/pages/:id` | 更新页面 |
| DELETE | `/hilbert-api/pages/:id` | 删除页面（连带 md 文件） |
| GET | `/hilbert-api/groups` | 分组列表 |
| POST | `/hilbert-api/groups` | 新建分组 |
| DELETE | `/hilbert-api/groups/:name` | 删除分组 |
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
| ANY | `/<页面URL路径>/**` | 反向代理（恒等映射，自动认证） |
| ANY | `/hilbert-proxy/<页面id>/**` | 挂载模式页面的代理（前缀剥离 + HTML/CSS 重写） |
| GET | `/hilbert-custom/<页面id>/**` | 自定义页面静态资源服务 |

## 版本

见 [CHANGELOG.md](./CHANGELOG.md)。当前版本：**v1.2.0**。
