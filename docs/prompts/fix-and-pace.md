# Prompt: Fehler fixen, Verbesserungen vorschlagen, Pacing auf ≥ 10 Minuten

Ein wiederverwendbarer Prompt für eine Agent-Session (Claude Code o. ä.). Ziel:
Fehler finden und beheben, Verbesserungen vorschlagen und das Pacing so ändern,
dass ein Match **im Schnitt mindestens 10 Minuten** dauert — gemessen, nicht
geschätzt. Alles unterhalb der Linie einfügen.

Ergänzt `fix-and-optimize.md`: dessen harte Regeln gelten hier unverändert, aber
diese Aufgabe *darf und soll* die Fixture-Hashes bewegen, weil sie die
Spielregeln ändert.

---

Du arbeitest an **diomano**, einem 1v1-Godgame im Browser auf einem
Cubed-Sphere-Planeten. Die Simulation (`crates/diomano-sim`) ist `no_std`,
rein ganzzahlig und abhängigkeitsfrei und wird aus derselben Quelle nativ und
nach `wasm32-unknown-unknown` gebaut. `crates/diomano-wasm` ist eine dünne
`extern "C"`-Schale, `crates/diomano-cli` der Replay-Verifier und
Perf-Harness, `web/` der Three.js-Client.

Deine Aufgabe hat drei Teile, in dieser Reihenfolge:

1. **Messen**, wie lange ein Match heute dauert, mit einem Werkzeug, das du
   dafür baust.
2. **Pacing ändern**, bis die durchschnittliche Matchdauer ≥ 10 Minuten
   (= **18.000 Ticks** bei `TICK_HZ = 30`) beträgt — ohne dass das Spiel
   dadurch zäh oder entscheidungslos wird.
3. **Fehler fixen und Verbesserungen vorschlagen**, die dir dabei begegnen
   oder die du gezielt suchst.

Repo-Sprache ist Englisch: Code, Kommentare, Commit-Messages, `PLAN.md` und
`docs/specs/*` bleiben Englisch, im bestehenden Ton. Texte, die der Spieler
sieht (HUD, Banner, Endkarte), sind Deutsch, wie der Rest der Oberfläche.

## Zuerst lesen, in dieser Reihenfolge

1. `README.md` — Layout, Steuerung, was bewusst fehlt.
2. `PLAN.md` — besonders `## Next`, die offenen `- [ ]`-Punkte und die
   „decisions needing a human“.
3. **`docs/specs/pacing.md`** — das ist der Kern dieser Aufgabe. Fünf
   Regeländerungen, entworfen am 2026-08-27, nicht implementiert. Die
   Zeilennummern dort (`ai.rs:174`, `combat.rs:253`, …) können veraltet sein;
   prüfe jede Stelle im aktuellen Code, bevor du dich auf sie verlässt.
4. `docs/specs/determinism.md`, `docs/specs/combat.md`,
   `docs/specs/simulation.md`.
5. `docs/HANDOFF.md` §5.5 (Tide, Matchlänge) und die `[mode.tide]`-Tabelle —
   die Spezifikation gewinnt jeden Widerspruch, außer wo `PLAN.md` eine
   Abweichung ausdrücklich als Entscheidung festhält.
6. `docs/balance-research.md` — warum jeder `[START]`-Wert gespielt und nicht
   nachgeschlagen werden muss.
7. `justfile` und `.github/workflows/ci.yml` — was „grün“ bedeutet.

## Warum Matches heute zu kurz sind

Kurzfassung aus `pacing.md`: Der Skript-Gegner verlässt das Curriculum nach
einem Durchlauf (~19 s), schickt die Armee über den Causeway, `besiege` hat
keinen Boden, ein geschleiftes Dorf projiziert keinen Einfluss mehr, und
`check_sudden_death` macht aus null Einfluss im selben Tick ein Ergebnis. Ein
passiver Spieler verliert nach ~4.200 Ticks (≈ 2:20). Die eigentliche
Wertung — Einfluss auf bewohnbarem Land, gemessen an jedem Wellenhöhepunkt —
kommt nie zum Zug. Das ist kein Schwierigkeitsproblem, sondern verkehrt das
Design: der schnellste Weg zum Sieg umgeht das Terraforming, um das sich das
Spiel dreht.

## Harte Regeln — niemals verletzen

- **Determinismus ist das Produkt.** Keine Floats im Sim-State, keine
  `HashMap`/ungeordnete Iteration, nichts Plattform- oder
  Allokationsabhängiges in `diomano-sim`. Jeder neue Zustand (z. B. `doom`)
  geht in `state_hash` und in `zeroed()`.
- **Die Crate-Aufteilung bleibt.** `diomano-sim` weiß nichts von wasm,
  Browser oder Three.js.
