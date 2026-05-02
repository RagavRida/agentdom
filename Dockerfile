FROM node:20-slim

# Install Chromium for Puppeteer
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    libnss3 \
    libatk-bridge2.0-0 \
    libdrm2 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpangocairo-1.0-0 \
    libgtk-3-0 \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

# Copy package files
COPY package.json package-lock.json ./
RUN npm ci --production

# Copy source
COPY agentdom.js cli.js mcp-server.js index.html ./
COPY integrations/ ./integrations/
COPY docs/ ./docs/
COPY chrome-extension/ ./chrome-extension/

# Expose ports
EXPOSE 3700 3800

# Health check
HEALTHCHECK --interval=30s --timeout=5s \
  CMD curl -f http://localhost:3700/health || exit 1

# Start HTTP API server by default
CMD ["node", "integrations/http-server.js"]
