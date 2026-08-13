# 基础镜像固定为当前开发环境 Node 版本（node --version: v24.19.0）
# ---------- 构建阶段：仅安装生产依赖 ----------
FROM node:24.19.0-alpine AS deps

WORKDIR /app

# 先复制依赖清单，利用构建缓存
COPY package.json package-lock.json .npmrc* ./
RUN npm ci --omit=dev && npm cache clean --force

# ---------- 运行阶段 ----------
FROM node:24.19.0-alpine

ENV NODE_ENV=production \
    PORT=3000

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json server.js ./
COPY public ./public

# 数据目录：页面/分组配置与 Markdown 文档，运行时通过卷挂载持久化
RUN mkdir -p /app/data && chown -R node:node /app
VOLUME ["/app/data"]

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/api/health || exit 1

CMD ["node", "server.js"]
