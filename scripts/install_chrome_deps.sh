#!/usr/bin/env bash
set -euo pipefail

echo "[bootstrap] Installing Chromium runtime dependencies..."

if command -v apt-get >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  sudo apt-get update -y
  sudo apt-get install -y \
    ca-certificates fonts-liberation libasound2 libatk-bridge2.0-0 libatk1.0-0 \
    libc6 libcairo2 libcups2 libdbus-1-3 libexpat1 libfontconfig1 libgcc1 \
    libglib2.0-0 libgtk-3-0 libnspr4 libnss3 libpango-1.0-0 libpthread-stubs0-dev \
    libu2f-udev libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxcursor1 libxdamage1 \
    libxext6 libxfixes3 libxi6 libxrandr2 libxrender1 libxss1 libxtst6 libxkbcommon0 \
    lsb-release xdg-utils wget
elif command -v dnf >/dev/null 2>&1; then
  sudo dnf install -y \
    at-spi2-atk atk cups-libs alsa-lib libXcomposite libXcursor libXdamage \
    libXext libXi libXrandr libXScrnSaver libXtst pango gtk3 nss \
    lcms2 libdrm libgbm libxkbcommon
elif command -v yum >/dev/null 2>&1; then
  # Amazon Linux 2 / RHEL 7
  if command -v amazon-linux-extras >/dev/null 2>&1; then
    sudo amazon-linux-extras install epel -y || true
  fi
  sudo yum install -y \
    atk at-spi2-atk cups-libs alsa-lib libXcomposite libXcursor libXdamage \
    libXext libXi libXrandr libXScrnSaver libXtst pango gtk3 nss \
    lcms2 libdrm libgbm libxkbcommon
else
  echo "[bootstrap] Unsupported package manager. Please install Chrome deps manually." >&2
  exit 1
fi

echo "[bootstrap] Done. If Puppeteer still fails, install system Chromium and set PUPPETEER_EXECUTABLE_PATH."

