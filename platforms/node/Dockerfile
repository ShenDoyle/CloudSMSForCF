# CloudSMSForCF 自托管镜像（Fly.io / Railway 通用）
# 构建上下文 = platforms/dist/node（由 platforms/build.py 生成，含 shared/ 适配层）
#   构建并本地运行：docker build -t cloudsms . && docker run -p 8787:8787 --env-file .env cloudsms
FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json server.mjs ./
COPY shared ./shared

EXPOSE 8787
CMD ["node", "server.mjs"]