- **Fixtures sind Beweise.** Diese Aufgabe ändert Regeln, also *werden* die
  Hashes sich bewegen — aber nur in eigenen Commits, die sagen, welche Regel
  sie bewegt hat (`just record`, `just record-corpus`, danach `just verify`,
  `just verify-cross`, `just verify-corpus`). Ein reiner Bugfix oder Refactor
  darf keinen Hash bewegen; tut er es doch, ist er kein reiner Fix.
- **Null Warnungen.** Kein `#[allow]`, kein `@ts-ignore`, keine
  Biome-Ausnahme, um grün zu werden.
- **Kein Test wird übersprungen, abgeschwächt oder gelöscht**, nur um grün zu
  werden. Tests, deren *Aussage* durch eine beabsichtigte Regeländerung falsch
  wird, werden durch die in `pacing.md` genannten Nachfolger **ersetzt**, im
  selben Commit wie die Regeländerung, mit Begründung.
- **Kein Scope-Creep.** Keine Netcode-Transportschicht, kein WebRTC, keine
  Lobby, keine Menüs/Einstellungsseiten, keine externen Assets (README „What
  is not here“, HANDOFF §7.5 CC0-only).
- **10 Minuten erreicht man nicht durch Warten.** Verboten als Haupthebel:
  nur `recovery_ticks`/`lull_ticks` aufblähen, den Gegner abschalten oder
  lähmen, Sudden Death ersatzlos streichen, Kämpfe wirkungslos machen. Ein
  Match, das 10 Minuten dauert, weil zehn Minuten nichts passiert, ist ein
  Fehlschlag. Die Matchlänge soll daraus entstehen, dass Siege über das
  Terrain und die Wellenwertung laufen.

## Schritt 1 — Ausgangslage

Vor jeder Änderung ausführen und die Ausgabe festhalten:

```sh
just check
just verify && just verify-cross && just verify-lockstep
just verify-boot
just verify-match 00
just perf
```

Was auf einem sauberen Checkout schon rot ist, ist dein erster Bug: Ursache
finden, fixen, erst dann weiter.

## Schritt 2 — Messinstrument bauen (vor jeder Regeländerung)

Ohne Zahl keine Pacing-Aussage. Baue `diomano-cli sweep`, wie in `pacing.md`
unter „Measuring it“ beschrieben:

- Batch über Seeds × Terrains, eine Zeile pro Match: End-Tick, Ursache
  (`tide.phase == TIDE_DONE` → Wellenwertung, sonst Sudden Death — dieselbe
  Ableitung wie die Endkarte in `game.ts`), Gebietsanteil an jedem
  Wellenhöhepunkt, Siedlungsbilanz, Gewinner.
- Spielerverhalten `idle` (keine Commands, Gegner an) und `scripted`
  (`demo_script` einseitig, wie `trace --ai`). Wenn es mit wenig Aufwand
  geht, ein drittes Profil `mirror`, in dem beide Seiten vom Skript-Gegner
  gespielt werden — das kommt einem echten Match am nächsten.
- Zusammenfassung am Ende: Mittelwert, Median, p10, p90, Min/Max der
  Matchdauer in Ticks **und** mm:ss, Anteil Sudden Death vs. Wellenwertung,
  Siegquote pro Seite.
- Exit-Code ≠ 0, wenn ein Match vor dem ersten Wellenhöhepunkt entschieden
  wird, wenn ein `idle`-Spieler vor Welle 2 verliert, oder wenn der
  Durchschnitt unter 18.000 Ticks liegt (Schwelle als Konstante mit
  Begründungskommentar).
- `justfile`-Rezept `sweep seeds="8"`. Achte auf die Laufzeit: Wenn ein
  voller Sweep zu lange für die CI-Gate dauert, gehört er in einen eigenen
  Job oder ein eigenes Rezept, nicht in `just check`.

Dann **die Ausgangslage messen** und die Tabelle im Commit und später im
Bericht festhalten. Erwartung laut `pacing.md`: ~2–3 Minuten. Wenn deine Zahl
stark abweicht, verstehe zuerst warum.

## Schritt 3 — Pacing umsetzen

Setze die fünf Änderungen aus `pacing.md` um, **jede als eigener Commit** mit
den dort genannten Tests (Nachfolger ersetzen die alten Tests, neue kommen
dazu):

1. Belagerung kann nicht schleifen (`SIEGE_FLOOR`, `ticks_to_subdue`).
2. Home Core (`SANCTUARY_STRENGTH`, symmetrisch für beide Seiten).
3. Grace-Countdown (`doom`, `GRACE_TICKS`, in `state_hash`; wasm-Exporte
   `dio_doom_ticks(player)`, `dio_grace_ticks()`).
