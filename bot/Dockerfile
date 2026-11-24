# Multi-stage build → a small immutable image. Config is injected at runtime (env/ConfigMap/Secret),
# so the SAME image runs on Cloud Run and on GKE across environments — build once, deploy many.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# MESSAGING_BACKEND=peachy-bot keeps the bot's encrypted store here: mount a volume on it.
ENV PEACHY_BOT_DB=/data/bot.db
RUN mkdir -p /data && chown node:node /data && chmod 0700 /data
EXPOSE 8080
USER node
CMD ["node", "dist/index.js"]
