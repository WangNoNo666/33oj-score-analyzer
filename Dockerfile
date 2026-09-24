# 在线部署用镜像：纯 Node，零依赖
FROM node:22-alpine

ENV NODE_ENV=production \
    OJ_MODE=cloud \
    OJ_NO_OPEN=1 \
    OJ_GUI_PORT=8788

WORKDIR /app

# 没有第三方依赖，只需要源码
COPY package.json ./
COPY lib ./lib
COPY app ./app
COPY oj-user.mjs oj-multi.mjs start-edge.mjs make-shortcut.mjs ./
COPY LICENSE README.md ./

# 以非 root 运行
RUN addgroup -S app && adduser -S app -G app && chown -R app:app /app
USER app

EXPOSE 8788

# 平台通常会注入 PORT，这里跟着走
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "const p=process.env.PORT||process.env.OJ_GUI_PORT||8788;fetch('http://127.0.0.1:'+p+'/api/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "app/server.mjs"]
