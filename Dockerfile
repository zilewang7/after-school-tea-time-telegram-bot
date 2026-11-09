FROM node:22-alpine

ARG GIT_REPO

WORKDIR /app

# 安装 git 和必要的依赖
# python3/make/g++ 用于编译 sqlite3 原生模块：node-sqlite3 6.x 的预编译包从
# GitHub Releases 下载，本机到 github.com 的下载路径会 504（api.github.com 正常），
# 拿不到预编译包时 prebuild-install 会退回 node-gyp 源码编译。
RUN apk update \
    && apk add --no-cache git bash python3 make g++ \
    && git clone ${GIT_REPO} -b master --depth=1 k-on-bot

# 安装 corepack 和 pnpm
RUN npm install -g corepack \
    && corepack prepare pnpm@latest --activate

WORKDIR /app/k-on-bot

# 给脚本添加执行权限
RUN chmod +x build.sh
