# Kickbase Analyse

Mobile Web-App (PWA) zur Analyse von Kickbase-Ligen: optimale Aufstellung, Kauf-/Verkaufsempfehlungen,
Gebotsvorschläge und ein Modell für den „fairen“ Marktwert. Jeder Nutzer meldet sich mit seinem eigenen
Kickbase-Konto an.

## Datenschutz-Architektur

- **Kein Backend.** Die App besteht nur aus statischen Dateien. Der Browser spricht direkt mit
  `api.kickbase.com` (Kickbase erlaubt CORS).
- Passwort wird nie gespeichert. Nur das Kickbase-Token liegt in `sessionStorage`
  (bzw. in `localStorage`, wenn „Angemeldet bleiben“ gewählt ist). Abmelden löscht es.
- Strenge Content-Security-Policy: Netzwerkverbindungen nur zu Kickbase, Bilder nur vom Kickbase-CDN,
  keine Drittanbieter-Skripte, keine Fonts, kein Tracking.
- Alle Texte aus der API (z. B. frei wählbare Managernamen) werden HTML-escaped.
- Die App arbeitet nur lesend: Sie gibt keine Gebote ab und ändert keine Aufstellung.
- Der Service Worker cached nur die App-Dateien, keine API-Daten.

## Features

| Tab | Inhalt |
|---|---|
| Übersicht | Platz, Budget, Teamwert, Countdown, Warnungen (verletzt in Startelf, kein Spiel, Budget negativ), eigene offene Gebote mit Bewertung, MW-Trading (steigende Marktspieler / fallende eigene Spieler, Countdown zum MW-Update), Top-Käufe, Tausch-Ideen, Verkaufskandidaten |
| Aufstellung | Beste Elf über alle 10 Formationen nach erwarteten Punkten, Ein-/Auswechselliste, Bank |
| Markt | Kauf-Score, fairer MW und Über-/Unterbewertung, MW-Trend, nächster Gegner mit Siegchance, Gebotsvorschlag |
| Kader | Verkaufsranking, Gewinn seit Kauf, Tauschvorschläge, Budget-Ausgleich |
| Spieler | Alle ca. 460 Bundesliga-Spieler: filtern, suchen, nach Unterbewertung, Preis-Leistung usw. sortieren; optionale Tiefenanalyse |
| Liga | Tabelle, Teamwerte, Managerkader, Saisonverlauf (Punkte & Platz je Spieltag, Spieltagssiege), Restprogramm-Matrix aller Vereine, Transfer-Bilanz je Manager |
| Spieler-Detail | MW-Verlauf (3 / 12 Monate) mit fairer MW-Linie, Punkte je Spieltag, Einsatz & Konstanz (Startelf-Quote, Joker, Heim/Auswärts, Punkte/90, Streuung) im Vorsaisonvergleich, Transferhistorie |

Wie gerechnet wird, steht in der App unter ⓘ → „So rechnet die App“.

## Lokal starten

```bash
python -m http.server 8765
# http://localhost:8765 öffnen
```

Entwickler-Test gegen die echte API (Zugangsdaten nur als Umgebungsvariablen, nie in Dateien):

```bash
KB_EMAIL=... KB_PASS=... node scripts/smoke-test.mjs
```

## Veröffentlichen (z. B. GitHub Pages)

1. Diese Instanz ist nur für eine private Liga gedacht (Link nur privat teilen, `noindex`). Wer die App
   öffentlich für Dritte anbietet, braucht in Deutschland in der Regel ein Impressum mit echter,
   ladungsfähiger Anschrift.
2. Repository anlegen, Dateien hochladen, unter *Settings → Pages* den Branch `main` / Root wählen.
3. Die App ist dann unter `https://<nutzer>.github.io/<repo>/` erreichbar und auf dem Handy über
   „Zum Startbildschirm hinzufügen“ installierbar.

Alternativ: Netlify, Cloudflare Pages oder jeder andere statische Hoster. HTTPS ist Pflicht (Service Worker).

## Hinweise

- Die Kickbase-API ist inoffiziell und nicht dokumentiert. Sie kann sich jederzeit ändern. Die Nutzung
  kann gegen die AGB von Kickbase verstoßen; das Risiko liegt beim Betreiber bzw. Nutzer.
- Alle Empfehlungen sind Schätzungen ohne Gewähr.
