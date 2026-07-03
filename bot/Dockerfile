# Multi-stage build → a small immutable image. Config is injected at runtime (env/ConfigMap/Secret),
# so the SAME image runs on Cloud Run and on GKE across environments — build once, deploy many.
FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
EXPOSE 8080
USER node
CMD ["node", "dist/index.js"]
