FROM node:22-slim

ENV NODE_ENV=production
ENV AURA_RUNTIME=cloud
ENV PUPPETEER_SKIP_DOWNLOAD=true

WORKDIR /app

COPY package.json package-lock.json ./
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && npm_config_build_from_source=true npm ci --omit=dev \
    && rm -rf /var/lib/apt/lists/*

COPY . .

EXPOSE 3000
CMD ["node", "server.js"]
