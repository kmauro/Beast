FROM node:24-bookworm-slim AS build

ENV PUPPETEER_CACHE_DIR=/app/.cache/puppeteer
WORKDIR /app

COPY package.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/worker ./apps/worker

RUN npm install
RUN npm run build -w @beast/shared \
    && npm run build -w @beast/database \
    && npm run build -w @beast/worker

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV PUPPETEER_CACHE_DIR=/app/.cache/puppeteer
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates \
      fonts-liberation \
      libasound2 \
      libatk-bridge2.0-0 \
      libatk1.0-0 \
      libcups2 \
      libdbus-1-3 \
      libdrm2 \
      libgbm1 \
      libgtk-3-0 \
      libnspr4 \
      libnss3 \
      libx11-xcb1 \
      libxcomposite1 \
      libxdamage1 \
      libxfixes3 \
      libxkbcommon0 \
      libxrandr2 \
      xdg-utils \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.cache ./.cache
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/database/package.json ./packages/database/package.json
COPY --from=build /app/packages/database/dist ./packages/database/dist
COPY --from=build /app/apps/worker/package.json ./apps/worker/package.json
COPY --from=build /app/apps/worker/dist ./apps/worker/dist

RUN mkdir -p /app/data/whatsapp-auth \
    && chown -R node:node /app

USER node
CMD ["node", "apps/worker/dist/index.js"]
