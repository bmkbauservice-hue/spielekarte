# Spielekarte – MKDIR DESIGN

NFC-Karte mit fester URL (z. B. `https://mkdirdesign.com/spiel/k/MUJU01`).
Antippen mit dem Handy → man landet im Spielraum **dieser** Karte und spielt
mit den anderen Skat. Nur zum Spaß – kein Geld, kein Einsatz.

## Arbeitsweise (verbindlich)

- **Nie direkt auf `main` committen.** Immer Branch + Pull Request, der Inhaber merged selbst.
- Kurz erklären, **was** gemacht wird und **warum** (Inhaber ist in einer Umschulung und lernt mit).
- Alles über Terminal-Befehle, keine Klick-Anleitungen.
- Große Aufgaben in kleine Schritte teilen, nach jedem Schritt kurz den Stand zusammenfassen.
- Tests für die Regel-Logik; ab Etappe 2 Pflicht (`npm test` muss grün sein vor jedem PR).
- Sprache der Oberfläche: Deutsch. Handy zuerst (Mobile First).

## Technik

- Node 22 (Docker-Image `node:22-alpine`), ES-Module, Express 5 + Socket.IO.
- **Server-authoritative:** Der Server hält den kompletten Spielstand. Jeder Spieler
  bekommt nur SEINE Handkarten; Skat und fremde Karten verlassen nie den Server.
  Deshalb wird der Zustand pro Spieler einzeln gesendet (`room.stateFor(token)`).
- Echtzeit per Socket.IO (automatischer Reconnect am Handy).
- Spieler-Identität: geheimes Token vom Server, im Browser im `localStorage`
  (Schlüssel pro Raum). Neuladen = gleicher Platz. Tokens werden nie an andere
  Spieler geschickt – öffentlich ist nur eine kurze `id`.
- Räume im Arbeitsspeicher, zusätzlich als Schnappschuss in SQLite (`DB_PATH`, eingebautes `node:sqlite`),
  damit Abende einen Neustart/Deploy überleben. Ein Raum pro Karten-ID, 3 Spielplätze + Zuschauer.
- Basis-Pfad konfigurierbar über `BASE_PATH` (Produktion `/spiel`, lokal leer).
- Docker: Container `spielekarte`, Port 3000, externes Docker-Netz `web`,
  davor Caddy unter `https://mkdirdesign.com/spiel`.
- Look: dunkles Smaragdgrün, Gold, Neon-Akzente.

## Befehle

```bash
npm install          # Abhängigkeiten
npm run dev          # lokal starten (http://localhost:3000, ohne Prefix), Neustart bei Änderungen
BASE_PATH=/spiel npm start   # wie in Produktion mit Prefix
npm test             # alle Tests (node:test)
```

## Struktur

```
src/
  server.js          Einstiegspunkt (liest Konfiguration, startet Server)
  config.js          Umgebungsvariablen → Konfiguration
  app.js             Express + Socket.IO verdrahten (createApp)
  rate-limit.js      Gleitendes Zeitfenster gegen Spam
  game/cards.js      Blatt, Augen, Mischen (crypto) – reine Funktionen
  game/rules.js      Trumpf, Bedienpflicht, Stichgewinner (inkl. Null) – reine Funktionen
  game/scoring.js    Reizwerte, Spitzen, Spielwert, Überreizen, Ansage prüfen – reine Funktionen
  game/bidding.js    Reizen als Zustandsautomat
  game/stats.js      Abendwertung + Seeger-Fabian aus der Spielhistorie – reine Funktionen
  game/house-rules.js Hausregeln (Kontra/Re, Bock, Schenken) – reine Funktionen; neue Hausregeln kommen hierher
  game/errors.js     GameError
  game/game.js       SkatGame: eine Runde (reizen → Skat/Hand → drücken → ansagen → Stiche), viewFor(seat)
  rooms/room.js      Reine Raum-Logik (Plätze, Tokens, Start, Runden) – ohne Netzwerk, gut testbar
  rooms/registry.js  Verwaltet alle Räume (anlegen, aufräumen, laden/speichern)
  storage/sqlite-store.js  SQLite: eine Zeile pro Raum (JSON-Schnappschuss), Migrationen, Sicherung
scripts/backup.js    Datensicherung (VACUUM INTO)
  public/            Browser-Dateien (HTML, CSS, JS)
  public/static/fx.js  Animationen (window.SkatFX) – nur Show, nie Spielzustand
  public/static/fonts/, img/  selbst gehostete Schriften + Logo (npm run assets)
test/                Tests mit node:test
```

