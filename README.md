# Spielekarte · MKDIR DESIGN

NFC-Karte antippen → Spielraum dieser Karte öffnet sich → mit den anderen am Handy Skat spielen.
Nur zum Spaß – kein Geld, kein Einsatz.

Jede Karte hat eine feste URL, z. B. `https://mkdirdesign.com/spiel/k/MUJU01`.
Die Karten-ID (`MUJU01`) ist der Raum: 3 Plätze am Tisch, beliebig viele Zuschauer (max. 20).

**Stand:** Etappe 3 – echtes Skat mit Reizen, Skat/Hand, allen Spielarten, Spielwert, Punkteliste und Abendwertung.
Hausregeln (Kontra/Re, Bock, Schenken) folgen in Etappe 3b, Speichern in Etappe 3c, Design in Etappe 4.

## Spielablauf

1. Drei Spieler sitzen am Tisch, einer drückt „Spiel starten“. Damit beginnt der **Abend**.
2. Gemischt wird mit kryptografischem Zufall: 10 Karten je Spieler, 2 in den Skat.
3. **Reizen** nach Skatordnung: Mittelhand sagt Vorhand (18, 20, 22, 23, 24, 27 …),
   Vorhand antwortet „Ja“ oder „Passe“. Danach sagt Hinterhand dem Sieger weiter.
   Hat niemand gereizt, darf Vorhand 18 spielen. Passen alle → **eingepasst**, der Nächste gibt.
4. Der Alleinspieler nimmt den **Skat** auf und **drückt** 2 Karten – oder spielt **Hand**.
5. **Ansage:** Kreuz, Pik, Herz, Karo, Grand oder Null. Bei Handspiel zusätzlich Schneider/Schwarz
   ansagen oder Ouvert. Null Ouvert geht auch nach dem Aufnehmen.
6. 10 Stiche mit Bedienpflicht. Im Null gibt es keinen Trumpf (Reihenfolge 7 8 9 10 B D K A),
   und das Spiel endet sofort, wenn der Alleinspieler einen Stich bekommt.
7. **Abrechnung** mit Rechenweg, z. B. „mit 2 + Spiel + Hand = 4 × 10 = 40“.
   Überreizt → verloren mit dem nächsthöheren Vielfachen des Grundwerts.
8. **Punkteliste:** gewonnen +Spielwert, verloren −2× Spielwert; Seeger-Fabian als Zusatzzeile.
9. **Abbrechen** oder **Abend beenden** nur, wenn alle drei innerhalb von 60 Sekunden zustimmen.
   Danach zeigt die Abendwertung für alle: Platz, Punkte, Seeger-Fabian, Alleinspiele, bestes Spiel, Dauer.

Jedes Handy bekommt nur die eigenen Handkarten (Ausnahme: Ouvert – da liegen die Karten des
Alleinspielers für alle offen). Klickbar sind nur erlaubte Karten, und der Server prüft jeden Zug.

### Spielwert

| | |
|---|---|
| Grundwert | Karo 9 · Herz 10 · Pik 11 · Kreuz 12 · Grand 24 |
| Stufen | Spitzen (mit/ohne, mit Skat gezählt) + Spiel + Hand + Schneider + Schneider angesagt + Schwarz + Schwarz angesagt + Ouvert |
| Null | Null 23 · Null Hand 35 · Null Ouvert 46 · Null Ouvert Hand 59 |
| Gewonnen | ab 61 Augen (Skat bzw. Gedrücktes zählt für den Alleinspieler) |

## Voraussetzungen

- Node.js 22 oder neuer (`node -v`)
- Für den Container: Docker

## Lokal starten

```bash
git clone https://github.com/bmkbauservice-hue/spielekarte.git
cd spielekarte
npm install
npm run dev        # startet auf http://localhost:3000 und startet bei Code-Änderungen neu
```

## Lokal testen mit 3 Browser-Tabs

Alle Tabs eines Browsers teilen sich denselben `localStorage` und wären damit **dieselbe Person**.
Deshalb gibt es zum Testen den Parameter `?profil=…`: Jedes Profil ist eine eigene Identität.

```bash
xdg-open "http://localhost:3000/k/TEST01?profil=a"
xdg-open "http://localhost:3000/k/TEST01?profil=b"
xdg-open "http://localhost:3000/k/TEST01?profil=c"
```

1. In jedem Tab einen Namen eingeben → alle Tabs zeigen sofort die Liste „Am Tisch“.
2. Sobald 3 Spieler sitzen, erscheint „Spiel starten“.
3. Optional: ein 4. Tab mit `?profil=d` → landet bei den Zuschauern.
4. Einen Tab neu laden (F5) → der Spieler behält seinen Platz.
5. „Spiel starten“ drücken → alle Tabs zeigen „Spiel läuft!“.

Mit Prefix wie in Produktion testen:

```bash
BASE_PATH=/spiel npm start
xdg-open "http://localhost:3000/spiel/k/TEST01?profil=a"
```

Mit echten Handys im WLAN: `hostname -I` zeigt die IP des Rechners, dann am Handy
`http://<IP>:3000/k/TEST01` öffnen.

## Tests

```bash
npm test
```

