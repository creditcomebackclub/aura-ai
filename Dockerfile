FROM node:22-trixie-slim

ENV NODE_ENV=production
ENV AURA_RUNTIME=cloud
ENV PUPPETEER_SKIP_DOWNLOAD=true

WORKDIR /app

COPY package.json package-lock.json ./
# better-sqlite3 ships its native Linux binary, and Puppeteer is not used in
# cloud mode. Skipping install scripts avoids a compiler toolchain and browser
# download, keeping the free-tier image small.
RUN npm ci --omit=dev --ignore-scripts

COPY . .

EXPOSE 3000
CMD ["node", "server.js"]
