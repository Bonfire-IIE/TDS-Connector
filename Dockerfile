# Bonfire-TDS 连接器门户 —— 单制品镜像（web 前端 + server 后端同端口）。
#
# 运行前提（部署时提供）：
#   1) 挂载本机 Lite 的 KusciaAPI 证书目录到容器（默认 LITE_CERT_DIR
#      = /home/bonfire-tds/src/backend/secrets/kuscia/lite/alice），
#      目录内含 kusciaapi-server.crt / kusciaapi-server.key / ca.crt / token。
#        例：-v /host/lite/alice/certs:/certs -e LITE_CERT_DIR=/certs
#   2) 传入环境变量（无前缀，大小写不敏感）：
#        PORTAL_DOMAIN_ID / PORTAL_CONNECTOR_ID
#        LITE_KUSCIA_ENDPOINT / LITE_CERT_DIR / STORAGE_ROOT
#        PLATFORM_API_BASE / MASTER_ENDPOINT / PORT / WEB_DIST
#   3) 门户与 Lite 同机部署，需能经 IP 访问本机 Lite KusciaAPI（默认 host 网络）。

# ---- build 阶段：安装全部 workspaces 依赖并构建 web + server ----
FROM node:20-slim AS build
WORKDIR /app

# 先拷 manifest 以利用缓存（根 + 两个 workspace）
COPY package.json package-lock.json* ./
COPY web/package.json ./web/package.json
COPY server/package.json ./server/package.json

# 根 workspaces 安装（含 web/server 依赖）
RUN npm ci || npm install

# 拷入源码后整体构建（web 先、server 后，见根 package.json build 脚本）
COPY . .
RUN npm run build

# ---- runtime 阶段：仅带运行所需产物 ----
FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8100
# WEB_DIST 指向镜像内 web 产物（server 默认解析 ../web/dist 亦可命中此布局）
ENV WEB_DIST=/app/web/dist

# server 运行时依赖（express/axios/dotenv）从根 node_modules 解析
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/server/package.json ./server/package.json
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/web/dist ./web/dist

EXPOSE 8100
CMD ["node", "server/dist/index.js"]
