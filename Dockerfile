# Keep the Node major in step with the k-on-bot-test image in docker-compose.yaml
FROM node:26-alpine

ARG GIT_REPO
# Pinned so a rebuild never changes the tools under the app. PNPM_VERSION must
# match "packageManager" in package.json.
ARG PNPM_VERSION=9.4.0
ARG PM2_VERSION=7.1.2

WORKDIR /app

# 安装 git 和必要的依赖
# python3/make/g++ 用于编译 sqlite3 原生模块：node-sqlite3 6.x 的预编译包从
# GitHub Releases 下载，本机到 github.com 的下载路径会 504（api.github.com 正常），
# 拿不到预编译包时 prebuild-install 会退回 node-gyp 源码编译。
RUN apk update \
    && apk add --no-cache git bash python3 make g++ \
    && git clone ${GIT_REPO} -b master --depth=1 k-on-bot

# pnpm and pm2 live in the image: installing them on every container start
# cost seconds of downtime and failed whenever the registry was unreachable.
RUN npm install -g pnpm@${PNPM_VERSION} pm2@${PM2_VERSION}

WORKDIR /app/k-on-bot

# 给脚本添加执行权限
RUN chmod +x build.sh
