# syntax=docker/dockerfile:1.7

# 晨羽桥接：纯 Node 服务，无第三方依赖。
FROM node:22.19-alpine

RUN apk add --no-cache ca-certificates tzdata wget

WORKDIR /app
COPY package.json ./
COPY *.mjs ./
COPY admin.html ./
COPY workflows ./workflows
# 容器以非 root 用户运行时也要能读取静态文件。
RUN chmod -R a+rX /app && mkdir -p /app/data

ENV NODE_ENV=production
ENV BRIDGE_HOST=0.0.0.0
ENV BRIDGE_PORT=3400

EXPOSE 3400
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3400/healthz >/dev/null || exit 1

CMD ["node", "server.mjs"]
