# Single container: the service launches one headless Chrome and gives every
# account its own browser context, so no X server / VNC / sidecar is needed.
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      wget gnupg ca-certificates fonts-noto-cjk \
      libnss3 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 \
      libxdamage1 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 libcairo2 \
      libasound2 libatspi2.0-0 \
    && wget -qO- https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor > /usr/share/keyrings/google.gpg \
    && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google.gpg] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google.list \
    && apt-get update && apt-get install -y --no-install-recommends google-chrome-stable \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY src ./src
COPY tsconfig.json ./
ENV NODE_ENV=production
ENV CHROME_HEADLESS=true
EXPOSE 3000
CMD ["npx", "tsx", "src/server.ts"]