- `test/rules.test.js` – Blatt, Mischen, Trumpf, Buben-Reihenfolge, Bedienpflicht, Stichgewinner, Null-Regeln
- `test/scoring.test.js` – Reizwerte, Spitzen, Hand-Zuschlag, Schneider/Schwarz, Überreizen, Null-Werte
- `test/bidding.test.js` – Reizen nach Skatordnung, Einpassen, 1000 zufällige Reizverläufe
- `test/game.test.js` – Spielablauf, Skat/Drücken, Null-Ende, Ouvert, Sichtbarkeit, 400 simulierte Runden
- `test/stats.test.js` – Abendwertung, Seeger-Fabian, Platzierung
- `test/room.test.js` – Raum-Logik (Plätze, Runden, Punkteliste, Abstimmungen) ohne Netzwerk
- `test/server.test.js` – echter Server unter `/spiel` mit simulierten Handys, inkl. kompletter Runde
- `test/security.test.js` – Freigabeliste, Beitritts-Limit, Cache-Busting

## Konfiguration

| Variable    | Standard  | Bedeutung                                            |
|-------------|-----------|------------------------------------------------------|
| `PORT`      | `3000`    | HTTP-Port                                            |
| `HOST`      | `0.0.0.0` | Netzwerk-Interface                                   |
| `BASE_PATH` | *(leer)*  | URL-Prefix, z. B. `/spiel`. Im Docker-Image `/spiel` |
| `CARD_IDS`  | *(leer)*  | Freigeschaltete Karten, z. B. `MUJU01,TEST01`. **Leer = alle erlaubt** (nur lokal sinnvoll) |
| `CARD_IDS_FILE` | *(leer)* | Datei mit Karten-IDs (eine pro Zeile, `#` = Kommentar), wird mit `CARD_IDS` zusammengeführt |

Unbekannte Karten-IDs bekommen eine freundliche Fehlerseite und werden auch beim Socket-Beitritt
abgelehnt. Schutz gegen Spam: pro Verbindung höchstens 10 Beitritte und 120 Aktionen pro Minute.

## Docker

Lokal bauen und starten:

```bash
docker build -t spielekarte .
docker run --rm -p 3000:3000 spielekarte                # → http://localhost:3000/spiel/k/TEST01
docker run --rm -p 3000:3000 -e BASE_PATH= spielekarte  # ohne Prefix
```

Auf dem Server (Container `spielekarte` im Docker-Netz `web`):

```bash
docker network inspect web >/dev/null 2>&1 || docker network create web
echo 'CARD_IDS=MUJU01,TEST01' > .env      # freigeschaltete Karten (wird nicht committet)
docker compose up -d --build
docker compose logs -f spielekarte
docker inspect -f '{{.State.Health.Status}}' spielekarte   # → healthy
```

### Caddy

Wichtig: `handle` (nicht `handle_path`). Die App erwartet den Prefix `/spiel` selbst,
er darf also **nicht** abgeschnitten werden. WebSockets leitet Caddy automatisch weiter.

```caddyfile
mkdirdesign.com {
    handle /spiel* {
        reverse_proxy spielekarte:3000
    }
    # … übrige Seiten
}
```

## Wie es funktioniert (kurz)

- **Server-authoritative:** Der Server hält den gesamten Zustand und schickt jedem Spieler
  nur seine eigene Sicht. Ab Etappe 2 heißt das: nur die eigenen Handkarten, Skat und fremde
  Karten bleiben auf dem Server.
- **Identität:** Beim ersten Beitritt vergibt der Server ein geheimes Token. Der Browser
  speichert es im `localStorage`. Nach Neuladen oder Funkloch meldet er sich damit wieder an
  und bekommt denselben Platz. Andere Spieler sehen nur eine öffentliche ID, nie das Token.
- **Gleiche Person, zweiter Tab:** Der neue Tab übernimmt, der alte zeigt „In anderem Fenster geöffnet“.
- **Regel-Logik ohne Netzwerk:** `src/game/` (Karten, Regeln, Spielablauf) kennt weder Socket.IO
  noch Express, deshalb lässt sie sich in Millisekunden testen.
- **Cache-Busting:** Statische Dateien werden mit `?v=<hash>` eingebunden. Nach einem Deploy
  laden Handys also nie altes JavaScript zu neuem HTML.
- **Speicher:** Alles liegt im Arbeitsspeicher. Ein Neustart leert alle Räume.
  Wer in der Lobby länger als 10 Minuten getrennt ist, verliert seinen Platz.
  Leere Räume werden automatisch gelöscht.

## Etappen

1. ✅ Spielraum: Name, Live-Liste, 3 Plätze + Zuschauer, „Spiel starten“
2. ✅ Skat-Grundspiel: Geben, Stiche mit Bedienpflicht, Trumpf, Augen, Gewinner
3. ✅ Reizen, Skat/Hand, alle Spielarten, Spielwert, Punkteliste, Abendwertung
4. ⏳ 3b Hausregeln: Kontra/Re, Bockrunden, Schenken
5. ⏳ 3c Spielstand speichern (SQLite im Docker-Volume)
6. ⏳ 4 Design + Animationen (Wunschliste: [docs/etappe-4-design.md](docs/etappe-4-design.md))
