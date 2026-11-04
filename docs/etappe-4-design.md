# Etappe 4 – Design + Animationen (Wunschliste, Stand 04.11.2026)

Vorlage: Design-Artifact „Spielekarte Skat – Design“ (Kartenblatt + Rückseite, Spielraum, Spieltisch, Reizen).

## Misch-Animation („so ein bisschen mit Tricksen, irgendwas Cooles“)

Läuft nach „Neue Runde“, bevor gegeben wird. Nur Show – gemischt wird echt auf dem Server (crypto).
Ablauf (ca. 3 Sekunden, auf allen drei Handys gleichzeitig):

1. **Einsammeln:** alle Karten fliegen vom Tisch in die Mitte zu einem Stapel (Rückseite mit MKDIR-Logo).
2. **Riffle-Shuffle:** Stapel teilt sich in zwei Hälften, Karten rauschen abwechselnd ineinander.
3. **Trick** (zufällig einer): Karten-Fächer, der sich wie ein Rad dreht · Wasserfall/„Bridge“
   (Karten biegen sich und fallen zurück) · Karten springen im Bogen von einer Hand zur anderen
   · kurzes Gold-/Neon-Funkeln über dem Stapel.
4. **Abheben:** kurzes Abheben beim Spieler rechts vom Geber (Name blinkt auf).
5. **Geben:** Karten fliegen im Skat-Rhythmus (3 – Skat 2 – 4 – 3) zu den drei Plätzen,
   die eigenen drehen sich beim Ankommen um.

Regeln:
- Antippen überspringt die Animation.
- `prefers-reduced-motion` → nur kurzes Einblenden statt Animation.
- Flüssig auf älteren Handys: nur `transform`/`opacity` animieren, keine Layout-Animationen.
- Sound optional (leises Karten-Rascheln), standardmäßig aus.

## Weitere Animationen (Ideen)

- Karte ausspielen: fliegt aus der Hand in die Tischmitte.
- Stich: die drei Karten rutschen zum Gewinner.
- „Du bist dran“: Neon-Mint-Puls.
- Bock aktiv: dezenter goldener Rand um den Tisch.
- Spiel gewonnen: kurzes Gold-Funkeln; Abend-Zusammenfassung: Siegertreppchen.

## Hinweis zur Umsetzung

- Synchron auf allen Handys: Der Server schickt mit der neuen Runde einen Zeitpunkt/Anlass
  („deal-animation“); die Animation darf den Spielzustand nie verzögern oder verändern.
- Detail-Datei „claude/spielekarte.md → Abschnitt Design“ liegt (noch) nicht im Repo.
