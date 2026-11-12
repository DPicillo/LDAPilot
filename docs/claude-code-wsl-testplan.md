# Testplan: Claude Code in WSL (Windows)

Manueller Durchlauf für den WSL-Modus der Claude-Code-Engine. Was ohne Windows geht, ist automatisch getestet (siehe „Was die automatischen Tests abdecken“ am Ende). Dieser Plan prüft den Rest auf einem echten Windows-Rechner.

Jeder Schritt hat ein erwartetes Ergebnis. Weicht etwas ab, bitte notieren: Schritt, Meldung im Chat bzw. in den Einstellungen (Text kopieren), Ausgabe von `wsl --version` und `wsl -l -v`.

## Vorbereitung

| # | Schritt | Erwartet |
|---|---|---|
| V1 | LDAPilot aus diesem Branch bauen (`scripts/build.sh` oder CI-Lauf „Run workflow“) und starten. | Startet wie gewohnt. |
| V2 | PowerShell: `wsl --version` und `wsl -l -v`. Werte notieren (WSL-Version, Standard-Distribution, WSL 1/2). | Mindestens eine Distribution, z. B. `* Ubuntu  Running  2`. |
| V3 | Sicherstellen, dass **kein** Claude Code für Windows gefunden wird (`where claude` in PowerShell findet nichts; sonst für die Tests vorübergehend umbenennen). | `where` meldet nichts. |
| V4 | In WSL (Terminal): Claude Code installieren und anmelden: `curl -fsSL https://claude.ai/install.sh \| bash`, dann `claude` starten, `/login`, beenden. Prüfen: `claude --version`, `claude -p "Sag Hallo"`. | Version wird angezeigt, `claude -p` antwortet. |
| V5 | In LDAPilot eine Testverbindung (Lab) mit AI-Zugriff „Ask“ bzw. „Read“; eine Testverbindung mit Schreibrecht für E. | — |

## A Grundfunktion (Automatik)

| # | Schritt | Erwartet |
|---|---|---|
| A1 | AI-Einstellungen → Engine **Claude Code**. | Unter dem Einleitungstext steht „Claude Code runs in: Automatic · Windows · WSL“ (Automatic gewählt) und „WSL distribution“ mit „Default distribution (Ubuntu)“ und den installierten Distributionen. |
| A2 | Einige Sekunden warten (die Modellabfrage läuft automatisch). | Zeile „Found in WSL 2 · Ubuntu: /home/<du>/.local/bin/claude (environment of the login shell)“; über der Modellliste „Claude Code 2.x.y“; Modellliste (Default, Opus, Sonnet, Haiku …), keine Warnung. |
| A3 | **Test** drücken. | „Claude Code 2.x.y answered in … ms with n models (checked without a model call).“ |
| A4 | Chat: „Wie viele Benutzer gibt es unter <OU>?“ (Testverbindung). | Werkzeugaufrufe (Zugriffskarte bei „Ask“, dann count/search) erscheinen, Antwort kommt. |
| A5 | Während A4 in PowerShell: `netstat -ano \| findstr LISTENING` und die PID von LDAPilot vergleichen. | LDAPilot lauscht nur auf `127.0.0.1:<port>`, auf keiner anderen Adresse. |
| A6 | Während A4 im Task-Manager (Details): Prozesse ansehen. | `wsl.exe` und ein zweites `LDAPilot.exe` (das Relay) laufen; beide verschwinden nach Ende der Antwort. |

## B Netzwerkmodus NAT und mirrored

| # | Schritt | Erwartet |
|---|---|---|
| B1 | NAT (Standard): `%UserProfile%\.wslconfig` ohne `networkingMode` oder mit `networkingMode=nat`. `wsl --shutdown`, dann A4 wiederholen. | Funktioniert wie A4. |
| B2 | Mirrored: in `%UserProfile%\.wslconfig` unter `[wsl2]` `networkingMode=mirrored` eintragen, `wsl --shutdown`, in LDAPilot „Refresh“ bei den Modellen, dann A4 wiederholen. | Funktioniert wie A4. |
| B3 | Nur wenn vorhanden: Distribution mit WSL 1 (`wsl --set-version <name> 1`) in den Einstellungen auswählen, A4 wiederholen. | „Found in WSL 1 · <name>: …“, Chat funktioniert. |
| B4 | Windows-Firewall: Es darf keine neue Regel für LDAPilot nötig sein (keine Nachfrage der Firewall beim ersten Lauf). | Keine Firewall-Abfrage. |

