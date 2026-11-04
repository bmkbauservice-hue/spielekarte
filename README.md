# Spielekarte · MKDIR DESIGN

NFC-Karte antippen → Spielraum dieser Karte öffnet sich → mit den anderen am Handy Skat spielen.
Nur zum Spaß – kein Geld, kein Einsatz.

Jede Karte hat eine feste URL, z. B. `https://mkdirdesign.com/spiel/k/MUJU01`.
Die Karten-ID (`MUJU01`) ist der Raum: 3 Plätze am Tisch, beliebig viele Zuschauer (max. 20).

**Stand:** Etappe 2 – Skat-Grundspiel (noch ohne Reizen). Reizen und Punkteliste folgen in Etappe 3.

## Spielablauf (Etappe 2)

1. Drei Spieler sitzen am Tisch, einer drückt „Spiel starten“.
2. Gemischt wird mit kryptografischem Zufall: 10 Karten je Spieler, 2 in den Skat.
3. **Vorhand** (links vom Geber) ist Alleinspieler und wählt Kreuz, Pik, Herz, Karo oder Grand.
   Reizen gibt es noch nicht. Weil der Geber jede Runde weiterrückt, wechselt der Alleinspieler reihum.
4. 10 Stiche mit Bedienpflicht. Buben sind immer Trumpf (Kreuz > Pik > Herz > Karo), im Farbspiel
   zusätzlich die Trumpffarbe. Wer den Stich gewinnt, spielt aus.
5. Augen: A 11, 10 10, K 4, D 3, B 2. Der Skat zählt für den Alleinspieler, gewonnen ab 61 Augen.
6. Ergebnis mit Schneider/Schwarz-Hinweis und aufgedecktem Skat, dann „Neue Runde“.

Jedes Handy bekommt nur die eigenen Handkarten. Klickbar sind nur die Karten, die der Server
erlaubt, und der Server prüft jeden Zug noch einmal.

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

- `test/rules.test.js` – Skat-Regeln: Blatt, Mischen, Trumpf, Buben-Reihenfolge, Bedienpflicht, Stichgewinner
- `test/game.test.js` – Spielablauf, Sichtbarkeit der Karten, 500 simulierte Spiele (immer 120 Augen)
- `test/room.test.js` – Raum-Logik (Plätze, Tokens, Start, Runden, Aufräumen) ohne Netzwerk
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
3. ⏳ Reizen, Skat aufnehmen/drücken, Ansagen, Spielwert, Punkteliste
4. ⏳ Design + Animationen
