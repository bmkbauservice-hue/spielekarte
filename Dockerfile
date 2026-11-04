# Spielekarte – Produktions-Image
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=3000 \
    BASE_PATH=/spiel

WORKDIR /app

# Erst nur die Paketlisten kopieren → Docker kann die npm-Schicht cachen,
# solange sich die Abhängigkeiten nicht ändern.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src

# Nicht als root laufen
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}${BASE_PATH}/health" > /dev/null || exit 1

CMD ["node", "src/server.js"]
