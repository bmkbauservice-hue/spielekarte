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
- Räume im Arbeitsspeicher (keine Datenbank). Ein Raum pro Karten-ID,
  3 Spielplätze + Zuschauer.
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
  game/rules.js      Trumpf, Bedienpflicht, Stichgewinner, Auswertung – reine Funktionen
  game/game.js       SkatGame: eine Runde (ansagen → 10 Stiche → Ergebnis), viewFor(seat)
  rooms/room.js      Reine Raum-Logik (Plätze, Tokens, Start, Runden) – ohne Netzwerk, gut testbar
  rooms/registry.js  Verwaltet alle Räume (anlegen, aufräumen)
  public/            Browser-Dateien (HTML, CSS, JS)
test/                Tests mit node:test
```

## Etappenplan

1. **Spielraum** – Karte öffnen → Name eingeben → Live-Liste, wer im Raum ist;
   bei 3 Spielern „Spiel starten“. Lokal mit 3 Browser-Tabs testbar.
   Abschluss: README mit lokalem Test + Dockerfile.
2. **Skat-Grundspiel** – 32 Karten, mischen, 10 je Spieler + 2 Skat, Stiche mit
   Bedienpflicht, Trumpf bei Farbspiel/Grand, Augen zählen, Gewinner. Tests Pflicht.
3. **Reizen** (18, 20, 22 …), Skat aufnehmen/drücken, Farbe/Grand/Null ansagen,
   Spielwert, Punkteliste über mehrere Runden.
4. **Design + Animationen.**

Immer nur eine Etappe gleichzeitig; jede einzeln testbar.

## Stand

- Etappe 1: fertig, live unter https://mkdirdesign.com/spiel (Auto-Deploy bei Merge auf `main`).
- Etappe 2: fertig, PR offen (Branch `etappe-2-skat`). Vorhand ist Alleinspieler (ohne Reizen),
  Skat bleibt liegen und zählt für den Alleinspieler. Dazu Review-Punkte: `CARD_IDS`, Beitritts-Limit.
- Nächster Schritt: Etappe 3 – Reizen, Skat aufnehmen/drücken, Null-Spiele, Spielwert, Punkteliste.

## Konventionen

- Karten als Text `"<farbe>-<wert>"`, Farben `kreuz|pik|herz|karo`, Werte `7 8 9 10 B D K A`.
- Fehler für Nutzer: `RoomError` / `GameError` mit `code` (für den Client) und deutscher `message`.
- Statische Dateien in HTML immer mit `?v={{V}}` einbinden (Cache-Busting).
- Neue Socket-Ereignisse über `action()` in `app.js` (Rate-Limit + Fehlerbehandlung inklusive).
