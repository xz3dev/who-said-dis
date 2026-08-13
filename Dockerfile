FROM node:24-alpine AS production

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY apps ./apps
COPY packages ./packages

RUN mkdir -p /data && chown -R node:node /app /data
USER node

ENV PORT=3000 \
    DATABASE_PATH=/data/who-said-dis.sqlite
EXPOSE 3000
VOLUME ["/data"]

CMD ["node", "./apps/server/src/index.js"]