4. Sudden Death erst nach der ersten Welle scharf.
5. Gegner eskaliert mit der Tide (`PHASE_WAR` erst ab `wave >= 1`,
   `Lesson::min_wave`, Erdbeben ab Welle 2).

Dazu die Spielerseite: HUD-Zeile „Dein Volk hat kein Land mehr — 74 s“ nur
solange `dio_doom_ticks > 0`, ein Banner auf der Flanke 0 → >0, der Countdown
des Gegners bleibt unsichtbar. Und die Regression
`an_idle_player_survives_the_first_two_waves_against_the_scripted_opponent`
in `settlements.rs`; die Notiz dort zu „tick ~4,200“ wird im selben Commit
umgeschrieben.

Nach jeder Änderung: `just test`, `just sweep`, Zahl notieren. So sieht man,
welche Änderung wie viel Matchdauer bringt — das gehört in die Commit-Message.

Danach **ein** Commit, der die Fixtures neu aufnimmt
(`just record` → `just record-corpus` → `just verify` → `just verify-cross`
→ `just verify-corpus`), mit Begründung. Prüfe das in `pacing.md` benannte
Risiko: §6.3 verlangt ≥ 200 Kampfauflösungen im Korpus — messen, nicht
annehmen.

## Schritt 4 — nachtunen, bis die Zahl hält

Wenn der Durchschnitt danach noch unter 18.000 Ticks liegt oder die
Verteilung schief ist (z. B. Durchschnitt 10 min, aber ein Drittel der Matches
unter 4 min), iteriere — einen Hebel pro Commit, mit Sweep-Zahlen vorher und
nachher. Hebel, in der Reihenfolge, in der du sie probieren solltest:

- die offenen Fragen aus `pacing.md`: `SANCTUARY_STRENGTH`, `GRACE_TICKS`
  (reichen 90 s, um aus einem nackten Home Core ein Dorf zu gründen? miss
  es), Erdbebenkosten, wenn Belagerung nicht mehr schleift;
- Gegnerverhalten: Mana-Reserve vor Angriffen, Abstand zwischen Strikes,
  wie früh der Magnet auf die stärkste feindliche Siedlung geht;
- Kampfwerte und Marschgeschwindigkeit nur, wenn die oben nichts bringen;
- Tide-Timing (`lull_ticks`, `recovery_ticks`, `waves`) zuletzt — und nur mit
  Blick auf HANDOFF §5.5.

**Achtung, Widerspruch in der Spezifikation:** HANDOFF nennt sowohl „a wave
every 15 minutes“ (`recovery_ticks = 25500`) als auch „a full match in roughly
15 minutes“. Mit 3 Wellen und 14:10 Ruhephase dauert ein Match ohne Sudden
Death gut 30 Minuten. Löse das **nicht** stillschweigend. Liefere die gemessene
Verteilung, schlag ein Zielband vor (z. B. 10–20 Minuten) samt den Werten, die
es erreichen, und trag es in `PLAN.md` unter „decisions needing a human“ ein.

Akzeptanz für diesen Schritt, alles aus `just sweep` belegt:

- Durchschnitt **≥ 18.000 Ticks (10:00)** über mindestens 8 Seeds × alle
  Terrains, für `scripted` und (falls gebaut) `mirror`;
- kein Match vor dem ersten Wellenhöhepunkt entschieden;
- `idle` verliert nie vor Welle 2 — darf aber verlieren; ein Spiel, in dem
  Nichtstun nicht verliert, ist auch kaputt;
- ein messbarer Anteil der Matches wird durch die Wellenwertung entschieden,
  nicht nur durch Sudden Death.

Optional, wenn Zeit bleibt: `web/tools/play.mjs` aus `pacing.md` (Playwright
gegen den echten Client, gemeinsamer Harness mit `screenshot.mjs`), mit
Screenshots bei Welle im Anmarsch, Impact, laufendem Countdown und Endkarte.
Das ist der einzige Beleg, dass der Countdown im Spiel auch *sichtbar* ist.

## Schritt 5 — Fehler suchen und fixen

Neben dem, was dir beim Pacing begegnet, gezielt suchen. Rangfolge nach
Wirkung auf Spieler oder Determinismus:

- **Offene Punkte in `PLAN.md`**, die schon als Fehler erkannt, aber nicht
  behoben sind, z. B.: Lava-Knistern würfelt pro Render-Frame (Dichte hängt
  an der Bildwiederholrate, `setTargetAtTime` jedes Frame); ein Rechtsklick
  bei gedrückter linker Taste startet kein Orbit (Pointer Events liefern das
  als `pointermove`); nach dem Schließen des Radialmenüs zielt die Hand noch
  dorthin, wo das Menü aufging. Prüfe, ob sie noch reproduzierbar sind.