## C Kaltstart von WSL

| # | Schritt | Erwartet |
|---|---|---|
| C1 | `wsl --shutdown`, 10 s warten, in den AI-Einstellungen bei den Modellen **Refresh**. | Ladeanzeige, nach einigen Sekunden (bis ca. 1 Minute) „Found in WSL …“ und die Modellliste; **kein** Zeitüberschreitungsfehler. |
| C2 | LDAPilot beenden, `wsl --shutdown`, LDAPilot starten, AI-Chat öffnen und sofort eine Frage senden. | Antwort kommt (erste Antwort langsamer); keine Meldung „did not answer within …“. |
| C3 | Optional nach einem Neustart von Windows: als Erstes eine Chatfrage senden. | Wie C2. |

## D Stop

| # | Schritt | Erwartet |
|---|---|---|
| D1 | Frage, die mehrere Werkzeugaufrufe auslöst („Liste alle gesperrten Konten und ihre Gruppen“). Nach dem ersten Werkzeugaufruf **Stop**. | Lauf endet innerhalb von ca. 2 s als „gestoppt“, ohne Fehlerkarte. |
| D2 | Direkt nach D1 in WSL: `ps aux \| grep -i '[c]laude'`. | Kein Claude-Code-Prozess dieses Laufs mehr (eine offene interaktive `claude`-Sitzung von dir zählt nicht). |
| D3 | Nach D1 im Task-Manager: | Kein übrig gebliebenes `wsl.exe` und kein zweites `LDAPilot.exe`. |
| D4 | `wsl --shutdown`, Frage senden und **sofort** Stop drücken (Status „Contacting the AI provider…“). | Lauf endet sofort ohne Fehlerkarte. Eine zweite Frage kurz danach funktioniert (die Suche nach Claude Code lief im Hintergrund zu Ende). |
| D5 | Esc im Eingabefeld während eines laufenden Laufs. | Wie Stop. |

## E Freigabe, die lange wartet

| # | Schritt | Erwartet |
|---|---|---|
| E1 | Testverbindung mit Schreibrecht, Chat: „Setze die Beschreibung von <Testeintrag> auf ‚WSL-Test 1‘“. Freigabekarte erscheint. **2 Minuten warten**, dann freigeben. | Änderung wird ausgeführt (Eintrag neu laden: Beschreibung gesetzt), Audit-Log „via AI“, die Antwort läuft weiter. |
| E2 | Wie E1 mit „WSL-Test 2“, aber **6 Minuten** warten (länger als das 5-Minuten-Leerlauflimit von Claude Code), dann freigeben. | Wie E1: der Aufruf ist nicht abgebrochen. |
| E3 | Wie E1, aber ablehnen. | Karte „Not allowed“, das Modell sagt, dass die Änderung abgelehnt wurde; nichts geschrieben. |
| E4 | Optional: Freigabekarte über 10 Minuten offen lassen. | Die Karte läuft nach LDAPilots 10-Minuten-Regel ab; nichts geschrieben; keine hängenden Prozesse (Task-Manager). |

## F Erkennung und Auswahl