## Etappenplan

1. **Spielraum** – Karte öffnen → Name eingeben → Live-Liste, wer im Raum ist;
   bei 3 Spielern „Spiel starten“. Lokal mit 3 Browser-Tabs testbar.
   Abschluss: README mit lokalem Test + Dockerfile.
2. **Skat-Grundspiel** – 32 Karten, mischen, 10 je Spieler + 2 Skat, Stiche mit
   Bedienpflicht, Trumpf bei Farbspiel/Grand, Augen zählen, Gewinner. Tests Pflicht.
3. **Echtes Skat** – Reizen, Skat aufnehmen/drücken oder Hand, Farbe/Grand/Null (+Hand/Ouvert),
   Spielwert, Punkteliste, Abbrechen/Abend beenden nur gemeinsam, Abendwertung + Seeger-Fabian.
   - 3b **Hausregeln** (eigenes Modul, pro Tisch beim Start einschaltbar, Standard aus):
     Kontra/Re, Bockrunden, Schenken. Danach Abendwertung um Kontra/Re/Bock ergänzen.
   - 3c **Speichern** (z. B. SQLite im Docker-Volume): Abend, Punkteliste, Bock-Zähler überleben Deploys.
4. **Design + Animationen** – Wunschliste in `docs/etappe-4-design.md`.

Immer nur eine Etappe gleichzeitig; jede einzeln testbar.

## Stand

- Etappe 1–3c live (Spielraum, Skat, Hausregeln, SQLite).
- Etappe 4 (Design + Animationen): PR offen (Branch `etappe-4-design`).
- Ideen danach: Spielvideos/Replay, mehrere Tische pro Abend, Statistik über Abende hinweg.

## Entscheidungen (vom Inhaber bestätigt)

- Abstimmung (Abbrechen/Abend beenden): Wer > 2 min getrennt ist, blockiert nicht – sonst hinge der Tisch fest.
- Null darf nicht angesagt werden, wenn sein Festwert unter dem Reizwert liegt.
- Schenken: Abgelehnt → Schneider wird Pflicht (gewertet wie „Schneider angesagt“).
  Angenommen + überreizt → gewonnen mit dem kleinsten Vielfachen ≥ Reizwert.
- Schenken nur bei Farbe/Grand ohne Schneider-/Schwarz-Ansage und ohne Ouvert (eigene Festlegung).
- Bock nur zusammen mit Kontra/Re wählbar (wird nur dadurch ausgelöst).
- Hausregeln nur in der Lobby änderbar; während eines Abends fest.

## Konventionen

- Karten als Text `"<farbe>-<wert>"`, Farben `kreuz|pik|herz|karo`, Werte `7 8 9 10 B D K A`.
- Fehler für Nutzer: `RoomError` / `GameError` mit `code` (für den Client) und deutscher `message`.
- Statische Dateien in HTML immer mit `?v={{V}}` einbinden (Cache-Busting).
- Neue Socket-Ereignisse über `action()` in `app.js` (Rate-Limit + Fehlerbehandlung inklusive).
- Socket-Ereignisse: `game:bid {action}`, `game:skat`, `game:discard {cards}`, `game:declare {…}`,
  `game:play {card}`, `game:next`, `vote:request {kind: abort|end}`, `vote:cast {agree}`,
  `evening:new`, `evening:lobby`, `rules:set {kontra, bock, schenken}`, `game:kontra`, `game:re`,
  `game:gift {yes}`, `game:gift-answer {accept}`.
- Eigenschaft und Methode nie gleich benennen (`bid()` vs. `bidValue`).
- PRs immer gegen `main` (nie gegen einen anderen Feature-Branch stapeln).
- Neuer Zustand in Room/SkatGame/Bidding → muss in `toJSON`/`fromJSON` (Room listet Felder explizit!).
  Inkompatible Änderung am Format → `SNAPSHOT_VERSION` hochzählen (alte Räume werden dann übersprungen).
- Jede Zustandsänderung in `app.js` über `publish(room)` (speichern + senden), nicht nur `broadcast`.
- Oberfläche: keine `style="…"`-Attribute im HTML (CSP blockiert sie) – Klassen nutzen; per JS `el.style.x` ist erlaubt.
- Animationen nur mit `transform`/`opacity`, über `fx.js`; Tisch/Hand nur bei geändertem Schlüssel neu zeichnen,
  sonst würgt jede Server-Nachricht laufende Animationen ab.
- Cormorant-Ziffern brauchen `font-variant-numeric: lining-nums` (sonst 0 wie „o“, 1 wie „I“).