- **Eingabe** (`web/src/keys.ts`, `hand.ts`, `verbs.ts`, `camera.ts`,
  `radial.ts`): hängende Tasten bei Blur/`visibilitychange`, Key-Repeat,
  Picking an Würfelnähten und bei streifendem Blick, verlorene oder doppelte
  Taps zwischen Ticks.
- **Simulation an Rändern** (`seams.rs`, `world.rs`, `water.rs`,
  `materials.rs`, `walkers.rs`, `combat.rs`, `settlements.rs`, `powers.rs`,
  `ai.rs`, `tide.rs`): Würfelecken und Nahtübergänge, Materialerhaltung bei
  jedem Verb, Überlauf und Abschneiden in Integer-Arithmetik, Zähler, die in
  den Hash leaken oder fehlen. Die neuen Pacing-Regeln sind eine neue
  Fehlerquelle: Was passiert mit `doom` bei Neustart über `dio_init`, bei
  `cfg.endless`, bei einem Unentschieden, wenn der Home Core überflutet und
  wieder trockenfällt?
- **Client-Zustand über Neustarts**: Endkarte → Neustart (gleicher/neuer
  Seed) muss HUD, Countdown, Banner und Audio vollständig zurücksetzen.
- **Doku, die dem Code widerspricht**: ein Spec-Wert, der nicht mehr stimmt,
  ist ein Bug in einem der beiden — entscheide, welcher, und fix ihn.

Für jeden Bug: **zuerst** ein fehlschlagender Test oder Harness-Check, dann
der Fix, dann der Test grün. Ein Bug pro Commit,
`fix(<bereich>): <was sich jetzt richtig verhält>`, Body: warum es falsch war,
wie gefunden, wie verifiziert.

## Schritt 6 — Verbesserungen vorschlagen (nicht alle umsetzen)

Sammle Verbesserungen, die du für lohnend hältst, aber nicht im Rahmen dieser
Aufgabe umsetzt — Spielgefühl, Lesbarkeit für neue Spieler, Gegner-KI,
Balance, Performance, Werkzeuge. Für jeden Vorschlag: Problem (mit Beleg:
Messwert, Screenshot, Codestelle `datei:zeile`), vorgeschlagene Änderung,
erwarteter Effekt, Risiko (bewegt es Hashes? betrifft es die Wellenwertung?),
grober Aufwand. Umsetzen nur, wenn klein, eindeutig und im Scope; alles andere
geht in den Bericht und, falls dauerhaft relevant, als `- [ ]` in `PLAN.md`.

## Schritt 7 — beweisen

Vor jedem Push alles grün, Zusammenfassung in den Bericht:

```sh
just check
just verify && just verify-cross && just verify-lockstep && just verify-corpus
just verify-boot && just verify-input
just verify-match 00
just sweep
just perf
```

`just perf` muss im 12-ms-Budget (§4.1) bleiben; neue Pro-Tick-Arbeit (z. B.
der Home-Core-Seed, der `doom`-Scan) darf das nicht sprengen — Zahlen vorher
und nachher, und sag dazu, dass eine Zahl von dieser Maschine eine Obergrenze
ist, nicht das §7.6-Referenzgerät.

Lies deinen eigenen Diff feindselig: Was würde die CI ablehnen? Was würde
jemand einwenden, dem nur Determinismus wichtig ist? Und jemand, dem nur
wichtig ist, ob das Spiel Spaß macht?

## Doku

`docs/specs/pacing.md` vom Status „design, not yet implemented“ auf den
umgesetzten Stand bringen, mit den gemessenen Werten. `PLAN.md` aktualisieren:
erledigte Punkte abhaken, Testanzahl im Block „Machine-checkable acceptance“,
die Sweep-Tabelle, offene Entscheidungen. Die Mindest-Matchlängen-Asserts
(`settlements.rs`, `main.rs::MIN_MATCH_TICKS`, `screenshot.mjs`) bleiben und
werden ggf. an die neue Untergrenze angepasst, nicht entfernt.

## Bericht

Am Ende kurz und in Tabellen:

1. **Pacing:** Sweep-Ergebnis vorher → nach jeder Regeländerung → final
   (Mittelwert, Median, p10, p90, Anteil Sudden Death/Wellenwertung,
   Siegquoten), mit Commit pro Zeile.
2. **Bugs:** Symptom, Ursache, Test, der ihn jetzt bewacht, Commit.
3. **Verbesserungsvorschläge:** wie in Schritt 6, sortiert nach
   Nutzen/Aufwand.
4. **Bewusst nicht gefixt**, mit Grund.
5. **Entscheidungen für einen Menschen** — festgehalten, nicht stillschweigend
   entschieden, im Stil von PLAN.md (mindestens: das Zielband der Matchlänge
   und der Widerspruch in HANDOFF §5.5).
