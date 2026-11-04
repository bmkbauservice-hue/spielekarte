// Einstiegspunkt: Konfiguration lesen, Server starten, sauber beenden.

import { loadConfig } from './config.js';
import { createApp } from './app.js';

const config = loadConfig();
const { httpServer, close } = createApp({ basePath: config.basePath, cardIds: config.cardIds });

if (config.cardIds.size === 0) {
  console.warn('Hinweis: CARD_IDS ist leer – ALLE Karten-IDs sind erlaubt. In Produktion CARD_IDS oder CARD_IDS_FILE setzen.');
} else {
  console.log(`${config.cardIds.size} Karten-ID(s) freigeschaltet.`);
}

httpServer.listen(config.port, config.host, () => {
  console.log(`Spielekarte läuft auf http://localhost:${config.port}${config.basePath}/`);
  console.log(`Beispiel-Raum:       http://localhost:${config.port}${config.basePath}/k/TEST01`);
});

// Docker schickt beim Stoppen SIGTERM → Verbindungen ordentlich schließen.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, async () => {
    console.log(`${signal} empfangen, beende …`);
    await close();
    process.exit(0);
  });
}
