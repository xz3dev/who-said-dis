FROM node:24.19.0-alpine3.24@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43 AS production

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY apps/cli/package.json ./apps/cli/package.json
RUN npm ci --omit=dev

COPY apps ./apps
COPY packages ./packages

RUN mkdir -p /data && chown -R node:node /app /data && chmod 700 /data
USER node

ENV PORT=3000 \
    DATABASE_PATH=/data/who-said-dis.sqlite
EXPOSE 3000
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/config').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["node", "./apps/server/src/index.js"]
