# hilbert-demo

可配置多页面嵌入的后台管理面板：ChatGPT 风格深色 UI，左侧页面列表 + 右侧内容区，把散落在各处的监控面板、内部系统、文档聚合到一个入口。

## 功能特性

- **两种页面类型**
  - `link`：iframe 嵌入外部系统（Grafana、xxl-job、内部工具等）
  - `markdown`：内置 Markdown 文档，右侧原地编辑，正文以独立 `.md` 文件存储
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

环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 监听端口 |

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
containers:
  - name: hilbert-demo
    image: <registry>/hilbert-demo:1.0.0
    ports:
      - containerPort: 3000
    volumeMounts:
      - name: data
        mountPath: /app/data
    readinessProbe:
      httpGet: { path: /hilbert-api/health, port: 3000 }
volumes:
  - name: data
    persistentVolumeClaim:
      claimName: hilbert-demo-data
```

## 数据存储

所有数据位于 `data/` 目录（已在 `.gitignore` 中排除，首次启动自动创建）：

| 文件 | 内容 |
| --- | --- |
| `data/pages.json` | 页面配置（含认证信息） |
| `data/groups.json` | 分组列表 |
| `data/pages/*.md` | Markdown 页面正文（每页一个文件） |

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
| GET | `/hilbert-api/health` | 健康检查 |
| ANY | `/<页面URL路径>/**` | 反向代理（恒等映射，自动认证） |
| ANY | `/hilbert-proxy/<页面id>/**` | 挂载模式页面的代理（前缀剥离 + HTML/CSS 重写） |

## 版本

见 [CHANGELOG.md](./CHANGELOG.md)。当前版本：**v1.0.0**。
