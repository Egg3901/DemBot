# Run DemBot with all Chromium deps preinstalled
FROM ghcr.io/puppeteer/puppeteer:latest

WORKDIR /app

# Install app deps
COPY package*.json ./
RUN npm ci --omit=dev

# Copy source
COPY . .

# Optional: Puppeteer image already sets this, but keep explicit
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

CMD ["node", "index.js"]

