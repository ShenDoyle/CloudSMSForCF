# CloudSMSForCF 自托管镜像（Fly.io / Railway 通用）
# 构建上下文 = platforms/node/（本目录自包含：入口 + app.js + db.js）
#   构建并本地运行：docker build -t cloudsms . && docker run -p 8787:8787 --env-file .env cloudsms
FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json server.mjs app.js db.js ./

EXPOSE 8787
CMD ["node", "server.mjs"]