| # | Schritt | Erwartet |
|---|---|---|
| F1 | In WSL Claude Code über nvm installieren (nvm, `npm i -g @anthropic-ai/claude-code`), `~/.local/bin/claude` umbenennen. In LDAPilot Refresh. | „Found in WSL … : /home/<du>/.nvm/versions/node/v…/bin/claude (environment of the login shell)“; A4 funktioniert. Danach zurückbenennen. |
| F2 | „Claude Code runs in: WSL“, Feld „Claude Code path in WSL“ auf einen falschen Pfad (`/nope/claude`). | Fehler „Claude Code CLI not found in WSL (Ubuntu: /nope/claude is not an executable file) …“. Feld wieder leeren → gefunden. |
| F3 | Zweite Distribution (z. B. Debian) ohne Claude Code: in der Auswahl Debian wählen. | Fehler „… not found in WSL (Debian: no claude on the login shell's PATH, …)“ mit Installationshinweis. |
| F4 | Claude Code nur in der zweiten (nicht Standard-)Distribution, Laufort „Automatic“, Distribution „Default“. | Gefunden in der zweiten Distribution („Found in WSL · <name>“). |
| F5 | Zusätzlich Claude Code für Windows installieren (`irm https://claude.ai/install.ps1 \| iex`), Laufort „Automatic“, Refresh. | „Found in Windows: C:\Users\<du>\.local\bin\claude.exe“. Auf „WSL“ umstellen → wieder WSL. Auf „Windows“ → Windows. |
| F6 | Kein Claude Code irgendwo (Windows-Version und WSL-Version umbenennen), Automatic, Refresh. | Eine Meldung, die beide Orte nennt („Windows: not found … WSL: Ubuntu: no claude …“) und beide Installationswege („install.ps1“ / „install.sh“). |
| F7 | In der Distribution `/etc/wsl.conf` mit `[interop]` `enabled=false`, `wsl --shutdown`, Refresh. | Meldung „… found in WSL (Ubuntu) but cannot be used: Windows interop is disabled …“. Danach wieder entfernen. |
| F8 | Distributionsliste mit dem Knopf neben der Auswahl neu laden, während eine Distribution gestoppt ist. | Liste kommt sofort, ohne dass die gestoppte Distribution startet (`wsl -l -v` zeigt sie weiter als Stopped). |

## G Umgebung

| # | Schritt | Erwartet |
|---|---|---|
| G1 | Nur wenn du einen Proxy brauchst: Proxy in WSL in `~/.bashrc` (`export HTTPS_PROXY=…`). A4. | Funktioniert wie im Terminal. |
| G2 | Optional mit API-Schlüssel: `export ANTHROPIC_API_KEY=…` in WSL `~/.bashrc`, `claude` abmelden, Einstellung „Use my environment's Anthropic settings“ an, Refresh, A4. | Funktioniert; mit der Einstellung aus: Fehler (keine Anmeldung). |

## Was die automatischen Tests abdecken

Ohne Windows belegt (`go test ./...`, Node-Tests):

- Auswertung der `wsl.exe`-Ausgaben: UTF-16LE mit und ohne BOM, UTF-8, deutsche Spalten und Zustände, Meldungen statt Listen, „Error code“-Zeilen.
- Auswahl-Logik: Automatik (Windows zuerst, dann Standard- und weitere Distributionen, Docker Desktop nie), WSL fest, Windows fest, andere Systeme immer nativ, Meldungen bei „nicht gefunden“ und „gefunden, aber nicht nutzbar“.
- Probe: läuft in der echten Login-Shell (bash) mit einer `.bashrc` wie bei nvm, Ausweichorte, expliziter Pfad.
- Kommandobau: nur ein Skript auf der Windows-Kommandozeile, Quoting (auch leere Argumente, Leerzeichen, Anführungszeichen), keine Werte und kein Token auf der Kommandozeile, Variablen über `WSLENV`, Pfadumrechnung (Laufwerke, `\\?\`, UNC abgelehnt).
- Ende-zu-Ende mit einem nachgebauten `wsl.exe`: Lauf (Argumente, Umgebung, Dateien, MCP-Konfiguration ohne Token), Stop per `kill -s INT <pid>` in der „Distribution“, `--version` und Modellabfrage.
- Relay: echter MCP-Client über stdio → Relay → echter LDAPilot-Server (Werkzeugliste, parallele Aufrufe, Fortschrittsmeldungen, Abbruch, falscher Token, beendeter Server); und mit dem installierten Claude Code (Linux): die stdio-Konfiguration wird angenommen, `ldapilot` ist „connected“, nur `mcp__ldapilot__*`-Werkzeuge.
- Agent: Suche nach dem CLI erst nach `run_started`, Stop während der Suche ohne Fehlerkarte, Verwerfen der Suche nach einem Lauf ohne Antwort.

Erst durch diesen Durchlauf belegt: alles, was echtes Windows braucht — `wsl.exe` selbst (Argumentübergabe, `WSLENV`, `WSL_UTF8`, Kaltstart-Zeiten), der Start von LDAPilot.exe als Relay über die Interop (stdin/stdout eines GUI-Programms), NAT/mirrored/WSL 1, Stop und Aufräumen der Prozesse unter Windows, lange Freigaben über die Interop, die Einstellungen in der Windows-Oberfläche.
