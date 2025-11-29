#!/bin/bash

cd /app/k-on-bot

# 更新代码
git fetch origin master
git reset --hard FETCH_HEAD
git clean -fd

# 安装依赖
pnpm install

# 构建项目
pnpm build

# 安装 pm2
npm install -g pm2

# 运行应用程序
pm2-runtime /app/k-on-bot/dist/index.js
