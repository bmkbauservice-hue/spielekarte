# Spielekarte – Produktions-Image
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=3000 \
    BASE_PATH=/spiel \
    DB_PATH=/app/data/spielekarte.db

WORKDIR /app

# Erst nur die Paketlisten kopieren → Docker kann die npm-Schicht cachen,
# solange sich die Abhängigkeiten nicht ändern.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY scripts ./scripts

# Datenordner für SQLite – muss dem Benutzer "node" gehören, sonst darf er nicht schreiben.
# Als Volume eingebunden, damit die Daten einen neuen Container (Deploy) überleben.
RUN mkdir -p /app/data && chown node:node /app/data
VOLUME /app/data

# Nicht als root laufen
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}${BASE_PATH}/health" > /dev/null || exit 1

CMD ["node", "src/server.js"]
