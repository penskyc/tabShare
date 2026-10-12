# ---- build the client ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY scripts ./scripts
RUN npm ci
COPY . .
# Full-size sound banks (~72 MB, sha256-pinned; not in git).
RUN node scripts/fetch-soundfonts.mjs
RUN npm run build

# ---- runtime ----
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3001 \
    DATA_DIR=/data
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY server ./server
COPY shared ./shared
RUN apk add --no-cache su-exec && mkdir -p /data && chown node:node /data
COPY docker-entrypoint.sh /usr/local/bin/
VOLUME ["/data"]
EXPOSE 3001
# Follows a port changed in Admin → Settings (saved in /data/config.json).
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "let p=process.env.PORT||3001;try{p=JSON.parse(require('fs').readFileSync('/data/config.json','utf8')).port||p}catch{}fetch('http://127.0.0.1:'+p+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["sh", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "--import", "tsx", "server/index.ts"]
