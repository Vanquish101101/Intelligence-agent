# Intelligence Agent — Vanquish Intelligence Agent
# Онлайн-разведчик с OSINT, deepresearch-режимом и учётом затрат
# ver. v0.2.0

FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm ci --omit=dev

COPY src/ ./src/

RUN mkdir -p /app/logs

CMD ["node", "src/telegram-bot/index.js"]
