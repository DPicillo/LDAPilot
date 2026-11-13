# LDAPilot: Installation pro Rechner, pro Benutzer und unbeaufsichtigt

**Datum**: 2026-11-12
**Status**: Konzept, fertig zur Entscheidung (Abschnitt 10). Alles ist belegt, geprüft oder als ungeprüft gekennzeichnet. **Etappe 1 ist umgesetzt** (13.11.2026, Plan `docs/plans/2026-11-13-installer-stage1-plan.md`); Abweichungen: den Programmnamen setzt `prgname_linux.go` vor dem GTK-Start, weil Wails' `ProgramName` für die X11-Fensterklasse zu spät kommt (4.8); die Linux-Pakete heißen in jedem Release gleich (`LDAPilot-linux-amd64.deb`, `.rpm`, `.el9.rpm`), damit die Installationsbefehle der README über `releases/latest/download/` immer die neueste Version holen; die Mutexe erlauben jedem Benutzer SYNCHRONIZE, sonst bekäme auf einem Terminalserver das LDAPilot des zweiten Benutzers keinen globalen Mutex (im Windows-VM nachgestellt).
**Art**: Konzept. Umgesetzt wird nichts davon, bevor David entschieden hat (Abschnitt 10).

Kennzeichnung in diesem Dokument:

- **geprüft**: ausprobiert, in Containern und unter Wine auf dieser Linux-Maschine oder in einer Windows-11-VM („Windows 11"); Protokoll in Anhang A.
- **belegt**: aus der aktuellen Dokumentation des Werkzeugs, Quelle in Anhang B.
- **ungeprüft**: braucht macOS, ein Verwaltungssystem (Intune, Configuration Manager, DSM) oder einen echten Desktop, oder ließ sich nicht belegen. Vor der Umsetzung nachzuholen.

## 0. Kurzfassung

**Heute**: Windows hat ein NSIS-Setup aus der Wails-Vorlage. Es läuft still, meldet aber in drei Fällen Erfolg, obwohl der Zustand nicht stimmt: Die WebView2-Laufzeit fehlt, das Programm läuft beim Update, oder die Deinstallation kehrt zurück, bevor sie fertig ist (Abschnitt 2). Pro Benutzer kann es nicht. Linux und macOS bekommen nur Dateien.

**Empfehlung**, nach der Praxis etablierter Programme (2.1):

- **Windows**: ein neues Setup mit **Inno Setup**, wie bei VS Code. Eine Datei für pro Rechner (`/ALLUSERS`) und pro Benutzer (`/CURRENTUSER`), still mit Protokoll, dokumentierten Rückgabecodes und fester Erkennungsregel (3.4, 3.5). Dazu für die Softwareverteilung ein **MSI** (WiX v7), nur pro Rechner (3.6). Die portable Datei bleibt. Beides ist auf **Windows 11 geprüft**: SYSTEM, Standardbenutzer, Umstieg von 0.5.0, laufendes Programm, WebView2 mit und ohne Internet (Anhang A.5).
- **Linux**: `.deb` und `.rpm` aus einer nfpm-Datei, eine Extra-Datei für RHEL 9, ein Archiv mit Installationsskript für `~/.local` (4.3 bis 4.6). Geprüft auf zwölf Distributionen. Damit das **Symbol in der Leiste** erscheint, braucht das Programm eine Zeile (`ProgramName`, 4.8). **Flathub** ist Davids Ziel und bekommt eine eigene Etappe (4.7).
- **macOS**: Alles hängt an einer **Apple Developer ID** mit Notarisierung (5.2). Danach `.dmg` und `.pkg` und ein eigener **Homebrew-Tap**; Homebrews Hauptkatalog erst, wenn das Projekt bekannt genug ist (5.4).

**Programmänderungen**, alle klein:

- Mutex lokal **und global**, damit Setups ein laufendes LDAPilot erkennen.
- Vollständige Versionsressource unter Windows.
- `ProgramName` unter Linux.
- Neuer Bundle-Identifier unter macOS (3.10, 4.8, 5.1).
- Optional: Vorgaben für Administratoren, etwa KI abschalten oder vorgegebene Verbindungen (Abschnitt 6).

**Reihenfolge** (Abschnitt 9):

1. Etappe 1: Setup und Linux-Pakete, unsigniert, 4 bis 5 Tage.
2. Windows-Signatur.
3. Etappe 2: MSI und winget, 2 bis 3 Tage.
4. macOS und Flathub, sobald ihre Voraussetzungen erfüllt sind.

**Was David wissen muss**:

- Ivanti DSM verliert am 31.12.2026 den Support (3.1).
- Flathub verlangt, KI-erzeugten Code offenzulegen, und erlaubt kein KI-geschriebenes Manifest und keine KI-erstellte Einreichung (4.7).
- Homebrews Hauptkatalog verlangt Notarisierung und bei eigener Einreichung 225 Sterne; heute sind es 22 (5.4).
- Die offenen Entscheidungen stehen in 10.2.

## 1. Auftrag und Zielbilder

Davids Auftrag: ein Konzept, wie LDAPilot „global am Rechner oder im User-Kontext" installiert wird, auch per Kommandozeile ohne Fenster für Softwareverteilungen („DSM …").

Daraus folgen vier Zielbilder. Jedes muss auf jeder Plattform eine Antwort haben, auch wenn sie „gibt es dort nicht" lautet.

| Zielbild | Wer installiert | Wohin | Rechte |
|---|---|---|---|
| A. Pro Rechner | Administrator von Hand oder die Softwareverteilung im Systemkonto | Programmverzeichnis des Systems, für alle Benutzer sichtbar | Administrator / root |
| B. Pro Benutzer | der Benutzer selbst | sein Profil | keine |
| C. Unbeaufsichtigt | Softwareverteilung, Skript, Konfigurationsverwaltung | wie A oder B | wie A oder B; kein Fenster, keine Rückfrage, Ergebnis nur über den Rückgabecode |
| D. Portabel | der Benutzer | irgendwo, nichts wird eingetragen | keine |

C ist kein eigenes Format, sondern eine Eigenschaft von A und B: Jedes Format, das hier empfohlen wird, muss ohne Fenster laufen und sein Ergebnis über den Rückgabecode melden.

Nicht Teil dieses Konzepts: wie Zertifikate beschafft und benutzt werden (das klärt der Arbeitsbereich `code-signing-research`; hier steht nur, an welchen Stellen signiert werden muss, Abschnitt 7) und eine Selbstaktualisierung des Programms.

## 2. Stand heute

Gelesen im Repository und an den Dateien des Release v0.5.0 nachgeprüft (heruntergeladen in ein temporäres Verzeichnis, `SHA256SUMS.txt` stimmt).

| Plattform | Datei im Release | Größe | Was es ist |
|---|---|---|---|
| Windows | `LDAPilot-windows-amd64-installer.exe` | 14,3 MB | NSIS-Setup aus der unveränderten Wails-Vorlage |
| Windows | `LDAPilot-windows-amd64.exe` | 42,2 MB | portable Programmdatei |
| Linux | `LDAPilot-linux-amd64` | 40,4 MB | Programmdatei für WebKitGTK 4.0 |
| Linux | `LDAPilot-linux-amd64-webkit2_41` | 40,4 MB | Programmdatei für WebKitGTK 4.1 |
| macOS | `LDAPilot-macos-universal.zip` | 23,3 MB | gezippte `.app` (universal, 78,7 MB entpackt), ad hoc signiert, nicht notarisiert |

Davids „aktuell haben wir ja nur Executables" stimmt also für Linux und macOS. Für Windows gibt es bereits ein Setup, nur kann es von den vier Zielbildern allein A, und das nur mit Assistent.

**Windows-Setup** (`build/windows/installer/project.nsi`, `wails_tools.nsh`):

- Ausführungsstufe `admin`, Ziel `$PROGRAMFILES64\David Picillo\LDAPilot`, Deinstallationsschlüssel `HKLM\Software\Microsoft\Windows\CurrentVersion\Uninstall\David PicilloLDAPilot` (Firmenname und Produktname ohne Trenner aneinandergehängt, mit Leerzeichen).
- Startmenü- und Desktop-Verknüpfung werden immer angelegt, nicht abschaltbar.
- Fehlt die WebView2-Laufzeit, startet das Setup Microsofts Online-Bootstrapper (`MicrosoftEdgeWebview2Setup.exe /silent /install`). Dessen Rückgabecode wird nicht ausgewertet.
- Kein Modus pro Benutzer, kein MSI, keine Prüfung auf ein laufendes Programm, kein Protokoll, nicht signiert.
- Die Programmdatei trägt die Dateiversion `0.5.0.0` im festen Versionsblock, aber keine Zeichenkette `FileVersion` und die feste Produktversion `0.0.0.0`; das Setup trägt beides richtig.

**Das heutige Setup mit `/S`** (geprüft unter Wine 10.0 ohne Netz, Protokoll in Anhang A.2; Wine ist kein Windows, die Abläufe folgen aber aus dem Skript des Setups):

| Fall | Ergebnis | Bewertung |
|---|---|---|
| `setup.exe /S`, WebView2 vorhanden | installiert in unter einer Sekunde, Rückgabecode 0 | läuft |
| `setup.exe /S /D=C:\Tools\LDAPilot` | installiert dorthin, Rückgabecode 0 | läuft |
| `setup.exe /S`, WebView2 fehlt, kein Internet | wartet 88 Sekunden auf den Bootstrapper, installiert dann LDAPilot, **Rückgabecode 0**, WebView2 fehlt weiter | Die Verteilung meldet Erfolg für ein Programm, das nicht startet |
| `setup.exe /S`, während LDAPilot läuft | **Rückgabecode 0, die Programmdatei wird nicht ersetzt** | Die Verteilung meldet die neue Version, auf der Platte liegt die alte; der Deinstallationsschlüssel nennt schon die neue |
| `uninstall.exe /S` | kehrt nach 0,1 Sekunden mit 0 zurück, die Dateien sind dann noch da und verschwinden erst danach | Eine Verteilung, die sofort prüft oder gleich die neue Version installiert, läuft in die halbe Deinstallation |
| `uninstall.exe /S`, während LDAPilot läuft | Rückgabecode 0, Schlüssel und Verknüpfungen weg, Programmdatei bleibt | gilt als deinstalliert, liegt aber noch da |
| Deinstallation eines Ordners, in dem fremde Dateien liegen | alles im Ordner wird gelöscht (`RMDir /r $INSTDIR`) | gefährlich mit `/D=` auf einen gemeinsamen Ordner |
| WebView2-Daten des Benutzers | bleiben liegen: Das Skript löscht `$AppData\LDAPilot.exe`, was bei rechnerweiter Installation `C:\ProgramData\LDAPilot.exe` ist, nicht `%APPDATA%\LDAPilot.exe` | harmlos, aber falsch |
| Konfiguration `%APPDATA%\LDAPilot` | bleibt bei der Deinstallation erhalten | richtig so |

Das Setup ist also still bedienbar, aber für eine Softwareverteilung nicht verlässlich: In drei Fällen meldet es Erfolg, ohne dass der Zustand stimmt. Einen Wert `InstallLocation` schreibt es nicht in den Deinstallationsschlüssel.

**Linux**: zwei nackte Programmdateien, kein Paket, kein Desktop-Eintrag, kein Symbol im System, keine AppStream-Daten. Was die beiden Dateien wirklich brauchen und wo sie laufen, steht in Abschnitt 4.1 (geprüft).

**macOS**: gezippte `.app`; die Release-Notiz schickt Benutzer über Rechtsklick → Öffnen.

**Konfiguration**: pro Benutzer unter `os.UserConfigDir()/LDAPilot` (`internal/config/paths.go`), also `%APPDATA%\LDAPilot`, `~/Library/Application Support/LDAPilot`, `~/.config/LDAPilot`. Dort liegt auch der Schlüssel für die verschlüsselten Passwörter. Beim ersten Start entstehen `key`, `ui_state.json` und `chats/` (geprüft im Container). Eine rechnerweite Konfiguration gibt es nicht.

**Update-Prüfung**: keine. Eine Suche im Go- und Frontend-Code nach Update-Prüfung, Release-Abfrage oder Selbstaktualisierung findet nichts. Für die Softwareverteilung ist das gut: Das Programm meldet sich nirgends und ändert sich nicht selbst; die Version auf dem Rechner ist die, die verteilt wurde.

**Versionsangaben**: `wails.json` trägt Produktname, Firma („David Picillo") und `productVersion` (0.5.0); `scripts/build.sh` stempelt Version, Commit und Datum in die Programmdatei.

### 2.1 Vorbilder: wie es etablierte Programme machen

David will, dass das Konzept der üblichen Praxis folgt und bei anderen abschaut. Dort, wo dieses Dokument eine Wahl trifft, steht deshalb, wer es genauso macht.

| Programm | Windows | Linux | macOS |
|---|---|---|---|
| **VS Code** ([V1]) | **Inno Setup**, als Benutzer-Setup (empfohlen, `%LOCALAPPDATA%\Programs\Microsoft VS Code`, ohne Administratorrechte) und System-Setup (`C:\Program Files\…`), dazu ein ZIP; „All Inno Setup command-line switches are available", Aufgaben abschaltbar mit `/mergetasks=!runcode` | `.deb` und `.rpm`, eigene apt- und dnf-Paketquelle mit signierten Metadaten (`Signed-By`, `gpgcheck=1`), Snap; Arch und Nix von der Gemeinschaft | (nicht nachgesehen) |
| **KeePassXC** ([V2]) | **MSI**, signiert, mit Eigenschaften für die unbeaufsichtigte Installation (`msiexec /q /i KeePassXC-….msi AUTOSTARTPROGRAM=0`), dazu eine portable Fassung | AppImage, Snap, Flatpak, Pakete der Distributionen | DMG, Homebrew Cask |
| **Obsidian**, **Bitwarden** ([W17]) | **ein** NSIS-Setup mit den Schaltern `/currentuser` und `/allusers`; im winget-Manifest zwei Einträge auf dieselbe Datei | (nicht nachgesehen) | (nicht nachgesehen) |

Das Konzept übernimmt daraus: Inno Setup mit denselben Zielordnern wie VS Code, Aufgaben für die Verknüpfungen, ein MSI mit Eigenschaften wie KeePassXC für die Softwareverteilung, eine portable Fassung, unter Linux `.deb` und `.rpm` und später eine signierte Paketquelle wie VS Code. Anders als VS Code ist es *ein* Setup für beide Modi, wie bei Obsidian und Bitwarden: eine Datei weniger, und Inno Setup kann es von Haus aus (3.4). VS Code trennt die beiden Setups wohl auch wegen seiner eingebauten Aktualisierung, die LDAPilot nicht hat.

## 3. Windows

### 3.1 Was die Softwareverteilung von einem Setup braucht

Ivanti DSM, Configuration Manager (SCCM/MECM), Intune und winget verlangen dasselbe (belegt, [W14]–[W17]):

1. **Stille Installation und stille Deinstallation** per Kommandozeile, die erst zurückkehren, wenn die Arbeit getan ist.
2. **Dokumentierte Rückgabecodes.** Configuration Manager und Intune werten 0 und 1707 als Erfolg, 3010 als „Neustart später", 1641 als „Neustart ausgelöst" und 1618 als „später wiederholen"; jeder andere Code ist ein Fehler, weitere lassen sich eintragen. DSM hat keine solche Tabelle: Der Paketierer startet das Setup im eScript mit `ExecuteEx` oder `RunAsEx`, liest den Code aus einer Variablen („Variable name for return code") und meldet das Paket mit `ExitProcEx` selbst als erfolgreich oder gescheitert.
3. **Ein Merkmal „installiert, Version x"**: MSI-Produktcode, Deinstallationsschlüssel mit `DisplayVersion` oder die Dateiversion der Programmdatei.
4. **Rechnerweite Installation ohne angemeldeten Benutzer** unter einem Dienstkonto: SYSTEM bei Configuration Manager und Intune, bei DSM ein eingerichtetes Konto mit lokalen Administratorrechten („The DSM Runtime Service logs into the system under an account with administrative rights"). Die Installation darf deshalb nichts in `HKCU` oder ein Benutzerprofil schreiben.

LDAPilot ist dafür ein dankbarer Fall: eine Datei, kein Dienst, kein Treiber, keine Dateizuordnung, und die Konfiguration legt das Programm beim ersten Start selbst an. Ein „Benutzerteil" im Paket ist nie nötig.

**Ivanti DSM endet.** Ivanti stellt den Support am 31.12.2026 ein, also in sieben Wochen: „Ivanti DSM will no longer be supported after 31st December 2026." (Datenblatt IVI-2819, [W14]); als Nachfolger nennt Ivanti „Ivanti Neurons". Das Konzept baut deshalb nichts DSM-Eigenes, sondern liefert die allgemeinen Angaben, die jedes dieser Systeme braucht. Ob Davids Umfeld gerade migriert, ist eine Frage an ihn (Abschnitt 10).

### 3.2 Die Formate im Vergleich

| | NSIS heute (Wails-Vorlage) | NSIS erweitert | **Inno Setup** | MSI (WiX v7) | MSIX |
|---|---|---|---|---|---|
| Pro Rechner / pro Benutzer | nur pro Rechner; seit Wails 2.13 `-installscope user` als zweites, getrenntes Setup | beides über `MultiUser.nsh` (fordert keine Rechte nach; seine Fehlermeldung hat kein `/SD` und erscheint auch bei `/S`) oder das Drittanbieter-Plugin NsisMultiUser (ohne Releases, bringt ein UAC-Plugin mit) | **eingebaut**: `PrivilegesRequired=lowest` mit `PrivilegesRequiredOverridesAllowed=dialog commandline`, Schalter `/ALLUSERS` und `/CURRENTUSER`, merkt sich den Modus einer vorhandenen Installation | beides in einem Paket möglich (`ALLUSERS=2`, `MSIINSTALLPERUSER`), Standard pro Rechner | immer pro Benutzer; rechnerweit nur als Provisionierung |
| Still | `/S`, meldet in drei Fällen Erfolg ohne richtigen Zustand (geprüft, Abschnitt 2) | `/S`, jede Absicherung selbst geschrieben | `/VERYSILENT /SUPPRESSMSGBOXES`, Rückfragen bekommen dokumentierte Standardantworten | `/qn` | kein Setup-Programm; `Add-AppxPackage`, DISM |
| Rückgabecodes | 0, 1, 2 | dazu eigene über `SetErrorLevel` | 0–8 dokumentiert | Windows-Installer-Codes, die jede Verteilung kennt | PowerShell-Fehler |
| Protokoll | keins | nur mit Sonderbuild von NSIS oder selbst geschrieben | `/LOG="datei"` | `/l*v "datei"` | Ereignisprotokoll |
| Deinstallation wartet | nein (nur mit `_?=`, dann bleibt das Deinstallationsprogramm liegen) | wie links | **ja** (Windows 11) | ja (Windows 11) | ja |
| Programm läuft beim Update | Erfolg gemeldet, alte Datei bleibt (geprüft) | selbst zu bauen | Abbruch mit Code 5 ohne Änderung, mit Mutex-Prüfung Code 7 (Windows 11) | Code 0, Datei ersetzt, das laufende Programm läuft bis zum Neustart weiter (Windows 11) | Windows wartet |
| Erkennung | Deinstallationsschlüssel | Deinstallationsschlüssel | Deinstallationsschlüssel mit fester ID | Produktcode, nativ | Paketname |
| Bau in der CI | `makensis` | `makensis` | `ISCC.exe`, auf GitHubs Windows-Abbildern vorinstalliert, läuft auch unter Wine (geprüft) | WiX als .NET-Werkzeug, nur unter Windows | `MakeAppx`, Signatur Pflicht |
| Kosten, Lizenz | frei | frei | frei; kommerzielle Nutzer werden *gebeten*, eine Lizenz zu kaufen, nicht verpflichtet | frei für LDAPilot (Wartungsgebühr erst ab 10.000 USD Jahresumsatz), Bau verlangt `-acceptEula wix7` | Zertifikat oder Microsoft Store |
| Unsigniert installierbar | ja | ja | ja | ja | **nein** |
| winget-Typ | `nullsoft` (keine Rückgabecodes hinterlegt) | `nullsoft` | `inno` (Schalter und Codes 2, 5, 8 hinterlegt) | `msi`/`wix` | `msix` |

Belege: NSIS [W1]–[W4], Inno Setup [W6]–[W9], MSI [W10]–[W11], MSIX [W12], winget [W17].

### 3.3 Empfehlung

1. **Ein neues Setup mit Inno Setup ersetzt die Wails-NSIS-Vorlage** und deckt pro Rechner, pro Benutzer und unbeaufsichtigt in *einer* Datei ab. Alles, was Abschnitt 3.1 verlangt, ist dort eingebaut und dokumentiert; mit NSIS müsste man es selbst schreiben und selbst testen: Moduswahl über ein Drittanbieter-Plugin, Protokoll, wartende Deinstallation, Prüfung, ob die Datei wirklich ersetzt wurde. Wails trägt zum NSIS-Setup wenig bei: Es ruft `makensis` mit dem Pfad der Programmdatei auf, und `project.nsi` wird nach dem ersten Anlegen nie mehr erneuert ([W4]). Ein Prototyp ist unter Wine gebaut und auf Windows 11 durchgeprüft (Anhang A.3, A.5, C).
2. **Zusätzlich ein MSI, nur pro Rechner, für die Softwareverteilung** (zweite Etappe). DSM importiert ein MSI als eigenen Pakettyp, Intune nimmt es ohne Verpackung als „line-of-business app", Configuration Manager und Intune erkennen es am Produktcode, und jeder Administrator kennt `msiexec`. Aufwand: etwa 40 Zeilen WiX und ein Bauschritt auf dem Windows-Runner, der ohnehin läuft.
3. **Die portable Programmdatei bleibt.**
4. **Nicht empfohlen:**
   - *MSIX*: nicht ohne Signatur installierbar; neue Dateien unter `%APPDATA%\LDAPilot` landen in einem paketeigenen Speicher und werden bei der Deinstallation gelöscht („as well as any redirected writes to AppData", [W12]); dort liegen Verbindungsprofile und der Schlüssel der gespeicherten Passwörter. Wails v2 hat dafür kein Werkzeug.
   - *Die NSIS-Vorlage erweitern*: aus den Gründen unter 1.
   - *Auf Wails v3 warten*: v3 ist seit 26.10.2026 stabil und bringt für Windows NSIS und MSIX mit, aber seine NSIS-Vorlage hat dieselben Schwächen (Verknüpfungen immer, `RMDir /r $INSTDIR`, keine Prüfung auf ein laufendes Programm), und der Umstieg ist eine Portierung des Programms („a real port rather than a version bump", [W5]).

### 3.4 Das Setup im Detail (Inno Setup)

**Kennungen** (Vorschlag; sie gelten ab der ersten Veröffentlichung und ändern sich danach nie):

| Was | Wert |
|---|---|
| `AppId` | `{2216036E-00F6-49B8-9C8F-D331676AFF43}` |
| Deinstallationsschlüssel | `Software\Microsoft\Windows\CurrentVersion\Uninstall\{2216036E-00F6-49B8-9C8F-D331676AFF43}_is1` unter `HKLM` (pro Rechner, 64-Bit-Ansicht) oder `HKCU` (pro Benutzer) |
| Ziel pro Rechner | `C:\Program Files\LDAPilot` (`{autopf}`; der Firmenordner „David Picillo" entfällt) |
| Ziel pro Benutzer | `%LOCALAPPDATA%\Programs\LDAPilot` (Windows' Ordner für Programme pro Benutzer, `FOLDERID_UserProgramFiles`) |
| Programmdatei | `LDAPilot.exe` (der Name muss bleiben, siehe 3.10) |
| Version | `info.productVersion` aus `wails.json`, auch in der Versionsressource des Setups |

**Moduswahl.** Interaktiv fragt das Setup „für alle Benutzer" oder „nur für mich"; vorgeschlagen ist „nur für mich", damit jeder ohne Administratorrechte installieren kann. Still entscheidet der Schalter: `/ALLUSERS` pro Rechner, `/CURRENTUSER` pro Benutzer. Ohne Schalter nimmt das Setup den Modus einer vorhandenen Installation (`UsePreviousPrivileges`, geprüft), sonst pro Benutzer. Die Softwareverteilung gibt den Schalter deshalb immer an. `/ALLUSERS` als Standardbenutzer endet still mit Code 1 („You must be logged in as an administrator when installing this program."), ohne an einer Rechteabfrage hängen zu bleiben (Windows 11). Als SYSTEM über eine geplante Aufgabe gestartet, wie es Verteilagenten tun, installiert `/ALLUSERS` mit Code 0 und legt nur Verknüpfungen für alle Benutzer an (Windows 11).

**Parameter:**

| Parameter | Wirkung |
|---|---|
| `/VERYSILENT /SUPPRESSMSGBOXES /NORESTART` | kein Fenster; Rückfragen bekommen die dokumentierte Standardantwort (bei „Abbrechen/Wiederholen" Abbrechen); kein Neustart |
| `/ALLUSERS`, `/CURRENTUSER` | Installationsmodus |
| `/LOG="C:\Pfad\datei.log"` | Protokoll an diesen Ort (der Ordner muss existieren); `/LOG` allein schreibt nach `%TEMP%` |
| `/DIR="x:\Pfad"` | anderer Zielordner |
| `/MERGETASKS="desktopicon"` | zusätzlich eine Desktop-Verknüpfung (Vorschlag: standardmäßig aus) |
| `/MERGETASKS="!startmenuicon"` | keine Startmenü-Verknüpfung |
| `/WEBVIEW2=nodownload` | fehlt die WebView2-Laufzeit, nicht herunterladen, sondern gleich mit Code 7 abbrechen (für Netze ohne Internet) |
| `/WEBVIEW2=ignore` | auch ohne Laufzeit installieren (sie kommt über ein eigenes Paket) |

`/WEBVIEW2` ist ein eigener Parameter des Skripts (`{param:WEBVIEW2}`), die übrigen sind Inno-Standard ([W6]).

**Rückgabecodes** (Inno-Standard, [W6]; Spalte rechts: was er bei LDAPilot bedeutet):

| Code | Inno | Bei LDAPilot |
|---|---|---|
| 0 | vollständig durchgelaufen | installiert |
| 1 | Setup konnte nicht starten | z. B. Windows älter als 10, falsche Architektur, `/ALLUSERS` ohne Administratorrechte (Windows 11) |
| 2 | vor Beginn abgebrochen | nur interaktiv |
| 3, 4 | schwerer Fehler | Plattenplatz, Rechte, Fehler beim Schreiben |
| 5 | während der Installation abgebrochen, auch „Datei ließ sich nicht ersetzen" im stillen Modus | Programmdatei gesperrt, nichts verändert (geprüft) |
| 7 | „Preparing to Install" hat abgebrochen | LDAPilot läuft, die WebView2-Laufzeit fehlt, oder eine andere Installationsart ist schon da; der Grund steht im Protokoll (geprüft) |
| 8 | wie 7, Neustart nötig | kommt bei LDAPilot nicht vor |

Inno vergibt die Codes selbst; eigene Codes für die einzelnen Gründe von 7 gibt es nicht. Einen Neustart braucht LDAPilot nie, Code 3010 entsteht also nicht. Inno: „Any non-zero exit code indicates that Setup was not run to completion."

**Deinstallation**: `unins000.exe` im Programmordner mit `/VERYSILENT /SUPPRESSMSGBOXES /NORESTART`, optional `/LOG="…"`. Der Aufruf kehrt zurück, wenn die Dateien entfernt sind (geprüft: 0,2 s, Programmdatei danach weg); laut Dokumentation läuft danach nur noch das Löschen der temporären Kopie des Deinstallationsprogramms. Sie entfernt nur, was das Setup angelegt hat; fremde Dateien im Ordner bleiben (geprüft), anders als bei `RMDir /r` der heutigen Vorlage. Code ungleich 0 heißt gescheitert. Der Schlüssel trägt `QuietUninstallString` mit `/SILENT` (zeigt einen Fortschrittsbalken); die Verteilung nimmt besser `/VERYSILENT`. Auf Windows 11 ließ sich in einem von drei Durchläufen die Programmdatei kurz nach einer Installation nicht löschen („Failed to delete the file; it may be in use (5)"), obwohl kein LDAPilot lief; Code trotzdem 0, Schlüssel weg. Vermutlich prüfte der Virenscanner die frisch geschriebene, unsignierte Datei noch (nicht belegt). Vorschlag: `uninsrestartdelete` an der Programmdatei, damit Windows sie in diesem Fall beim nächsten Start löscht.

**Erkennungsregel:**

- *Pro Rechner*: Registry `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{2216036E-00F6-49B8-9C8F-D331676AFF43}_is1`, Wert `DisplayVersion` (REG_SZ, z. B. `0.6.0`), Vergleich als Version „größer oder gleich". Der Schlüssel liegt in der 64-Bit-Ansicht, also nicht unter `WOW6432Node`; in Configuration Manager und Intune bleibt „32-Bit-Anwendung auf 64-Bit-Systemen" ausgeschaltet.
- *Pro Benutzer*: derselbe Schlüssel unter `HKCU`.
- Das Setup schreibt dort (geprüft): `DisplayName`, `DisplayVersion`, `Publisher`, `InstallLocation`, `InstallDate`, `UninstallString`, `QuietUninstallString`, `DisplayIcon`, `EstimatedSize`, `MajorVersion`/`MinorVersion`, `NoModify`, `NoRepair`, `URLInfoAbout`.
- Eine Regel über die Dateiversion von `LDAPilot.exe` geht erst, wenn die Versionsressource der Programmdatei vollständig ist (3.10).

**Laufendes Programm.** Heute meldet das Setup Erfolg und lässt die alte Datei liegen (Abschnitt 2). Vorschlag, auf Windows 11 geprüft (Anhang A.5):

- LDAPilot legt beim Start unter Windows einen benannten Mutex an, `LDAPilot.Running` und `Global\LDAPilot.Running` (Programmänderung, 3.10). **Die globale Variante ist Pflicht**: Ein Mutex, den das Programm nur in der Sitzung des Benutzers anlegt, sieht ein Setup in Sitzung 0 (Softwareverteilung, SSH, Dienst) nicht; Update und Deinstallation liefen dann durch, als liefe nichts (Windows 11). Ein normaler Benutzerprozess darf den globalen Mutex anlegen (Windows 11). Inno nennt beide Formen in seinem Beispiel ([W6], `AppMutex`).
- Mit beiden Mutexen bricht das Setup vor dem ersten Kopieren mit **7** ab und die Deinstallation beim Start mit **1**, ohne etwas zu verändern (Windows 11).
- Ohne die Programmänderung bricht das Update mit 5 ab, ohne etwas zu verändern (Windows 11, wie unter Wine); die Deinstallation dagegen meldet 0, entfernt Schlüssel und Verknüpfungen und lässt die gesperrte Programmdatei liegen (Wine). Deshalb gehört der Mutex dazu.
- **Automatisch schließen hilft der Softwareverteilung nicht**: Mit `/CLOSEAPPLICATIONS` findet der Restart Manager das laufende LDAPilot, darf es aber nicht schließen, weil Setup und Programm in verschiedenen Sitzungen laufen („Can use RestartManager to avoid reboot? No (2: Session Mismatch)", Windows 11). Startet der Benutzer das Setup in seiner eigenen Sitzung, schließt der Restart Manager LDAPilot sauber in gut zwei Sekunden, und das Update läuft durch (Windows 11, ohne offene Änderungen; mit offenen Änderungen ungeprüft). Daher: `CloseApplications=no` als Standard, `/CLOSEAPPLICATIONS` als dokumentierte Möglichkeit für Updates aus der Sitzung des Benutzers; das interaktive Setup bietet das Schließen ohnehin selbst an.

**Neustart**: nie nötig. `/NORESTART` trotzdem mitgeben, das ist die Gewohnheit aller Verteilungen.

**WebView2-Laufzeit** (Hintergrund in 3.7):

- Das Setup prüft den Wert `pv` unter `HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}` und unter `HKCU\Software\Microsoft\EdgeUpdate\Clients\{F3017226-…}`. Fehlt er, ist er leer oder `0.0.0.0`, gilt die Laufzeit als nicht installiert (Microsofts Regel, [W13]; die heutige Vorlage prüft nur auf „leer" und im Administratormodus nur `HKLM`).
- Fehlt die Laufzeit, startet das Setup den mitgelieferten Bootstrapper (`MicrosoftEdgeWebview2Setup.exe /silent /install`, etwa 2 MB, lädt aus dem Internet; mit Administratorrechten rechnerweit, sonst pro Benutzer) und prüft danach den Registry-Wert erneut. Auf den Rückgabecode des Bootstrappers verlässt es sich nicht, Microsoft dokumentiert keinen.
- Fehlt sie dann immer noch, endet das Setup mit **7**, und das Protokoll nennt den Grund und den Offline-Installer. `/WEBVIEW2=nodownload` überspringt den Download, `/WEBVIEW2=ignore` installiert trotzdem.
- Auf Windows 11 geprüft, mit der Laufzeit als fehlend markiert (`pv = 0.0.0.0`): `nodownload` Code 7 nach 2 s; `ignore` Code 0; ohne Internet (Firewall sperrt 80 und 443) meldet der Bootstrapper nach 23 s `-2147012867` (`0x80072EFD`, keine Verbindung), das Setup endet mit 7; mit Internet installiert der Bootstrapper in 40 s (Code 0), danach ist `pv` wieder gesetzt und das Setup läuft mit 0 durch. Der aktuelle Bootstrapper (Version 1.3.315.17, 1,9 MB) kam beim Bau über Microsofts festen Link.

**Beides installiert.** Inno lässt eine Installation pro Rechner und eine pro Benutzer nebeneinander zu (geprüft: zwei Schlüssel, zwei Startmenü-Einträge „LDAPilot"). Daten teilen sich beide ohnehin, weil die Konfiguration pro Benutzer unter `%APPDATA%\LDAPilot` liegt; lästig sind nur zwei Einträge und womöglich zwei Versionen. Vorschlag: Das Setup im Benutzermodus bricht mit 7 ab, wenn eine rechnerweite Installation existiert, denn die ist die verwaltete („LDAPilot is already installed for all users of this computer.", Windows 11). Umgekehrt kann eine Installation unter SYSTEM die Benutzerinstallationen anderer Konten nicht sehen; die bleiben stehen und funktionieren weiter (Windows 11: rechnerweite Installation neben einer bestehenden pro Benutzer, Code 0). Das kommt in die Anleitung für Administratoren.

**Pro Benutzer auf Windows 11** (Standardbenutzer ohne Administratorrechte): `/CURRENTUSER` installiert in 3 s nach `C:\Users\<name>\AppData\Local\Programs\LDAPilot`, Schlüssel unter HKCU mit `InstallLocation`, Startmenü-Verknüpfung im Profil; das Update auf 0.5.1 und die Deinstallation laufen ebenso still mit Code 0.

**Umstieg von 0.5.0.** Das alte NSIS-Setup liegt unter `C:\Program Files\David Picillo\LDAPilot` mit dem Schlüssel `HKLM\…\Uninstall\David PicilloLDAPilot`. Das neue Setup entfernt es im Rechnermodus vor der Installation still: `"…\uninstall.exe" /S _?=C:\Program Files\David Picillo\LDAPilot` (mit `_?=` wartet der Aufruf, geprüft), danach `uninstall.exe` und die leeren Ordner. Im Benutzermodus fehlen dafür die Rechte; dann steht ein Hinweis im Protokoll. Die Konfiguration bleibt, sie liegt im selben Ordner wie bisher. Auf Windows 11 geprüft: v0.5.0 mit `/S` installiert, dann das neue Setup mit `/ALLUSERS`: Code 0, altes Setup samt Ordner `David Picillo`, Schlüssel und Desktop-Verknüpfung entfernt, neues installiert.

**Deinstallation und Benutzerdaten.** Entfernt werden Programmdatei, Verknüpfungen und Schlüssel. `%APPDATA%\LDAPilot` (Verbindungsprofile, Schlüssel, Chats, Audit-Protokoll) und die WebView2-Daten bleiben. Das ist für Verbindungsdaten richtig, und unter SYSTEM ginge es auch nicht anders, denn fremde Profile erreicht die Deinstallation nicht.

### 3.5 Kommandozeilen zum Kopieren (Setup)

```bat
:: Installation pro Rechner (Softwareverteilung, Administrator, SYSTEM)
LDAPilot-windows-amd64-installer.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /ALLUSERS /LOG="C:\Windows\Temp\LDAPilot-install.log"

:: dasselbe ohne Internet, mit Desktop-Verknüpfung
LDAPilot-windows-amd64-installer.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /ALLUSERS /WEBVIEW2=nodownload /MERGETASKS="desktopicon" /LOG="C:\Windows\Temp\LDAPilot-install.log"

:: Installation pro Benutzer (ohne Administratorrechte)
LDAPilot-windows-amd64-installer.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /CURRENTUSER /LOG="%TEMP%\LDAPilot-install.log"

:: Aktualisierung: derselbe Aufruf mit der neuen Datei

:: Deinstallation pro Rechner
"C:\Program Files\LDAPilot\unins000.exe" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /LOG="C:\Windows\Temp\LDAPilot-uninstall.log"

:: Deinstallation pro Benutzer
"%LOCALAPPDATA%\Programs\LDAPilot\unins000.exe" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART
```

Den Dateinamen `LDAPilot-windows-amd64-installer.exe` behält das neue Setup, damit Verweise auf die bisherige Datei weiter stimmen (Abschnitt 8). Intune setzt im Deinstallationsbefehl keine Umgebungsvariablen ein; für die Variante pro Benutzer braucht es dort ein kleines Skript ([W16]).

### 3.6 MSI (zweite Etappe)

**Werkzeug**: WiX v7 (aktuell 7.0.1 vom 26.10.2026; v6 bekommt Sicherheitskorrekturen bis 05.02.2027, ältere keine mehr). Es läuft als .NET-Werkzeug und nur unter Windows; eine Linux-Fassung ist nicht vor WiX v9 zu erwarten ([W10]). Andere Wege zum MSI (go-msi, msitools `wixl`, PSMSI) beruhen auf dem ausgelaufenen WiX v3 oder decken nur einen Teil davon ab; `wixl` kann unter Linux nicht validieren.

**Wartungsgebühr (Open Source Maintenance Fee)**: Sie gilt für die fertigen WiX-Programme, nicht für den Quelltext und nicht für die Empfänger des MSI. Für v7: „The Fee applies only to Users that use the Software as part of revenue-generating activities and have an annual gross revenue greater than or equal to US$10,000." ([W10], `OSMFEULA.txt`). LDAPilot ist davon befreit, solange das Projekt keinen solchen Umsatz macht. Der Bau muss die Lizenz trotzdem ausdrücklich annehmen (`-acceptEula wix7`), sonst bricht er ab. Keine rechtliche Beratung, sondern die Lesart des zitierten Textes.

**Zuschnitt**: nur pro Rechner (`Scope="perMachine"`), x64, eingebettetes CAB, eine Komponente für `LDAPilot.exe`, Startmenü-Verknüpfung, Desktop-Verknüpfung über eine Eigenschaft. Pro Benutzer bleibt Aufgabe des Setups. Ein MSI für beide Modi wäre möglich (`perMachineOrUser`, neu in WiX v7), aber das MSI ist für die Softwareverteilung da, und die installiert pro Rechner.

**Kennungen** (Vorschlag, gilt ab der ersten Veröffentlichung):

| Was | Regel | Wert |
|---|---|---|
| UpgradeCode | nie ändern | `{47D44C40-C3AA-40A0-8C62-27CD33B9CF77}` |
| ProductCode | neu bei jedem Bau (WiX-Standard), steht in den Release-Notizen | — |
| ProductVersion | drei Felder, höchstens 255.255.65535; ein viertes Feld zählt nicht; keine Vorabversionen wie `0.6.0-rc.1` | `info.productVersion` |
| Upgrade | `MajorUpgrade`, Schedule `afterInstallInitialize` (bei Fehler bleibt die alte Version), Downgrade gesperrt | — |

Microsoft: „Windows Installer uses only the first three fields of the product version." ([W11]). Zwei verschiedene MSIs mit derselben dreistelligen Version darf es deshalb nie geben.

**Kommandozeilen** ([W11]):

```bat
:: Installation und Aktualisierung (die neue Version ersetzt die alte)
msiexec /i LDAPilot-windows-amd64.msi /qn /norestart /l*v "C:\Windows\Temp\LDAPilot-msi.log"

:: mit Desktop-Verknüpfung
msiexec /i LDAPilot-windows-amd64.msi DESKTOPSHORTCUT=1 /qn /norestart /l*v "C:\Windows\Temp\LDAPilot-msi.log"

:: Deinstallation über die Datei oder den Produktcode der installierten Version
msiexec /x LDAPilot-windows-amd64.msi /qn /norestart
msiexec /x {PRODUKTCODE} /qn /norestart /l*v "C:\Windows\Temp\LDAPilot-msi-uninstall.log"
```

`/norestart` ist Pflicht: „If no reboot option is specified, the installer restarts the computer whenever necessary without displaying any prompt or warning to the user." Der Protokollordner muss existieren.

**Rückgabecodes** ([W11]): 0 Erfolg · 1602 abgebrochen · 1603 schwerer Fehler (auch die Startbedingungen unten) · 1605 Produkt nicht installiert (bei `/x`) · 1618 andere Installation läuft · 1638 andere Version installiert · 1641 Neustart ausgelöst · 3010 Erfolg, Neustart nötig.

**Erkennung**: der Produktcode, den Intune und Configuration Manager beim Import selbst auslesen; Intune prüft auf Wunsch zusätzlich die Version. Weil sich der Produktcode mit jeder Version ändert, erkennt eine reine Produktcode-Regel genau eine Version. Wer über Versionen hinweg erkennen will, nimmt `DisplayVersion` im Schlüssel `HKLM\…\Uninstall\{PRODUKTCODE}` oder ein Skript über den UpgradeCode.

**Laufendes Programm**: Microsoft schreibt, dass Windows Installer im stillen Modus Programme über den Restart Manager schließt („Silent UI level installations always shut down applications and services", [W11]). Auf Windows 11 lief es so: Update von 0.5.0 auf 0.5.1 als Administrator, während LDAPilot in der Sitzung des Benutzers lief. Ergebnis: Code 0, kein 3010. Die Programmdatei auf der Platte war danach die neue, und das laufende LDAPilot arbeitete unverändert weiter, bis es neu gestartet wurde. Der Restart Manager meldete nur Programme „in the service's session" als geschlossen; das LDAPilot des Benutzers ließ er laufen. Für die Softwareverteilung ist das günstig, denn das Update gelingt immer, und der Benutzer bekommt die neue Version beim nächsten Start. Configuration Manager kann laufende Programme trotzdem vorher erkennen und die Installation zurückhalten („Install Behavior", [W15]).

**Geprüft auf Windows 11** (WiX 7.0.1, Anhang A.5 und E):
- Bau: Code 0, das MSI ist 49,7 MB groß. Ohne `-acceptEula wix7` bricht der Bau ab: „error WIX7015: You must accept the Open Source Maintenance Fee (OSMF) EULA to use WiX Toolset v7."
- ICE-Validierung (`wix msi validate`): bestanden, nachdem die Verknüpfungs-Komponenten je einen Schlüssel unter HKCU als KeyPath bekamen und der Merker zur Programmdatei wanderte. Die erste Fassung mit dem Merker als KeyPath der Verknüpfungen scheiterte an ICE38, ICE43 und ICE57.
- Installation als Administrator: Code 0 in 10 s. Installation als SYSTEM mit `DESKTOPSHORTCUT=1`: Code 0, Desktop-Verknüpfung für alle Benutzer.
- Erkennung: Schlüssel `HKLM\…\Uninstall\{Produktcode}` mit `DisplayVersion`. Jeder Bau bekam einen neuen Produktcode, so wie es die Regel verlangt.
- Downgrade: Code 1603 mit „A newer version of LDAPilot is already installed."
- Deinstallation über den Produktcode: Code 0 in 2,5 s, alles entfernt. Ein zweiter Aufruf ergab 1605.
- Gegenseitige Sperre: Das Setup endet mit 7, wenn das MSI installiert ist; das MSI endet mit 1603 und der eigenen Meldung, wenn das Setup installiert ist.

**WebView2**: Das MSI startet kein weiteres Installationsprogramm. Microsofts Beispiele dafür (eine Custom Action oder ein Burn-Bundle als `.exe`, [W13]) laufen dem Zweck zuwider: Ein Bundle ist kein MSI mehr, und eine Custom Action lädt mitten in der Installation aus dem Internet. Die Laufzeit ist für die Softwareverteilung eine eigene Abhängigkeit (3.7); fehlt sie trotzdem, meldet sich das Programm beim Start selbst.

**MSI und Setup auf demselben Rechner**: pro Rechner entweder das eine oder das andere (auf Windows 11 geprüft, siehe oben). Das MSI bricht über eine Startbedingung mit 1603 ab, wenn der Schlüssel des Setups `HKLM\…\Uninstall\{2216036E-…}_is1` existiert. Das Setup bricht im Rechnermodus mit 7 ab, wenn der Merker des MSI `HKLM\Software\LDAPilot\Installer` existiert. Die geprüfte WiX-Datei steht in Anhang E.

**Signieren**: Programmdatei vor dem Packen, das MSI nach dem Bau; das eingebettete CAB ist durch die Signatur des MSI abgedeckt ([W10], Signing).

**Dateiname**: `LDAPilot-windows-amd64.msi`.

### 3.7 WebView2-Laufzeit: wo sie fehlen kann und wie Unternehmen sie verteilen

- **Wo sie schon ist** ([W13]): „The Evergreen Runtime is preinstalled onto all Windows 11 devices as a part of the Windows 11 operating system." Auf Windows 10 hat Microsoft sie ab 2023 auch auf verwaltete Geräte verteilt; Updates gibt es auf Windows 10 22H2 „until at least October 2028 … The ESU program won't be required". **Windows Server** 2016 bis 2025 wird unterstützt, aber für eine Vorinstallation dort fand sich kein Beleg. Gerade Terminalserver und Admin-Sprungrechner, typische Orte für ein LDAP-Werkzeug, können also ohne Laufzeit sein.
- **Drei Verteilwege** ([W13]): Bootstrapper (etwa 2 MB, lädt aus dem Internet), eigenständiger Installer für Netze ohne Internet („Available for x86/x64/ARM64"), feste Version („over 250 MB", ohne automatische Updates). Die feste Version scheidet aus: Jede Sicherheitslücke in Chromium würde ein neues LDAPilot-Release verlangen.
- **Unternehmen steuern die Laufzeit** über die Richtlinie `Install{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}` unter `HKLM\SOFTWARE\Policies\Microsoft\EdgeUpdate` ([W13]): 0 verbietet die Installation, 4 erlaubt nur rechnerweite. Dann kann auch das Setup sie nicht installieren und endet mit 7; im Benutzermodus gilt das schon bei 4. Microsoft verteilt die Laufzeit auch über WSUS und Configuration Manager.
- **Empfehlung an Administratoren**: die Laufzeit als eigenes Paket bzw. als Abhängigkeit verteilen (`MicrosoftEdgeWebView2RuntimeInstallerX64.exe /silent /install`, Erkennung über den Wert `pv`), LDAPilot mit `/WEBVIEW2=nodownload` bzw. als MSI.
- **Kein Offline-Installer im LDAPilot-Setup**: Die Laufzeit ist fast überall vorhanden, die Datei ist groß, und ihr Lizenztext ließ sich nicht abrufen (UNBELEGT, siehe Anhang B).
- **Bootstrapper im Setup**: Die Wails-Vorlage bettet eine Fassung von 2021 ein ([W4]). Vorschlag: die CI lädt ihn beim Bau über Microsofts festen Link und prüft, dass er von Microsoft signiert ist.
- **Das Programm selbst** ist mit der Wails-Strategie `download` gebaut (Standard): Fehlt die Laufzeit beim Start, bietet es per Dialog an, den Bootstrapper zu laden ([W4]). Für die portable Datei ist das richtig; keine Änderung vorgeschlagen.

### 3.8 Softwareverteilung: was wo einzutragen ist

**Ivanti DSM** (Support bis 31.12.2026, [W14]):
- *MSI*: als „MSI Package" importieren; DSM verwaltet Produktcode, Eigenschaften (`DESKTOPSHORTCUT=1`) und Transformationen; Befehl `MSIInstallProduct` rechnerbezogen.
- *Setup*: eScript-Paket, Befehl `ExecuteEx` mit der Kommandozeile aus 3.5 und einer Variablen für den Rückgabecode, danach `If` auf 0 und `ExitProcEx` „Log as failed" für alles andere. Für eigene Registry-Bedingungen „Disable file redirection on x64 machines" setzen, weil DSM sonst nach `WOW6432Node` umleitet.
- *Ausführung*: rechnerbezogen über den Dienst, ohne Benutzerteil.
- *Compliance-Bedingung*: `RegValue` auf `DisplayVersion` des Schlüssels aus 3.4.
- *Deinstallationsabschnitt*: Aufruf von `unins000.exe` bzw. `MSIUninstallProduct`.

**Configuration Manager** ([W15]):
- *MSI*: Bereitstellungstyp „Windows Installer"; Produktcode und Rückgabecodes übernimmt er selbst.
- *Setup*: Bereitstellungstyp „Script Installer" mit Installations- und Deinstallationsbefehl aus 3.5, „Install for system", „Whether or not a user is logged on", Sichtbarkeit „Hidden". Erkennung: Registry wie in 3.4, Typ Version, „größer oder gleich". Rückgabecodes 5 und 7 sind ohne Eintrag Fehler, was hier richtig ist. Unter „Install Behavior" `LDAPilot.exe` eintragen, dann hält Configuration Manager die Installation zurück, solange das Programm läuft.

**Intune** ([W16]):
- *Setup als Win32-App*: `IntuneWinAppUtil -c <Ordner> -s LDAPilot-windows-amd64-installer.exe -o <Ausgabe> -q`. Installationsverhalten „System" mit `/ALLUSERS` oder „User" mit `/CURRENTUSER`. Erkennung: Registry wie in 3.4, Vergleich als Version. Code 7 als „Retry" eintragen, wenn das laufende Programm der häufigste Grund ist (drei Versuche im Abstand von fünf Minuten), sonst bleibt er „Failed".
- *MSI als „line-of-business app"*: geht nur, wenn es ohne oder mit höchstens einem Parameter vollständig installiert („Only one command-line argument can be specified"); das vorgeschlagene MSI braucht keinen. Erkennungsregeln und Rückgabecodes gibt es auf diesem Weg nicht.
- Eine App, die nur im winget-Community-Katalog steht, lässt sich in Intune nicht direkt auswählen (abgeleitet, [W16]); Intunes eigener Katalog („Enterprise App Catalog") ist kostenpflichtig, und Aufnahmen beantragt man bei Microsoft.

**winget** ([W17]): ein Manifest mit zwei Einträgen für dieselbe Datei, wie es Obsidian und Bitwarden machen. winget hängt beim Typ `inno` selbst `/SP- /VERYSILENT /SUPPRESSMSGBOXES /NORESTART` und `/LOG=` an.

```yaml
PackageIdentifier: DPicillo.LDAPilot
PackageVersion: 0.6.0
InstallerType: inno
UpgradeBehavior: install
ProductCode: '{2216036E-00F6-49B8-9C8F-D331676AFF43}_is1'
ExpectedReturnCodes:
- InstallerReturnCode: 7
  ReturnResponse: packageInUse
Installers:
- Architecture: x64
  Scope: user
  InstallerUrl: https://github.com/DPicillo/LDAPilot/releases/download/v0.6.0/LDAPilot-windows-amd64-installer.exe
  InstallerSha256: <aus SHA256SUMS.txt>
  InstallerSwitches:
    Custom: /CURRENTUSER
- Architecture: x64
  Scope: machine
  InstallerUrl: https://github.com/DPicillo/LDAPilot/releases/download/v0.6.0/LDAPilot-windows-amd64-installer.exe
  InstallerSha256: <aus SHA256SUMS.txt>
  InstallerSwitches:
    Custom: /ALLUSERS
  ElevationRequirement: elevationRequired
ManifestType: installer
ManifestVersion: 1.28.0
```

- `ReturnResponse: packageInUse` deckt nur den häufigsten Grund von Code 7 ab; WebView2 fehlt ist derselbe Code.
- Eine Code-Signatur verlangt winget-pkgs nicht, aber die Prüfung scannt mit mehreren Virenscannern; unsignierte NSIS- oder Inno-Setups mit Go-Programmen sind typische Fehlalarme.
- Veröffentlichen heißt: ein Pull Request an `microsoft/winget-pkgs`, also außerhalb des eigenen Releases. Die erste Einreichung geht von Hand, danach automatisch (`wingetcreate` oder die Action `winget-releaser`, mit einem eigenen Token).
- winget läuft nicht im Systemkonto („the WinGet CLI is not supported in the system context"). Es ist ein Weg für Arbeitsplätze und Administratoren, nicht für Verteilagenten; die nehmen die Datei direkt.

**Chocolatey und Scoop**: Pakete pflegt dort meist jemand anderes als der Hersteller; beide brauchen nur eine still installierbare Datei unter fester, versionierter Adresse. Für Scoop passt die portable Datei ohne Setup.

### 3.9 ARM64

Wails baut `windows/arm64`, und ein Inno-Setup kann beide Programmdateien tragen und beim Installieren die passende wählen (`ArchitecturesAllowed=x64compatible`, das schließt Windows 11 auf ARM64 ein, [W6]). Ein MSI braucht dagegen eine eigene Datei je Architektur mit eigenem Produktcode. Empfehlung: erst bauen, wenn jemand danach fragt. Ob die x64-Fassung auf Windows 11 für ARM64 in der Emulation mit WebView2 läuft, ist ungeprüft.

### 3.10 Programmänderungen für den Windows-Teil

1. **Mutex beim Start** (nur Windows): `LDAPilot.Running` und `Global\LDAPilot.Running`, etwa zehn Zeilen Go in einer Windows-Datei neben `main.go`. Am Verhalten ändert sich nichts; das Setup erkennt damit ein laufendes Programm (3.4).
2. **Vollständige Versionsressource der Programmdatei**: Heute fehlt die Zeichenkette `FileVersion`, und die feste Produktversion ist `0.0.0.0` (Abschnitt 2). `build/windows/info.json` um beides ergänzen, damit eine Erkennung über die Dateiversion funktioniert und Inventarwerkzeuge die richtige Version zeigen. Ob Wails' Format dafür ein Feld `product_version` kennt, wird beim Bau geprüft.
3. **Name der Programmdatei bleibt `LDAPilot.exe`.** WebView2 legt seine Daten unter `%APPDATA%\<Name der .exe>` ab ([W4]; auf Windows 11 gesehen: `%APPDATA%\LDAPilot.exe` nach dem ersten Start der installierten Datei), und dort liegt der `localStorage` des Programms mit Lesezeichen, zuletzt geöffneten Einträgen und Suchverlauf. Die portable `LDAPilot-windows-amd64.exe` hat deshalb einen eigenen Speicher, und wer von ihr zum Setup wechselt, sieht seine Lesezeichen nicht (aus dem Code abgeleitet; der Wechsel selbst ist ungeprüft). Den Ordner fest einzustellen (`WebviewUserDataPath`) wäre sauberer, verlangt aber eine Übernahme des alten Speichers. Das ist eine eigene kleine Aufgabe, kein Teil des Installers.

### 3.11 Was auf Windows 11 geprüft ist und was noch fehlt

Auf Davids Wunsch lief der Prototyp in einer Windows-11-Enterprise-VM (Evaluation, 10.0.26300, Anhang A.5). **Geprüft** ist dort:

1. Installation pro Rechner als Administrator und als SYSTEM.
2. Installation pro Benutzer als Standardbenutzer.
3. `/ALLUSERS` ohne Rechte.
4. Der Mutex über Sitzungsgrenzen.
5. `/CLOSEAPPLICATIONS` aus Sitzung 0 und aus der Sitzung des Benutzers.
6. Das MSI-Update bei laufendem Programm.
7. Der WebView2-Bootstrapper mit und ohne Internet.
8. Der Umstieg von 0.5.0.
9. Das MSI mit ICE-Validierung, Startbedingung, Upgrade, Downgrade und Deinstallation.

**Noch offen**:

1. Erkennungsregeln in Intune und Configuration Manager mit dem echten Schlüssel (kein Verwaltungssystem in der VM).
2. Windows Server (Terminalserver) und ein Rechner ohne vorinstallierte WebView2-Laufzeit; WebView2 hinter einem Proxy und mit der Richtlinie `Install…=0`.
3. Restart Manager in der Sitzung des Benutzers, während LDAPilot ungespeicherte Änderungen hat.
4. SmartScreen und Smart App Control: Die frische VM hatte Smart App Control im Auswertungsmodus (`VerifiedAndReputablePolicyState = 2`). Wird es eingeschaltet, blockiert es unsignierte Programme; das spricht zusätzlich für die Signatur (Abschnitt 7).
5. ARM64.

## 4. Linux

### 4.1 Was die Programmdateien brauchen und wo sie laufen (geprüft)

Beide Dateien des Release v0.5.0 in Containern der jeweiligen Distribution: Laufzeitpaket installiert, Programm unter Xvfb gestartet, nach 12 Sekunden geprüft, ob es läuft, ein Fenster hat und die WebKit-Hilfsprozesse da sind.

Die Abhängigkeiten laut `readelf -d`:

- `LDAPilot-linux-amd64`: `libwebkit2gtk-4.0.so.37`, `libjavascriptcoregtk-4.0.so.18`, `libgtk-3.so.0`, `libgdk-3.so.0`, `libgdk_pixbuf-2.0.so.0`, GLib/GIO/GObject, `libc.so.6`.
- `LDAPilot-linux-amd64-webkit2_41`: `libwebkit2gtk-4.1.so.0`, `libjavascriptcoregtk-4.1.so.0`, `libsoup-3.0.so.0`, sonst gleich.
- Beide verlangen höchstens **GLIBC_2.34**, obwohl die 4.1-Datei auf Ubuntu 24.04 (glibc 2.39) gebaut wird.

| Distribution | glibc | Paket für WebKitGTK 4.0 | Paket für WebKitGTK 4.1 | GTK 3 | 4.0-Datei startet | 4.1-Datei startet |
|---|---|---|---|---|---|---|
| Debian 12 | 2.36 | `libwebkit2gtk-4.0-37` | `libwebkit2gtk-4.1-0` | `libgtk-3-0` | ja | ja |
| Debian 13 | 2.41 | – | `libwebkit2gtk-4.1-0` | `libgtk-3-0t64` | – | ja |
| Ubuntu 22.04 | 2.35 | `libwebkit2gtk-4.0-37` | `libwebkit2gtk-4.1-0` (universe) | `libgtk-3-0` | ja | ja |
| Ubuntu 24.04 | 2.39 | – | `libwebkit2gtk-4.1-0` | `libgtk-3-0t64` | – | ja |
| Ubuntu 26.04 | 2.43 | – | `libwebkit2gtk-4.1-0` | `libgtk-3-0t64` | – | ja |
| Fedora 45 | 2.44 | – | `webkit2gtk4.1` | `gtk3` | – | ja |
| Rocky Linux 9 | 2.34 | `webkit2gtk3` | – | `gtk3` | ja | – |
| Rocky Linux 10 | 2.39 | – | `webkit2gtk4.1` (nur EPEL) | `gtk3` | – | lädt (kein Xvfb im Abbild, Start nicht geprüft) |
| openSUSE Leap 15.6 | 2.38 | `libwebkit2gtk-4_0-37` | `libwebkit2gtk-4_1-0` | `libgtk-3-0` | nicht geprüft | ja |
| openSUSE Leap 16.0 | 2.40 | `libwebkit2gtk-4_0-37` | `libwebkit2gtk-4_1-0` | `libgtk-3-0` | nicht geprüft | ja |
| openSUSE Tumbleweed | 2.44 | – | `libwebkit2gtk-4_1-0` | `libgtk-3-0` | – | ja |
| Arch Linux | 2.44 | – | `webkit2gtk-4.1` | `gtk3` | – | ja |

„–" heißt: Das Paket gibt es in den Quellen der Distribution nicht.

Was daraus folgt:

1. **Die 4.1-Datei ist die Hauptvariante.** Sie läuft auf allem Geprüften außer RHEL 9 und seinen Nachbauten, auch auf Debian 12 und Ubuntu 22.04, die heute zur 4.0-Datei geschickt werden. Die 4.0-Datei braucht nur noch, wer RHEL/Rocky/Alma 9 einsetzt.
2. **WebKitGTK 4.0 läuft aus.** Debian 13, Ubuntu ab 24.04, Fedora, Tumbleweed und Arch haben es nicht mehr. Ein Paket, das 4.0 verlangt, ist nur für RHEL 9 sinnvoll.
3. **Der Paketname für GTK 3 unterscheidet sich** (`libgtk-3-0` gegen `libgtk-3-0t64`); auf Debian 13 und Ubuntu ab 24.04 stellt `libgtk-3-0t64` den alten Namen bereit (`Provides: libgtk-3-0`), eine Abhängigkeit auf `libgtk-3-0` wird dort also erfüllt.
4. **RHEL 10 hat WebKitGTK nur über EPEL.** Ein `.rpm` für RHEL 10 setzt EPEL voraus; das gehört in die Installationsanleitung.
5. Die Fensterklasse folgt dem Namen der Programmdatei: als `LDAPilot` gestartet `WM_CLASS "LDAPilot", "LDAPilot"`, als `/usr/bin/ldapilot` installiert `WM_CLASS "ldapilot", "Ldapilot"` (beides geprüft). GTK 3 nimmt denselben Programmnamen unter Wayland als App-ID (`app_id = g_get_prgname ()`, [L5]). Ohne Programmänderung passt der Desktop-Eintrag also nur unter X11 und nur, solange die Datei `ldapilot` heißt; siehe 4.8.

### 4.2 Die Formate im Vergleich

| | `.deb` / `.rpm` | Archiv mit Installationsskript | AppImage | Flatpak (Flathub) | Snap |
|---|---|---|---|---|---|
| Pro Rechner | ja | – | – | ja (`--system`) | ja |
| Pro Benutzer ohne root | – | ja, nach `~/.local` | ja | ja (`--user`) | – |
| WebKitGTK | vom System, Paketverwaltung zieht sie nach | vom System, muss da sein | gebündelt (Tauri: „the file size grows from the 2-6 MB range to 70+ MB", [L3]) | aus der GNOME-Laufzeit | aus einem Snap |
| Sicherheitsupdates von WebKitGTK | Distribution | Distribution | nur mit neuem LDAPilot-Release | Laufzeit | Snap |
| Unbeaufsichtigt | `apt-get`, `dnf`, `zypper` mit festen Rückgabecodes (geprüft) | Skript mit Rückgabecodes (geprüft) | Datei kopieren | `flatpak install -y` | `snap install` |
| Erkennung | `dpkg-query`, `rpm -q` | Datei vorhanden | Datei vorhanden | `flatpak info` | `snap list` |
| Sandbox-Folgen für LDAPilot | keine | keine | keine | Kerberos-Cache unter `/tmp` und `/etc/krb5.conf` nicht sichtbar, Konfiguration unter `~/.var/app/…` (4.7) | ähnlich |
| Aufwand im Projekt | eine nfpm-Datei, Bau unter Linux (geprüft) | ein Skript (geprüft) | eigenes Bündeln von WebKitGTK samt Hilfsprozessen; Wails v2 hat kein Werkzeug dafür | Manifest, das ohne Netz aus dem Quelltext baut (Go-Module und npm offline) | wie Flatpak |

### 4.3 Empfehlung

1. **`.deb` und `.rpm` mit nfpm**, gebaut unter Linux in der CI, als Dateien im Release. Sie decken die Installation pro Rechner und die unbeaufsichtigte Installation ab. Drei Dateien:
   - `ldapilot_<v>-1_amd64.deb` mit der WebKitGTK-4.1-Datei: Debian 12 und 13, Ubuntu 22.04, 24.04 und 26.04 (geprüft).
   - `ldapilot-<v>-1.x86_64.rpm` mit der 4.1-Datei: Fedora, openSUSE Leap 16 und Tumbleweed, RHEL/Rocky/Alma 10 mit EPEL (geprüft).
   - `ldapilot-<v>-1.el9.x86_64.rpm` mit der 4.0-Datei, nur für RHEL/Rocky/Alma 9 (geprüft). Ob sich die eigene Datei für RHEL 9 lohnt, entscheidet David (Abschnitt 10); RHEL 9 wird bis 2032 gepflegt.
2. **Pro Benutzer: ein Archiv `LDAPilot-linux-amd64.tar.gz`** mit beiden Programmdateien und einem Installationsskript, das die passende Datei wählt und nach `~/.local` installiert (geprüft, 4.6). Es ersetzt die beiden nackten Programmdateien im Release; wer nur die Datei will, nimmt sie aus dem Archiv.
3. **Flathub** ist Davids Ziel (Nachricht vom 12.11.2026) und bekommt eine eigene Etappe mit den Bedingungen aus 4.7: Bau aus dem Quelltext ohne Netz, Sandbox-Rechte für Netz und Kerberos, und Flathubs Regeln zu KI-erzeugtem Material, die für LDAPilot entscheidend sind.
4. **Nicht geplant:** AppImage (bündelt WebKitGTK: groß, und jede WebKit-Sicherheitslücke braucht ein LDAPilot-Release; Wails v2 kann es nicht; Flathub und das Archiv decken die Fälle ab) und Snap.
5. **Paketquelle** (apt/dnf-Repository wie bei VS Code) in einer späteren Etappe; die einzelnen Dateien reichen für Verteilung per Konfigurationsverwaltung, und eine Paketquelle braucht einen GPG-Schlüssel und eine Veröffentlichung außerhalb des Releases (4.7).

### 4.4 Die Pakete im Detail

**Werkzeug**: nfpm 2.49.0 (12.11.2026), eine einzelne Go-Programmdatei; eine YAML-Datei erzeugt `.deb` und `.rpm`, Unterschiede stehen unter `overrides` ([L1]). Gebaut wurde lokal ohne Container, die Pakete sind etwa 12 MB groß.

**Inhalt** (geprüft):

| Datei | Ziel |
|---|---|
| Programmdatei | `/usr/bin/ldapilot` (0755) |
| Desktop-Eintrag | `/usr/share/applications/io.github.dpicillo.LDAPilot.desktop` |
| AppStream-Daten | `/usr/share/metainfo/io.github.dpicillo.LDAPilot.metainfo.xml` |
| Symbole | `/usr/share/icons/hicolor/{48x48,64x64,128x128,256x256}/apps/io.github.dpicillo.LDAPilot.png` (aus `build/linux/icon.png`) |
| Lizenz | `.deb`: `/usr/share/doc/ldapilot/copyright`; `.rpm`: `/usr/share/licenses/ldapilot/LICENSE` |

**Kennung**: `io.github.dpicillo.LDAPilot`, die übliche Form für ein Projekt auf GitHub. Sie ist Name des Desktop-Eintrags, des Symbols und der AppStream-Daten und später die App-ID unter Flatpak. Sie ändert sich nie.

**Abhängigkeiten**: `.deb` auf Paketnamen (`libwebkit2gtk-4.1-0`, `libgtk-3-0`; auf Debian 13 und Ubuntu ab 24.04 stellt `libgtk-3-0t64` den alten Namen bereit). `.rpm` auf die Bibliotheken selbst (`libwebkit2gtk-4.1.so.0()(64bit)`, `libgtk-3.so.0()(64bit)`), weil Fedora/RHEL (`webkit2gtk4.1`) und openSUSE (`libwebkit2gtk-4_1-0`) die Pakete verschieden nennen; so passt eine Datei für beide (geprüft). Die `.el9`-Datei hängt an `libwebkit2gtk-4.0.so.37()(64bit)`. Eine Installation zieht auf einem nackten Container 270 bis 460 Pakete nach; auf einem Arbeitsplatz mit GNOME sind sie meist schon da.

**Desktop-Eintrag** (mit `desktop-file-validate` geprüft):

```ini
[Desktop Entry]
Type=Application
Name=LDAPilot
GenericName=LDAP Browser
Comment=Browse and manage LDAP and Active Directory directories
Exec=ldapilot
Icon=io.github.dpicillo.LDAPilot
Terminal=false
Categories=Network;
Keywords=LDAP;Active Directory;AD;directory;OpenLDAP;389;
StartupWMClass=io.github.dpicillo.LDAPilot
```

`Categories=Network;System;` würde das Programm in zwei Menüs zeigen (Hinweis von `desktop-file-validate`); `Network` allein genügt. `StartupWMClass` setzt die Programmänderung aus 4.8 voraus, ohne sie müsste dort `ldapilot` stehen.

**AppStream-Daten** (mit `appstreamcli validate` 1.1.2 geprüft, gültig; der einzige pedantische Hinweis betrifft die Großbuchstaben in der Kennung): `component type="desktop-application"`, `id`, `metadata_license` CC0-1.0, `project_license` Apache-2.0, Name, Zusammenfassung, Beschreibung, `developer`, `launchable` (der Desktop-Eintrag), Adressen von Projekt und Fehlerverfolgung, `provides/binary`, ein Bildschirmfoto aus `assets/`, `content_rating oars-1.1` und `releases` mit Version und Datum. Die Datei liegt in Anhang D. Den Eintrag unter `releases` füllt der Bau aus `CHANGELOG.md`.

**Was `lintian` und `rpmlint` sagen** (geprüft, Anhang A.4): nur Formfehler, keine Fehler im Inhalt. Für ein Paket zum Herunterladen ist das ohne Belang; für die offiziellen Paketquellen der Distributionen taugt ein Paket aus einer fertigen Programmdatei ohnehin nicht, dort baut der Paketbetreuer aus dem Quelltext. Behoben werden trotzdem die einfachen:
- `.deb`: Copyright im maschinenlesbaren Format mit Verweis auf `/usr/share/common-licenses/Apache-2.0`, Abhängigkeit `libc6 (>= 2.34)`, `changelog.Debian.gz` (nfpm erzeugt sie aus einer Changelog-Datei).
- `.rpm`: Changelog-Eintrag.
- Beide meckern über ein Programm ohne PIE und ohne Handbuchseite; PIE gibt es mit `-buildmode=pie` beim Go-Bau, eine Handbuchseite ist für ein Fensterprogramm entbehrlich.

### 4.5 Kommandozeilen (geprüft)

```sh
# Debian, Ubuntu: Installation und Aktualisierung aus der Datei
DEBIAN_FRONTEND=noninteractive apt-get install -y ./ldapilot_0.6.0-1_amd64.deb
# Entfernen (Benutzerdaten in ~/.config/LDAPilot bleiben)
apt-get remove -y ldapilot
# Erkennung
dpkg-query -W -f='${Version}' ldapilot          # 0.6.0-1

# Fedora, RHEL/Rocky/Alma (10: vorher dnf install -y epel-release)
dnf -y install ./ldapilot-0.6.0-1.x86_64.rpm
dnf -y remove ldapilot
rpm -q --qf '%{VERSION}' ldapilot                 # 0.6.0

# openSUSE
zypper -n install --allow-unsigned-rpm ./ldapilot-0.6.0-1.x86_64.rpm
zypper -n remove ldapilot
```

| Fall | apt-get | dnf (Fedora 45, dnf5) | zypper |
|---|---|---|---|
| Installation, Aktualisierung | 0 | 0 | 0 |
| Abhängigkeit nicht zu haben | 100 | 1 („nothing provides libwebkit2gtk-4.1.so.0()(64bit)", RHEL 9 mit dem 4.1-Paket) | nicht geprüft |
| Ältere Datei über neuere | 100, verweigert (erst mit `--allow-downgrades`) | **0, stuft still zurück** | nicht geprüft |
| Unsigniertes Paket | 0 | 0 | **8, verweigert** ohne `--allow-unsigned-rpm` |
| Entfernen, nicht installiert | – | 0 | – |
| Datei fehlt | 100 | – | – |

- **Laufendes Programm**: Die Aktualisierung ersetzt die Datei, das laufende Programm arbeitet mit der alten weiter, bis es neu gestartet wird (geprüft unter Debian 13). Ein Neustart des Rechners ist nie nötig.
- **Ohne Internet**: Die Paketdatei selbst braucht kein Netz, die Abhängigkeiten müssen aber aus einer erreichbaren Paketquelle kommen.
- **Protokolle**: `/var/log/apt/history.log` und `/var/log/dpkg.log`, `/var/log/dnf5.log` (Fedora, geprüft) bzw. `/var/log/dnf.log`, `/var/log/zypp/history`.
- Signierte `.rpm` (GPG) ersparen openSUSE den Schalter und lassen `dnf` die Signatur prüfen; dafür muss der öffentliche Schlüssel vorher importiert sein (`rpm --import`). Siehe Abschnitt 7.

### 4.6 Pro Benutzer: Archiv mit Installationsskript (geprüft)

`LDAPilot-linux-amd64.tar.gz` (24 MB) enthält beide Programmdateien, Desktop-Eintrag, AppStream-Daten, Symbole, Lizenz und `install.sh` (Anhang D):

```sh
tar -xzf LDAPilot-linux-amd64.tar.gz
./LDAPilot-linux-amd64/install.sh              # nach ~/.local, ohne root
./LDAPilot-linux-amd64/install.sh --uninstall  # entfernen, Einstellungen bleiben
```

- Das Skript wählt die 4.1-Datei, wenn `libwebkit2gtk-4.1.so.0` vorhanden ist, sonst die 4.0-Datei, sonst endet es mit **3** und nennt das Paket je Distribution (geprüft). Falscher Aufruf: 2, Erfolg: 0.
- Ziele nach XDG: `~/.local/bin/ldapilot`, `~/.local/share/applications/…desktop` mit absolutem `Exec=`, `~/.local/share/icons/hicolor/…`, `~/.local/share/metainfo/…`.
- Unter Debian 13 als normaler Benutzer geprüft: Installation, gültiger Desktop-Eintrag, alle Bibliotheken gefunden, Deinstallation. Liegen bleibt nur der Zwischenspeicher `mimeinfo.cache`, den `update-desktop-database` anlegt.
- WebKitGTK selbst kann das Skript nicht installieren (dafür braucht es root). Auf einem Arbeitsplatz mit GNOME ist sie fast immer da.

### 4.7 Flathub, Paketquelle, AppImage

**Flathub** (Davids Ziel). Was Flathub verlangt ([L4], Stand 12.11.2026) und was es für LDAPilot heißt:

1. **KI-erzeugtes Material.** Flathub schreibt: „Submitters must disclose any AI-generated code, documentation, packaging, or other material they know or reasonably believe is included in the application or its Flathub packaging." und „Flathub manifests must not contain AI-generated or AI-assisted content." und „AI tools or agents must not open or automate Flathub submission pull requests, or generate their commit messages, descriptions, review comments, or replies." Außerdem: „Reviewers may reject a submission, including without further review, based on the extent or role of generated material".
   - Für LDAPilot heißt das: Der KI-Anteil am Programm muss in der Einreichung offengelegt werden, und Flathub kann deswegen ablehnen. Die Pflicht hängt nicht an Co-Autor-Zeilen in der Git-Historie (die seit der Umschreibung vom 12.11.2026 keine mehr trägt), sondern daran, ob KI-Material enthalten ist; `CLAUDE.md` im Repository zeigt das ohnehin. Flathub: „Undisclosed or materially misrepresented AI-generated material … may result in rejection. Repeated violations may result in a permanent ban".
   - Das Flatpak-Manifest und der Pull Request bei Flathub müssen von David selbst stammen. Dieses Konzept beschreibt deshalb nur die Anforderungen und enthält bewusst **kein** Manifest; auch ein späterer Agent darf es nicht schreiben und die Einreichung nicht öffnen.
   - Das ist die größte Unsicherheit für das Ziel Flathub; sie liegt nicht in der Technik.
2. **Bau aus dem Quelltext ohne Netz**: „All source available submissions must be built entirely from source code" und „There is no network access during the build process". Alle Go-Module und npm-Pakete müssen als Quellen im Manifest stehen; dafür gibt es Generatoren (für npm und Go in Flatpaks `flatpak-builder-tools`, nicht weiter geprüft). Der Bau läuft auf Flathubs eigener Infrastruktur, nicht in LDAPilots CI.
3. **Laufzeit**: `org.gnome.Platform`, die WebKitGTK 4.1 mitbringt (abgeleitet: Tauri v2 braucht 4.1 und empfiehlt diese Laufzeit, [L3]). LDAPilot wird dann mit `-tags webkit2_41` gebaut.
4. **App-ID** `io.github.dpicillo.LDAPilot`: entspricht Flathubs Regeln (Präfix `io.github.` für Projekte auf github.com, mindestens vier Teile, Domänenteil klein geschrieben, gleich der ID in den AppStream-Daten). Dieselbe ID tragen schon Desktop-Eintrag, Symbole und AppStream-Daten der Pakete (4.4), und die Programmänderung aus 4.8 setzt sie als Wayland-App-ID.
5. **Sandbox-Rechte** (Vorschlag, mit den Prüfern abzustimmen): Netz (`--share=network`), Fenster (`--socket=wayland`, `--socket=fallback-x11`, `--share=ipc`), GPU (`--device=dri`). Dateidialoge laufen über Portale.
6. **Kerberos im Sandkasten** ([L2]): `/tmp` des Systems ist nicht sichtbar („need to be explicitly requested with --filesystem"), also auch `/tmp/krb5cc_<uid>` nicht; `/etc` des Systems liegt unter `/run/host/etc`. LDAPilot liest `KRB5_CONFIG` und `KRB5CCNAME` (`internal/ldap/auth_kerberos.go`, `auth_ccache.go`), sodass `--env=KRB5_CONFIG=…` und ein Cache-Pfad im Profil helfen. Breite Rechte wie `--filesystem=/tmp` oder `host-etc` sehen die Prüfer kritisch („shipping overly permissive configurations will not be accepted"). Kerberos mit dem Cache des Systems geht im Flatpak also nur eingeschränkt; das gehört in die Beschreibung.
7. **Konfiguration**: liegt im Flatpak unter `~/.var/app/io.github.dpicillo.LDAPilot/config/LDAPilot`, getrennt von einer Installation per Paket. Wer wechselt, kopiert den Ordner.
8. **KI-Engine „Claude Code"**: Sie ruft die `claude`-CLI des Rechners auf, die es im Sandkasten nicht gibt; im Flatpak abschalten, die eingebauten Anbieter laufen über das Netz (aus dem Signier-Konzept, `code-signing-research`, Abschnitt 5.1).
9. **Pflege**: Jede neue LDAPilot-Version ist ein Pull Request im Flathub-Repository der App. Flathubs Prüfprogramm (`flatpak-external-data-checker`) kann ihn bei neuen GitHub-Releases selbst öffnen; zusammenführen muss David (laut Signier-Konzept, dort belegt). Ob ein solcher Bot-PR unter die KI-Regel fällt, ist nicht geklärt; er ist kein KI-Werkzeug.

Der Signier-Arbeitsbereich empfiehlt Flathub ebenfalls als ersten Linux-Store. Die KI-Regel aus Punkt 1 erwähnt er nicht; beide Konzepte sollten sie David gleich darstellen.

**Eigene Paketquelle** (apt und dnf, etwa auf GitHub Pages wie bei VS Code, oder bei einem Dienst wie dem openSUSE Build Service oder Fedora COPR): Benutzer bekämen Updates über die Systemaktualisierung. Dafür braucht es einen GPG-Schlüssel, der die Metadaten signiert und dessen privater Teil in der CI liegt, und eine Veröffentlichung außerhalb des GitHub-Releases. Die Freigaberegel bleibt erhalten, wenn nur der Release-Lauf eines `v*`-Tags die Quelle aktualisiert. Details dieser Dienste sind hier nicht belegt.

**AppImage** ([L3]): Tauri bündelt WebKitGTK in sein AppImage und muss auf dem ältesten unterstützten System bauen. Für LDAPilot hieße das ein eigenes Bündel samt WebKit-Hilfsprozessen ohne Unterstützung durch Wails v2, 70 MB und mehr, und die Sicherheitsupdates von WebKitGTK kämen nur noch mit LDAPilot-Releases. Das Archiv aus 4.6 leistet für die Installation pro Benutzer dasselbe ohne diese Nachteile.

### 4.8 Symbol in Dock und Leiste (Davids Anforderung) und die nötige Programmänderung

David ist wichtig, dass unter Linux das LDAPilot-Symbol in der Leiste bzw. im Dock erscheint (Nachricht vom 12.11.2026). Die Leiste zeigt das Symbol des Desktop-Eintrags, dem sie das Fenster zuordnet. Die Zuordnung läuft unter Wayland über die App-ID des Fensters, die gleich dem Namen des Desktop-Eintrags sein muss (`io.github.dpicillo.LDAPilot` → `io.github.dpicillo.LDAPilot.desktop`), unter X11 über die Fensterklasse und `StartupWMClass`.

**Geprüft** (Debian 13, Paket aus 4.4, sway 1.10.1 ohne Bildschirm und Xvfb):

| Start | Wayland-App-ID | X11-Fensterklasse |
|---|---|---|
| wie installiert, `/usr/bin/ldapilot` | `ldapilot` | `"ldapilot", "Ldapilot"` |
| mit dem Programmnamen `io.github.dpicillo.LDAPilot` | `io.github.dpicillo.LDAPilot` | `"io.github.dpicillo.LDAPilot", "Io.github.dpicillo.LDAPilot"` |

Das Fenstersymbol selbst (`_NET_WM_ICON`, aus `linux.Options.Icon`) ist unter X11 gesetzt; unter Wayland gibt es so etwas nicht, dort zählt nur der Desktop-Eintrag.

**Programmänderung**: `linux.Options.ProgramName = "io.github.dpicillo.LDAPilot"` in `main.go`, eine Zeile. Wails ruft damit `g_set_prgname` auf ([L5]); GTK 3 nimmt diesen Namen als Wayland-App-ID (`app_id = g_get_prgname ()`) und als X11-Fensternamen. Ohne die Änderung meldet das Fenster `ldapilot` und passt zu keinem Desktop-Eintrag, der nach der App-ID heißt; das Symbol in der Leiste fehlt dann oder ist ein allgemeines.

**Geprüft mit GNOME Shell 48.7** (Debian 13, ohne Bildschirm, Wayland; `logind` mit `python3-dbusmock` nachgebildet; die Zuordnung über GNOMEs Introspektionsschnittstelle `GetWindows` ausgelesen):

| Fall | GNOME ordnet das Fenster zu | Symbol in Dash und Leiste |
|---|---|---|
| Paket wie in 4.4, Fenster meldet `ldapilot`, `StartupWMClass=LDAPilot` | `window:1`, also keinem Desktop-Eintrag | **fehlt** (allgemeines Symbol) |
| Programmname `io.github.dpicillo.LDAPilot` (bildet die Programmänderung nach) | `io.github.dpicillo.LDAPilot.desktop` | richtig |
| ohne Programmänderung, `StartupWMClass=ldapilot` | `io.github.dpicillo.LDAPilot.desktop` | richtig |

Ein Paket, das nur Desktop-Eintrag und Symbol mitbringt, reicht also nicht: Ohne passende App-ID oder `StartupWMClass` zeigt GNOME kein LDAPilot-Symbol.

**Empfehlung**: beides.
1. Das Programm meldet die App-ID als Programmnamen (Programmänderung); das verlangt auch Flathub, wo App-ID, Desktop-Eintrag und Fenster zusammenpassen müssen.
2. Der Desktop-Eintrag nennt in `StartupWMClass` genau das, was das Fenster unter X11 meldet; das ist die Rückfallebene für X11-Sitzungen und andere Leisten.

Wails setzt den Namen erst nach `gtk_init` (`internal/frontend/desktop/linux/frontend.go`, Zeilen 181 und 241), aber bevor das Fenster erscheint. Die Wayland-App-ID sollte deshalb stimmen; der X11-Klassenname ist bei `gtk_init` schon festgelegt und bliebe `Ldapilot`. Ob `ProgramName` genügt, zeigt der erste Bau: Er muss die App-ID `io.github.dpicillo.LDAPilot` und die Fensterklasse `"io.github.dpicillo.LDAPilot", "Io.github.dpicillo.LDAPilot"` melden. Sonst setzt eine kleine Linux-Datei im Hauptpaket den Namen per `g_set_prgname` vor `wails.Run`; diesen Zustand bildet der Test mit umbenannter Programmdatei nach, und er ergab genau diese Werte.

**Abnahmekriterium** für die Umsetzung: Auf GNOME (Wayland und X11) und KDE Plasma zeigt die Leiste das LDAPilot-Symbol, sowohl nach Installation per Paket als auch per Archiv (`~/.local`), und ein Klick auf das Symbol im Dock bringt das laufende Fenster nach vorn statt eine zweite Instanz zu starten.

### 4.9 Noch zu prüfen

1. Der echte Bau mit der Programmänderung aus 4.8: Wayland-App-ID und X11-Fensterklasse; danach das Symbol in Dock und Fensterliste auf GNOME unter X11 (im Test liefen die X11-Fenster in der GNOME-Shell ohne Bildschirm nicht an) und auf KDE Plasma.
2. Rocky/Alma 10 mit EPEL: Start unter einer echten Sitzung (im Container fehlte Xvfb).
3. Zypper bei fehlender Abhängigkeit und bei einer älteren Datei.
4. Signierte `.rpm` und `.deb` (Abschnitt 7).

## 5. macOS

Hier ließ sich nichts ausprobieren (kein Mac). Alles stützt sich auf Apples, Microsofts und Homebrews Dokumentation; Kommandozeilen ohne Quellenangabe sind ungeprüft.

### 5.1 Ausgangslage

- Das Release enthält eine gezippte universelle `.app` (78,7 MB entpackt). Sie ist nur ad hoc signiert (`_CodeSignature` vorhanden, keine Developer ID) und nicht notarisiert.
- **Bundle-Identifier ist Wails' Vorgabe `com.wails.LDAPilot`** (`build/darwin/Info.plist`: `com.wails.{{.Name}}`). An diesem Namen erkennen MDM-Systeme die App (Intune: „Included app bundle IDs … are used for detecting", [M4]), er wird zur Kennung des `.pkg` und taucht in Homebrew-Einträgen auf. Er muss vor dem ersten signierten Release auf `io.github.dpicillo.LDAPilot` wechseln, danach nie wieder. Vorsicht: WebKit legt den `localStorage` (Lesezeichen, zuletzt geöffnete Einträge) vermutlich unter dem Bundle-Identifier ab, der Wechsel braucht also eine Übernahme (abgeleitet, ungeprüft; dasselbe Thema wie 3.10 Punkt 3).
- Mindestversion laut `Info.plist`: macOS 10.13.
- **Gatekeeper seit macOS 15**: „In macOS Sequoia, users will no longer be able to Control-click to override Gatekeeper when opening software that isn't signed correctly or notarized. They'll need to visit System Settings > Privacy & Security" ([M1]). Der Hinweis in den Release-Notizen („right-click → Open") stimmt für macOS 15 und neuer also nicht mehr.

### 5.2 Voraussetzung: Developer ID und Notarisierung

Ohne Signatur mit einer Developer ID und ohne Notarisierung geht auf macOS fast nichts von dem, was David will:

| Ziel | ohne Developer ID | mit Developer ID und Notarisierung |
|---|---|---|
| Benutzer öffnet die App | Umweg über Systemeinstellungen | normaler Start |
| Homebrew, offizieller Katalog | **ausgeschlossen**: „apps … must pass Homebrew's Gatekeeper checks" ([M5]); Homebrew 5.0: „We will disable all Homebrew/homebrew-cask casks that fail Gatekeeper checks in September 2026" ([M6]) | möglich, sobald die Bekanntheitsschwelle erreicht ist (5.4) |
| Homebrew, eigener Tap | möglich, aber Benutzer landen bei Gatekeeper; `--no-quarantine` hat Homebrew abgekündigt („does not wish to easily provide circumvention to macOS security features", [M6]) | sauber |
| Intune „line-of-business" `.pkg` | ausgeschlossen: „The .pkg file is signed using a "Developer ID Installer" certificate" ([M4]) | möglich |
| Intune „unmanaged PKG", Jamf | möglich (Intune nennt „Unsigned packages" ausdrücklich, [M4]) | möglich |

- **Wo signiert wird** (das Wie klärt der Arbeitsbereich `code-signing-research`): die `.app` mit „Developer ID Application" und gehärteter Laufzeit (die Notarisierung verlangt sie), das `.pkg` mit „Developer ID Installer" (ein zweites Zertifikat), das `.dmg`.
- **Notarisierung** ([M2]): Der Dienst nimmt „disk images (UDIF format), signed flat installer packages, and ZIP archives". Das Ticket wird an `.app`, `.dmg` und `.pkg` angeheftet, damit Gatekeeper es ohne Netz findet; „While you can notarize a ZIP archive, you can't staple to it directly". Für den ersten Start ohne Netz taugt also ein ZIP nur, wenn die `.app` darin schon geheftet ist; ein geheftetes `.dmg` ist einfacher.
- **Apple Developer Program**: Einzelpersonen können teilnehmen, der Verkäufername ist dann der bürgerliche Name ([M3]). Die Gebühr ist jährlich (Betrag hier nicht nachgelesen).

### 5.3 Empfehlung

Alles setzt eine Developer ID voraus. Bis dahin bleibt es beim ZIP, mit korrigiertem Hinweis zu Gatekeeper.

1. **`.dmg`** statt ZIP, signiert, notarisiert und geheftet: Fenster mit der App und einer Verknüpfung zu „Programme" zum Hineinziehen, wie bei KeePassXC ([V2]). Ohne Administratorrechte zieht man die App nach `~/Applications`.
2. **`.pkg`** für MDM und unbeaufsichtigte Installation: ein Produktarchiv (`productbuild`) mit einer Komponente, signiert mit „Developer ID Installer", notarisiert, geheftet; Ziel `/Applications`. Im Distribution-XML `enable_localSystem="true"` und `enable_currentUserHome="true"`, damit dieselbe Datei auch ohne Administratorrechte ins Benutzerverzeichnis installieren kann: „A home directory installation is done as the current user (not as root), and it cannot write outside of the home directory" ([M7]). Ob Intunes LOB-Weg ein solches Produktarchiv annimmt („a component package or a package containing multiple packages"), wird geprüft.
3. **Homebrew**: zuerst ein **eigener Tap** `DPicillo/homebrew-tap` mit einer Cask `ldapilot` (lädt das `.dmg` aus dem GitHub-Release); den Eintrag aktualisiert der Release-Lauf eines `v*`-Tags mit eigenem Token, eine Veröffentlichung außerhalb des Releases. Später der **offizielle Katalog** `homebrew/cask`, sobald die App notarisiert ist und die Bekanntheitsschwelle erreicht (5.4).
4. Nicht geplant: Mac App Store (Sandbox, eigene Prüfung).

### 5.4 Homebrew im Detail

- **Bekanntheit** ([M5], Package Acceptance Policy): „at least 30 forks, 30 watchers or 75 stars", bei Einreichung durch den Inhaber des Repositorys „at least 90 forks, 90 watchers or 225 stars". LDAPilot hat am 12.11.2026 22 Sterne, 0 Forks, 0 Beobachter. Für den offiziellen Katalog ist es also zu früh; ein eigener Tap ist davon nicht betroffen („Software that does not meet the official criteria can generally be maintained in a third-party tap").
- **Gatekeeper**: siehe 5.2; ohne Notarisierung kein offizieller Katalog.
- **Plattform**: „A cask that supports macOS must work on the latest major version of macOS"; die universelle App erfüllt das voraussichtlich.
- **Bedienung** (ungeprüft): `brew install --cask dpicillo/tap/ldapilot`, mit `--appdir=~/Applications` ohne Administratorrechte; `brew upgrade --cask ldapilot`; `brew uninstall --cask ldapilot`, mit `--zap` samt `~/Library/Application Support/LDAPilot`. Für Skripte `HOMEBREW_NO_AUTO_UPDATE=1`.

### 5.5 Kommandozeilen (ungeprüft)

```sh
# .pkg pro Rechner (MDM, Administrator)
sudo installer -pkg LDAPilot-macos-universal.pkg -target /
# .pkg pro Benutzer, ohne Administratorrechte
installer -pkg LDAPilot-macos-universal.pkg -target CurrentUserHomeDirectory
# Erkennung
pkgutil --pkg-info io.github.dpicillo.LDAPilot
defaults read /Applications/LDAPilot.app/Contents/Info.plist CFBundleShortVersionString
# Entfernen (ein .pkg bringt kein Deinstallationsprogramm mit)
sudo rm -rf /Applications/LDAPilot.app && sudo pkgutil --forget io.github.dpicillo.LDAPilot
# .dmg unbeaufsichtigt
hdiutil attach -nobrowse -quiet -mountpoint /tmp/ldapilot-dmg LDAPilot-macos-universal.dmg
ditto /tmp/ldapilot-dmg/LDAPilot.app /Applications/LDAPilot.app
hdiutil detach -quiet /tmp/ldapilot-dmg
```

- Aktualisierung: das neuere `.pkg` bzw. `.dmg` darüber installieren. Neustart: nie. Ohne Netz: geht, wenn das Ticket geheftet ist.
- Intune erkennt die App am Bundle-Identifier und an der Version („Included apps", [M4]); für ein Update muss `CFBundleShortVersionString` steigen.
- Protokoll des Installationsprogramms: `/var/log/install.log` (ungeprüft).

### 5.6 Noch zu prüfen (auf einem Mac)

1. Signieren und Notarisieren einer Wails-v2-App mit gehärteter Laufzeit (braucht sie Entitlements?).
2. `.pkg` mit beiden Domänen: `installer -target CurrentUserHomeDirectory` ohne Administratorrechte; Annahme durch Intune (LOB und „unmanaged").
3. Wechsel des Bundle-Identifiers: bleiben Lesezeichen und zuletzt geöffnete Einträge erhalten?
4. Update, während die App läuft.

## 6. Verwaltete Umgebungen (optionale Erweiterung)

Eine Installation verteilt nur das Programm. Administratoren wollen oft mehr: vorgegebene Verbindungen für alle, und Funktionen abschalten, die ihre Richtlinien nicht erlauben, allen voran die KI. Das braucht Änderungen am Programm und ist deshalb eine eigene, optionale Etappe. Hier steht der grobe Entwurf.

**Wie es andere machen** (Recherchenotizen, Quellen dort: VS Code, Chrome, Firefox):

| | Windows | macOS | Linux |
|---|---|---|---|
| VS Code | Registry `Software\Policies\Microsoft\VSCode`, ADMX/ADML im Lieferumfang; Rechner vor Benutzer | Konfigurationsprofil (`.mobileconfig`), Beispiel im Lieferumfang | `/etc/vscode/policy.json`, root gehört, 0644 |
| Chrome | ADMX, `Software\Policies\Google\Chrome` | plist | `/etc/opt/chrome/policies/managed/*.json` und `…/recommended/*.json` |
| Firefox | ADMX, `Software\Policies\Mozilla\Firefox` | Konfigurationsprofil | `/etc/firefox/policies/policies.json` |

Chrome und Firefox trennen **erzwungene** Werte (der Benutzer kann sie nicht ändern) von **Vorgaben** (vorbelegt, änderbar); VS Code kennt nur erzwungene.

**Entwurf für LDAPilot**:

- **Quellen**: Windows `HKLM\Software\Policies\LDAPilot`, dann `HKCU\Software\Policies\LDAPilot` (Rechner gewinnt); macOS die verwaltete Einstellungsdomäne `io.github.dpicillo.LDAPilot` (setzt den neuen Bundle-Identifier aus 5.1 voraus); Linux `/etc/ldapilot/policy.json`. Zwei Ebenen wie bei Chrome: `Enforced` und `Defaults`.
- **Erste Einstellungen**:
  - `DisableAI` (die KI-Seitenleiste verschwindet), `AllowedAIProviders` bzw. ein fester Endpunkt (nur der interne Dienst), `DisableClaudeCodeEngine`.
  - `ManagedConnections`: Verbindungsprofile ohne Passwörter (Name, Host, Port, TLS, Basis-DN, Bindungsart, Kerberos-SPN). Sie erscheinen schreibgeschützt mit dem Hinweis „von Ihrer Organisation verwaltet".
  - `AllowUserConnections`: eigene Verbindungen erlauben oder nicht.
  - `RequireTLS`: keine Verbindung ohne LDAPS oder StartTLS.
  - `TrustedCACertificates`: CA-Zertifikate für alle Verbindungen.
  - `DisablePasswordStorage`: Passwort bei jedem Verbinden abfragen (das gibt es heute schon pro Profil, `askPassword`).
  - `ForceReadOnly`: alle Verbindungen schreibgeschützt.
- **Durchsetzung im Go-Teil**, nicht nur in der Oberfläche: Der KI-Dienst lehnt ab, wenn er abgeschaltet ist; der Verbindungsspeicher lehnt nicht erlaubte Profile ab. Die Oberfläche zeigt gesperrte Schalter mit Begründung. Ein neues Paket (`internal/policy`) liest die Quellen beim Start, ein `PolicyService` reicht sie an die Oberfläche.
- **Lieferumfang**: ADMX/ADML (aus einer einzigen Definitionsdatei erzeugt, wie VS Code es macht), ein Beispiel-`.mobileconfig` und ein Beispiel-`policy.json` in jedem Release. Intune übernimmt ADMX-Dateien, DSM und Gruppenrichtlinien schreiben Registry-Werte.
- **Aufwand**: drei bis fünf Tage für die genannten Einstellungen samt Tests; jede weitere Einstellung ist klein.

Nicht nötig: einen Schalter für Update-Prüfungen oder Telemetrie, weil LDAPilot beides nicht hat (Abschnitt 2).

## 7. Signieren: an welchen Stellen

Wie signiert wird (Zertifikat, Dienst, Kosten), klärt der Arbeitsbereich `code-signing-research` (`docs/plans/2026-11-12-code-signing-research.md` dort). Zwischenstand: Azure Artifact Signing ist für Privatpersonen in Deutschland nicht offen; vorläufige Richtung SignPath Foundation oder ein gekauftes Zertifikat. Hier steht nur, **wo** im Bau signiert wird. Die Reihenfolge ist zwingend von innen nach außen; wer nur das Setup signiert, installiert eine unsignierte Programmdatei.

| Plattform | Was | Wann | Wie im Bau |
|---|---|---|---|
| Windows | `LDAPilot.exe` (zugleich die portable Datei) | nach dem Übersetzen, vor jedem Packen | Schritt nach `scripts/build.sh` bzw. Wails-Hook |
| Windows | `unins000.exe` (Inno) | beim Übersetzen des Setups | `SignTool=` im Skript; `SignedUninstaller` ist dann automatisch an ([W6]) |
| Windows | Setup `LDAPilot-windows-amd64-installer.exe` | beim Übersetzen des Setups | `SignTool=` |
| Windows | `LDAPilot-windows-amd64.msi` | nach `wix build` | das MSI signieren; das eingebettete CAB ist damit abgedeckt ([W10]) |
| Windows | WebView2-Bootstrapper im Setup | – | ist von Microsoft signiert; in der CI prüfen, nicht neu signieren |
| macOS | `LDAPilot.app` | nach dem Bau | Developer ID Application, gehärtete Laufzeit, Notarisierung, Ticket heften |
| macOS | `.pkg` | nach `productbuild` | Developer ID Installer, Notarisierung, heften |
| macOS | `.dmg` | nach dem Erstellen | signieren, Notarisierung, heften |
| Linux | `.rpm` | beim Paketbau | GPG; nfpm kann `.rpm` und `.deb` beim Bau signieren ([L1]); erspart openSUSE den Schalter `--allow-unsigned-rpm` (4.5) |
| Linux | `.deb` | beim Paketbau | GPG (apt prüft Signaturen einzelner `.deb` nicht, nur die Metadaten einer Paketquelle) |
| Linux | Paketquelle (später) | beim Veröffentlichen | GPG für die Metadaten |
| alle | `SHA256SUMS.txt` | im Release-Lauf | bleibt; eine Signatur der Datei (GPG) wäre ein kleiner Zusatz |
| Flathub, Homebrew | – | – | Flathub baut und signiert selbst; Homebrew prüft die Prüfsumme im Cask |

Das heutige NSIS-Setup hätte dieselben drei Windows-Stellen über `!finalize` und `!uninstfinalize`; mit Inno Setup übernimmt `SignTool=` beide.

## 8. CI und Release

### 8.1 Dateien im Release

| Datei | neu / bisher | Etappe |
|---|---|---|
| `LDAPilot-windows-amd64-installer.exe` | **neuer Inhalt** (Inno Setup statt NSIS), Name bleibt | 1 |
| `LDAPilot-windows-amd64.exe` | bleibt (portabel) | – |
| `LDAPilot-windows-amd64.msi` | neu | 2 |
| `ldapilot_<v>-1_amd64.deb` | neu | 1 |
| `ldapilot-<v>-1.x86_64.rpm` | neu | 1 |
| `ldapilot-<v>-1.el9.x86_64.rpm` | neu (RHEL 9) | 1 |
| `LDAPilot-linux-amd64.tar.gz` | neu, ersetzt die beiden nackten Linux-Dateien | 1 |
| `LDAPilot-macos-universal.dmg`, `LDAPilot-macos-universal.pkg` | neu, ersetzen das ZIP | 3 (Developer ID) |
| `LDAPilot-macos-universal.zip` | bleibt bis Etappe 3 | – |
| `SHA256SUMS.txt` | bleibt, umfasst alle Dateien | – |

Der Upload-Schritt nimmt heute `LDAPilot-*`; die Linux-Pakete beginnen klein (`ldapilot…`), das Muster muss mit. Die Tabelle „Downloads" in den Release-Notizen (im Workflow) bekommt eine Spalte „für wen" (pro Rechner, pro Benutzer, Softwareverteilung).

### 8.2 Jobs

- **Windows** (`windows-latest`): Programm bauen wie heute, aber **ohne `-nsis`**; Programmdatei signieren (Abschnitt 7). Den WebView2-Bootstrapper über Microsofts festen Link laden und prüfen, dass er gültig von Microsoft signiert ist (`Get-AuthenticodeSignature`). Inno Setup in fester Version installieren (der Runner bringt 6.7.1 mit, aktuell ist 7.1.1, [W8], [W9]) und `ISCC.exe /DAppVersion=<productVersion> build\windows\setup\ldapilot.iss` aufrufen. Etappe 2: `dotnet tool install --global wix --version 7.0.1`, dann `wix build -arch x64 -acceptEula wix7 …`.
- **Rauchtest auf dem Windows-Runner** (Vorschlag, gängige Praxis): Setup still mit `/ALLUSERS` installieren, Schlüssel und Datei prüfen, still deinstallieren, prüfen, dass beides weg ist; ebenso `/CURRENTUSER` und das MSI mit `msiexec /i … /qn` und `/x`. Ein Fehler hält das Release auf. So läuft jeder Build einmal auf echtem Windows.
- **Linux-Pakete**: ein neuer Job nach den beiden Linux-Builds lädt beide Programmdateien, holt nfpm in fester Version samt Prüfsumme, baut `.deb`, `.rpm`, `.el9.rpm` und das Archiv, und prüft Desktop-Eintrag und AppStream-Daten (`desktop-file-validate`, `appstreamcli validate`). Optional ein Installationstest in Containern (Debian 13, Fedora), wie in Anhang A.4.
- **macOS** (Etappe 3): nach dem Bau signieren, notarisieren, heften; `.dmg` (`hdiutil`) und `.pkg` (`pkgbuild`, `productbuild`) erzeugen, signieren, notarisieren, heften. Die Zugangsdaten für Apple liegen als Geheimnisse in einer geschützten Umgebung (Signier-Konzept, Abschnitt 2.5 dort).
- **Release** (nur beim Tag `v*`, wie heute): alle Dateien und `SHA256SUMS.txt` anhängen. Danach, im selben Lauf, die Veröffentlichungen außerhalb des Releases: Homebrew-Tap aktualisieren (Etappe 3), winget-PR öffnen (Etappe 2, nach der ersten Einreichung von Hand). Schlägt einer davon fehl, bleibt das Release, wie es ist; nichts wird nachträglich angehängt.

### 8.3 Freigaberegel

Bleibt unverändert: Dateien hängt nur der CI-Lauf eines `v*`-Tags an ein Release, nie nachträglich. Homebrew-Tap, winget und Flathub sind keine Anhänge, sondern Veröffentlichungen anderswo; Tap und winget stößt nur der Tag-Lauf an, Flathub folgt dem GitHub-Release über seinen eigenen Prüfbot und Davids Freigabe (4.7).

### 8.4 Feste Kennungen und Versionsregeln

| Kennung | Wert | wo |
|---|---|---|
| Inno `AppId` | `{2216036E-00F6-49B8-9C8F-D331676AFF43}` | Setup-Skript, Erkennungsregeln, winget `ProductCode` |
| MSI `UpgradeCode` | `{47D44C40-C3AA-40A0-8C62-27CD33B9CF77}` | WiX-Datei |
| App-ID | `io.github.dpicillo.LDAPilot` | Desktop-Eintrag, Symbole, AppStream, Flathub, macOS-Bundle-Identifier und `.pkg`-Kennung, Wayland-App-ID (4.8), Richtliniendomäne (6) |
| Paketname | `ldapilot` | `.deb`, `.rpm`, Homebrew-Cask, Programmdatei unter Linux |
| winget | `DPicillo.LDAPilot` | Manifest |
| Mutex | `LDAPilot.Running`, `Global\LDAPilot.Running` | Programm, Setup |

- **Versionen**: `info.productVersion` bleibt die einzige Quelle; Setup, MSI, Pakete und AppStream bekommen sie beim Bau. Sie muss aus drei Zahlen bestehen (MSI: höchstens 255.255.65535, ein viertes Feld zählt nicht), ohne Vorabzusatz; Vorabversionen bekommen keine Installer.
- Ein Test wie `TestReleaseVersionDeclarations` prüft, dass die App-ID überall gleich geschrieben ist (Desktop-Eintrag, AppStream, `Info.plist`, `ProgramName`).
- Die Kennungen kommen nach dem Muster der vorhandenen Notizen in `CLAUDE.md` (Abschnitt Version), damit niemand sie später versehentlich ändert.

## 9. Etappen und Aufwand

Schätzungen in Arbeitstagen für einen Agenten mit Davids Review; Warte- und Prüfzeiten Dritter (Flathub, winget, Apple) kommen dazu.

| Etappe | Inhalt | Aufwand | Voraussetzung |
|---|---|---|---|
| **1** Installer ohne Signatur | Inno-Setup statt NSIS (3.4) samt Rauchtest auf dem Windows-Runner; `.deb`, `.rpm`, `.el9.rpm` und Archiv (4.3 bis 4.6) samt Prüfung; Programmänderungen: Mutex (3.10), Versionsressource (3.10), `ProgramName` (4.8); README und eine Seite „Installation für Administratoren" mit Kommandozeilen, Rückgabecodes und Erkennungsregeln; Tests in der Windows-VM | 4 bis 5 | keine |
| **2** Softwareverteilung | MSI mit WiX v7 (3.6) samt Rauchtest; winget-Manifest, erste Einreichung von Hand, danach automatisch (3.8) | 2 bis 3 | Etappe 1; Signatur sehr empfohlen (SmartScreen, AppLocker, WDAC) |
| **Signatur Windows** | Signierstellen aus Abschnitt 7 in die CI | laut Signier-Konzept | Signierweg aus `code-signing-research` |
| **3** macOS | Bundle-Identifier wechseln samt Übernahme des `localStorage`; signieren, notarisieren, heften; `.dmg` und `.pkg`; eigener Homebrew-Tap mit automatischer Aktualisierung | 3 bis 4,5 | Apple Developer Program |
| **4** Flathub | Programm: Kerberos-Pfade im Sandkasten, Claude-Code-Engine im Flatpak aus; Manifest mit Go- und npm-Quellen **von David selbst** (4.7); Einreichung und Prüfung | Programm 0,5 bis 1; Manifest 1 bis 3 (David) | Davids Entscheidung zur KI-Offenlegung |
| **5** optional | Vorgaben für verwaltete Umgebungen (6); apt/dnf-Paketquelle; Homebrew-Hauptkatalog (sobald bekannt genug); ARM64 für Windows; fester WebView2-Datenordner (3.10) | je 1 bis 5 | jeweils Nachfrage |

Reihenfolge: 1 → Signatur Windows → 2; 3 und 4 unabhängig davon, sobald ihre Voraussetzungen erfüllt sind. Etappe 1 liefert schon alle drei Zielbilder auf Windows und Linux, nur unsigniert.

## 10. Entscheidungen

### 10.1 Nach gängiger Praxis entschieden (David kann widersprechen)

David hat am 12.11.2026 gesagt, das Konzept solle der gängigen Praxis folgen und bei anderen abschauen. Folgendes ist deshalb entschieden; Vorbild in Klammern:

1. Inno Setup ersetzt die NSIS-Vorlage (VS Code); ein Setup für beide Modi (Obsidian, Bitwarden); Standard „nur für mich".
2. Zielordner `C:\Program Files\LDAPilot` und `%LOCALAPPDATA%\Programs\LDAPilot`, ohne Firmenordner (VS Code).
3. Startmenü-Verknüpfung an, Desktop-Verknüpfung aus und per Aufgabe zuschaltbar (VS Code: Aufgaben über `/mergetasks`).
4. Laufendes Programm: abbrechen statt schließen (die NSIS-Beispiele; Restart Manager erst nach Test).
5. Zusätzlich ein MSI nur pro Rechner für die Softwareverteilung (KeePassXC).
6. Unter Linux `.deb` und `.rpm` aus einer nfpm-Datei, ein Archiv für die Installation pro Benutzer (VS Code bietet `.tar.gz`), App-ID `io.github.dpicillo.LDAPilot` (Flathub-Regel).
7. Eigene Datei für RHEL 9, weil sie fast nichts kostet.
8. Kein MSIX, kein AppImage, kein Snap.

### 10.2 Was nur David entscheiden kann

1. **Etappe 1 freigeben**, damit sie gebaut wird.
2. **Apple Developer Program** (jährliche Gebühr): ohne Developer ID kein `.dmg`/`.pkg` ohne Gatekeeper-Umweg, kein Intune-LOB, kein Homebrew-Hauptkatalog.
3. **Flathub und KI**: Flathub verlangt, KI-erzeugten Code offenzulegen, und kann deshalb ablehnen; das Manifest und den Pull Request muss David selbst schreiben (4.7). Will er das so?
4. **Homebrew-Tap**: ein Repository `DPicillo/homebrew-tap` und ein Token für den Release-Lauf; der Hauptkatalog erst ab 225 Sternen, 90 Forks oder 90 Beobachtern bei eigener Einreichung (heute 22 Sterne).
5. **Windows-Signatur**: Weg und Kosten laut Signier-Konzept; in verwalteten Umgebungen praktisch Voraussetzung.
6. **Ivanti DSM**: Steht in Davids Umfeld der Wechsel weg von DSM an (Support endet 31.12.2026)? Dann lieber gleich auf das Nachfolgesystem schauen.
7. **Vorgaben für Administratoren** (Abschnitt 6): gewünscht, und welche Schalter zuerst (KI aus, vorgegebene Verbindungen, TLS-Pflicht)?
8. **Paketquelle** für apt/dnf später: ja oder nein.

## Anhang A: Was ausprobiert wurde

### A.1 Linux: Laufzeitpakete und Start der Release-Dateien

- Abbilder: `debian:12`, `debian:13`, `ubuntu:22.04`, `ubuntu:24.04`, `ubuntu:26.04`, `fedora:latest` (45), `rockylinux:9`, `rockylinux/rockylinux:10`, `opensuse/leap:15.6`, `opensuse/leap:16.0`, `opensuse/tumbleweed`, `archlinux:latest`; Stand 2026-11-12.
- Verfügbarkeit: `apt-cache policy`, `dnf repoquery` (auf Rocky mit EPEL und CRB), `zypper info`, `pacman -Si` auf die Paketnamen der Tabelle in 4.1.
- Start: Laufzeitpaket ohne empfohlene Pakete installiert, `ldd` ohne „not found", dann `Xvfb :99` und das Programm 12 Sekunden laufen lassen; geprüft mit `kill -0`, `xwininfo -root -tree`, `xprop WM_CLASS` und der Zahl der WebKit-Hilfsprozesse (jeweils 2).
- Ohne Display endet das Programm mit `panic: failed to init GTK`. Das ist für ein Paket ohne Belang, zeigt aber, dass es keinen Kommandozeilenmodus gibt (`--version` ohne Display geht nicht).

### A.2 Windows: das Setup aus v0.5.0 unter Wine

- Umgebung: Container `debian:trixie-slim` mit Wine 10.0, NSIS 3.11 und Xvfb, gestartet mit `--network none`. Geprüft wurde `LDAPilot-windows-amd64-installer.exe` aus dem Release, unverändert.
- T1 `setup.exe /S` ohne WebView2-Schlüssel: Rückgabecode 0 nach 88 s; `C:\Program Files\David Picillo\LDAPilot\` enthält `LDAPilot.exe` und `uninstall.exe`; Verknüpfungen unter `C:\Users\Public\Desktop` und `C:\ProgramData\Microsoft\Windows\Start Menu\Programs`; Deinstallationsschlüssel in der 64-Bit-Sicht mit `DisplayName`, `DisplayVersion`, `DisplayIcon`, `Publisher`, `UninstallString`, `QuietUninstallString`, `EstimatedSize`.
- T2 `uninstall.exe /S`: Rückgabecode 0 nach 96 ms, `LDAPilot.exe` zu diesem Zeitpunkt noch vorhanden, 6 s später weg; der leere Ordner `David Picillo` bleibt; `%APPDATA%\LDAPilot\connections.json` bleibt; `%APPDATA%\LDAPilot.exe\` bleibt; `C:\ProgramData\LDAPilot.exe\` wird gelöscht.
- T3 mit gesetztem WebView2-Schlüssel (`pv` unter `HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-…}`), `/S /D=C:\Tools\LDAPilot`: Rückgabecode 0 in unter 1 s.
- T4 dieselbe Installation noch einmal, während eine Datei unter dem Namen `C:\Tools\LDAPilot\LDAPilot.exe` läuft (ein mit `makensis` gebautes Programm, das 90 s schläft): Rückgabecode 0, die Prüfsumme der Datei ist danach die des schlafenden Programms, also nicht ersetzt.
- T5 `uninstall.exe /S _?=C:\Tools\LDAPilot` bei laufendem Programm und einer fremden Datei im Ordner: Rückgabecode 0, `LDAPilot.exe` bleibt, die fremde Datei ist weg, Schlüssel und Verknüpfungen sind weg.
- Inhalt des Setups laut `7z l`: `LDAPilot.exe` (12,4 MB gepackt) und der WebView2-Bootstrapper (1,7 MB).
- Nicht prüfbar unter Wine: Benutzerkontensteuerung, Verhalten im Systemkonto, SmartScreen, eine echte WebView2-Installation.

### A.3 Windows: Prototyp mit Inno Setup unter Wine

- Inno Setup 7.1.1 (`innosetup-7.1.1-x86.exe` aus dem GitHub-Release vom 28.10.2026, SHA-256 `03446e46…5cc0d3`) still in den Container installiert, eine Vorstufe des Skripts aus Anhang C (ohne Bootstrapper-Schritt, Umstieg und Sperren) mit `ISCC.exe /Q` übersetzt (Rückgabecode 0, Setup 10,65 MB mit der Programmdatei aus v0.5.0). Gleiche Umgebung wie A.2, ohne Netz.
- I1 `/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /ALLUSERS` ohne WebView2-Schlüssel: Code 7 in unter 1 s, nichts installiert, Grund im Protokoll („PrepareToInstall failed: The Microsoft Edge WebView2 Runtime is not installed …").
- I2 dasselbe mit WebView2-Schlüssel: Code 0 in 1 s; `C:\Program Files\LDAPilot\` mit `LDAPilot.exe`, `unins000.exe`, `unins000.dat`; Verknüpfungen für alle Benutzer; Schlüssel `…\Uninstall\{2216036E-00F6-49B8-9C8F-D331676AFF43}_is1` nur unter HKLM, 64-Bit-Ansicht. Inhalt des Schlüssels siehe 3.4.
- I3 `/CURRENTUSER /MERGETASKS="!desktopicon"` neben der rechnerweiten Installation: Code 0; `%LOCALAPPDATA%\Programs\LDAPilot\`, Startmenü-Verknüpfung im Profil, keine Desktop-Verknüpfung; jetzt je ein Schlüssel unter HKLM und HKCU.
- I4 ohne Moduswahl, still: Das Setup nimmt den Modus der vorhandenen Installation (Protokoll: „Install mode root key: HKEY_CURRENT_USER", „Detected previous administrative 64-bit install? Yes").
- I5 Deinstallation pro Benutzer `/VERYSILENT /SUPPRESSMSGBOXES /NORESTART`: Code 0 nach 202 ms, Programmdatei zu diesem Zeitpunkt schon weg, eine fremde Datei im Ordner bleibt, HKCU-Schlüssel weg, HKLM-Installation unberührt.
- I6 Update der rechnerweiten Installation, während eine Datei unter dem Namen `LDAPilot.exe` läuft, Skript mit `CloseApplications=yes` ohne Mutex: viermal „The existing file appears to be in use", dann „Defaulting to Abort for suppressed message box", Code 5, Datei nicht ersetzt. Wine hat keinen Restart Manager; auf Windows würde Inno mit dieser Einstellung versuchen, das Programm zu schließen.
- I7 Deinstallation bei laufendem Programm ohne Mutex: Code 0, Schlüssel und Verknüpfungen weg, `LDAPilot.exe` und `unins000.exe` bleiben („Failed to delete the file; it may be in use").
- M1/M2 mit `AppMutex=LDAPilot.Running` und einem Programm, das diesen Mutex hält: Setup Code 1, Deinstallation Code 1, beide ohne Änderung („Defaulting to Cancel for suppressed message box … LDAPilot is currently running").
- V1 Vorstufe mit Prüfung über `CheckForMutexes` in `PrepareToInstall`, `CloseApplications=no`): Update bei laufendem Programm Code 7, nichts verändert.
- Ein Inno-Setup lässt sich also auch unter Linux bauen; die CI braucht das nicht, weil der Windows-Runner es mitbringt.

### A.4 Linux: Pakete, Archiv, lintian, rpmlint

- Gebaut mit nfpm 2.49.0 (GitHub-Release vom 12.11.2026, Prüfsumme gegen `checksums.txt` geprüft) aus den Release-Dateien von v0.5.0: `ldapilot_0.5.0-1_amd64.deb` (12,2 MB), `ldapilot-0.5.0-1.x86_64.rpm` (12,6 MB), dazu dieselben als 0.5.1 für den Update-Test und ein `.rpm` mit der 4.0-Datei. Konfiguration in Anhang D.
- Installation aus der Datei mit dem Werkzeug der Distribution, dann Start unter Xvfb (10 s), Fensterklasse mit `xprop`:
  - Debian 12, Debian 13, Ubuntu 22.04, 24.04, 26.04: `apt-get install -y ./…deb` Code 0, 270 bis 461 Pakete nachgezogen, Programm läuft, `WM_CLASS "ldapilot", "Ldapilot"`.
  - Fedora 45: `dnf -y install ./…rpm` Code 0, läuft.
  - openSUSE Leap 16.0 und Tumbleweed: `zypper -n install` Code 8 („Installation has been aborted as directed", unsigniertes Paket), mit `--allow-unsigned-rpm` Code 0, läuft.
  - Rocky Linux 10.2 mit EPEL: Code 0 (Start nicht geprüft, kein Xvfb-Paket).
  - Rocky Linux 9.3: das 4.1-Paket Code 1 („nothing provides libwebkit2gtk-4.1.so.0()(64bit)"), das 4.0-Paket Code 0, läuft.
- Debian 13, laufendes Programm: Update auf 0.5.1 Code 0, der alte Prozess läuft weiter (`/proc/<pid>/exe` zeigt auf die gelöschte Datei); `apt-get remove -y ldapilot` Code 0, Programmdatei weg, `~/.config/LDAPilot` bleibt; Zurückstufen von 0.5.1 auf 0.5.0 mit `apt-get install` Code 100; fehlende Datei Code 100.
- Fedora 45: Update per Datei Code 0, Zurückstufen per Datei Code 0 („Downgrading"), `dnf remove` Code 0, nochmals bei nicht installiertem Paket ebenfalls 0; Protokoll `/var/log/dnf5.log`.
- `lintian` 2.122.0 (Debian 13): Fehler `copyright-file-contains-full-apache-2-license`, `copyright-not-using-common-license-for-apache2`, `missing-dependency-on-libc`, `no-changelog`; Warnungen `copyright-without-copyright-notice`, `hardening-no-pie`, `no-manual-page`.
- `rpmlint` 2.9.0 (Fedora 45): Fehler `no-changelogname-tag`; Warnungen `position-independent-executable-suggested`, `no-manual-page-for-binary`, `no-documentation`.
- Archiv (Debian 13, normaler Benutzer): ohne WebKitGTK Code 3 mit Hinweis; nach `apt-get install libwebkit2gtk-4.1-0` Code 0, Dateien unter `~/.local` wie in 4.6, Desktop-Eintrag gültig, keine fehlende Bibliothek; `--uninstall` Code 0, übrig nur `mimeinfo.cache`.
- `desktop-file-validate` und `appstreamcli validate` 1.1.2 auf dem Rechner: gültig (siehe 4.4).
- Leisten-Symbol (4.8): Debian 13 mit dem `.deb`; sway 1.10.1 ohne Bildschirm (`WLR_BACKENDS=headless`), App-ID per `swaymsg -t get_tree`: als `/usr/bin/ldapilot` gestartet `ldapilot`, über einen Verweis namens `io.github.dpicillo.LDAPilot` gestartet `io.github.dpicillo.LDAPilot`; unter Xvfb die Fensterklasse entsprechend, `_NET_WM_ICON` gesetzt. GNOME Shell 48.7 `--headless --wayland --virtual-monitor 1400x900` mit System-Bus und `python3 -m dbusmock --system --template logind`; Abfrage `org.gnome.Shell.Introspect.GetWindows` aus einem gjs-Skript, das dafür den freigegebenen Namen `org.freedesktop.impl.portal.desktop.gnome` hält (GNOMEs Freigabeliste in `introspect.js`). Ergebnisse in der Tabelle in 4.8.

### A.5 Windows 11: Setup und MSI in einer echten Windows-VM

- **VM**: Container `instconcept-win11` mit dem Abbild `dockurr/windows` 6.06 (Windows in QEMU/KVM, unbeaufsichtigte Installation, [W18]); Windows 11 Enterprise Evaluation 10.0.26300, 4 Kerne, 6 GB. WebView2-Laufzeit 157.0.4341.46 vorinstalliert. Zugriff über SSH (Administrator „Docker" mit vollen Rechten, Standardbenutzer „tester"); Programme in der Sitzung des Benutzers über geplante Aufgaben mit interaktiver Anmeldung; SYSTEM über eine geplante Aufgabe. Alle Dateien unsigniert.
- **Prüflinge**: Setup aus Anhang C, mit Inno Setup 7.1.1 unter Wine gebaut, als 0.5.0 und 0.5.1 (mit um zwei Byte veränderter Programmdatei, damit sich „ersetzt" erkennen lässt); das NSIS-Setup aus dem Release v0.5.0; MSI aus Anhang E, in der VM mit WiX 7.0.1 und einem privaten .NET SDK 10.0.404 gebaut; ein kleines Programm, das die Mutexe hält.
- **Setup** (Rückgabecode, Dauer):
  - NSIS 0.5.0 `/S`: 0, 5,2 s.
  - Neues Setup `/ALLUSERS` darüber: 0, 7,8 s; Protokoll „Removing LDAPilot 0.5.0 (NSIS)", „removed"; alter Schlüssel, Ordner und Desktop-Verknüpfung weg; neue Startmenü-Verknüpfung für alle, keine Desktop-Verknüpfung.
  - `LDAPilot.exe` danach ohne Zeichenkette `FileVersion` (leer in den Dateieigenschaften).
  - Start in der Sitzung des Benutzers: läuft mit drei `msedgewebview2`-Prozessen; `%APPDATA%\LDAPilot.exe` und `%APPDATA%\LDAPilot` angelegt.
  - Update auf 0.5.1 bei laufendem LDAPilot: 5 nach 8,5 s, „The existing file appears to be in use (5). Retrying." viermal, nichts ersetzt.
  - Dasselbe mit `/CLOSEAPPLICATIONS` aus der SSH-Sitzung: 5; „RestartManager found an application using one of our files: LDAPilot", „Can use RestartManager to avoid reboot? No (2: Session Mismatch)".
  - Dasselbe in der Sitzung des Benutzers gestartet: 0; „Shutting down applications using our files." und 2,4 s später fertig; LDAPilot beendet, Datei ersetzt.
  - Mutex nur lokal in Sitzung 1: Setup 0 und Deinstallation 0 (nicht erkannt). Lokal und global: Setup 7 („LDAPilot is running …"), Deinstallation 1 („InitializeUninstall returned False").
  - Deinstallation `/VERYSILENT`: einmal 0 mit liegengebliebener `LDAPilot.exe` („Failed to delete the file; it may be in use (5)", kein LDAPilot lief), in der Wiederholung 0 und alles entfernt.
  - Als SYSTEM über eine geplante Aufgabe `/ALLUSERS`: 0, nur Verknüpfungen für alle.
  - Als Standardbenutzer: `/CURRENTUSER` neben der rechnerweiten Installation 7; `/ALLUSERS` 1 nach 4,9 s („You must be logged in as an administrator"); nach Entfernen der rechnerweiten Installation `/CURRENTUSER` 0 nach 3,0 s, Update 0, Deinstallation 0; rechnerweite Installation neben der Benutzerinstallation 0.
  - WebView2 (Wert `pv` vorübergehend `0.0.0.0`, danach wiederhergestellt): `nodownload` 7 nach 2,1 s; `ignore` 0; Standard ohne Internet (Firewall-Regel gegen ausgehend 80/443) 7 nach 26,2 s, Bootstrapper `-2147012867` nach 23 s; Standard mit Internet 0 nach 44,3 s, Bootstrapper 0 nach 40 s, `pv` danach wieder 157.0.4341.46.
- **MSI**:
  - Bau ohne `-acceptEula wix7`: 1, WIX7015. Mit: 0.
  - Erste Fassung: ICE38, ICE43, ICE57; zweite Fassung (Anhang E): Validierung 0.
  - `msiexec /i … /qn /norestart /l*v`: 0 in 9,7 s; Schlüssel `{1A21D603-…}`, Merker, Startmenü-Verknüpfung für alle. Setup daneben: 7.
  - Update auf 0.5.1 bei laufendem LDAPilot: 0 in 11,3 s, Datei ersetzt, LDAPilot läuft weiter; „RESTART MANAGER: Successfully shut down all applications in the service's session that held files in use."
  - Downgrade auf 0.5.0: 1603, „A newer version of LDAPilot is already installed."
  - `msiexec /x {Produktcode}`: 0 in 2,5 s, alles entfernt; nochmals: 1605.
  - MSI bei installiertem Setup: 1603, „LDAPilot is already installed with its setup program."
  - Als SYSTEM mit `DESKTOPSHORTCUT=1`: 0, Desktop-Verknüpfung unter `C:\Users\Public\Desktop`.
- Die VM startete einmal von selbst neu (Windows Update nach der Erstinstallation); danach Updates für sieben Tage pausiert.
- Nach den Tests lagen noch ein leerer Ordner `C:\Program Files\LDAPilot` und im Profil von „tester" `unins000.exe`. Inno löscht das Deinstallationsprogramm und den Ordner zuletzt über eine Kopie in `%TEMP%`; vermutlich hat der Windows-SSH-Dienst diese Kopie beendet, als die Sitzung endete (nicht weiter untersucht). Unter einem Verteilagenten oder interaktiv sollte das nicht auftreten. In der Abnahme (3.11) mit einem Verteilagenten gegenprüfen.

## Anhang B: Quellen

Abgerufen am 12.11.2026. Wo die Recherche über ein Werkzeug lief, das Seiten zusammenfasst, statt den Rohtext zu lesen, ist das in den Notizen vermerkt; im Text sind nur Stellen zitiert, die als Rohtext gelesen wurden.

**Windows**

- [W1] NSIS-Handbuch: Kommandozeile https://nsis.sourceforge.io/Docs/Chapter3.html, Skriptbefehle (u. a. `SetErrorLevel`, `AllowSkipFiles`, `RMDir`, `LogSet`, stiller Modus 4.12) https://nsis.sourceforge.io/Docs/Chapter4.html, Rückgabecodes und Deinstallationsschlüssel https://nsis.sourceforge.io/Docs/AppendixD.html, `!finalize` https://nsis.sourceforge.io/Docs/Chapter5.html; Quelltext (Standardantworten im stillen Modus, Kopie des Deinstallationsprogramms) https://github.com/kichik/nsis/blob/master/Source/script.cpp, https://github.com/kichik/nsis/blob/master/Source/exehead/Main.c; NSIS 3.13 vom 27.09.2026 https://nsis.sourceforge.io/Download
- [W2] NSIS MultiUser: https://nsis.sourceforge.io/Docs/MultiUser/Readme.html; Quelltext `MultiUser.nsh` (NSIS 3.11 im Container gelesen)
- [W3] NsisMultiUser: https://github.com/Drizin/NsisMultiUser und Wiki-Seiten Parameters, Return-Codes, Defines
- [W4] Wails v2.17.0: NSIS-Bau https://github.com/wailsapp/wails/blob/v2.17.0/v2/pkg/commands/build/nsis_installer.go, Vorlagen https://github.com/wailsapp/wails/tree/v2.17.0/v2/pkg/buildassets/build/windows/installer, Build-Schalter (`-installscope`, `-webview2`) https://github.com/wailsapp/wails/blob/v2.17.0/v2/cmd/wails/flags/build.go, Laufzeitprüfung https://github.com/wailsapp/wails/tree/v2.17.0/v2/internal/wv2installer, eingebetteter Bootstrapper https://github.com/wailsapp/wails/tree/v2.17.0/v2/internal/webview2runtime, Optionen (`WebviewUserDataPath`) https://github.com/wailsapp/wails/blob/master/website/docs/reference/options.mdx, https://github.com/wailsapp/go-webview2/blob/v1.0.23/pkg/edge/chromium.go, Pull Request für `-installscope` https://github.com/wailsapp/wails/pull/5094
- [W5] Wails v3.0.0 https://github.com/wailsapp/wails/releases/tag/v3.0.0, NSIS-Vorlage von v3.1.0 https://github.com/wailsapp/wails/blob/v3.1.0/v3/examples/badge/build/windows/nsis/project.nsi
- [W6] Inno-Setup-Hilfe: Kommandozeile https://jrsoftware.org/ishelp/topic_setupcmdline.htm, Rückgabecodes https://jrsoftware.org/ishelp/topic_setupexitcodes.htm, Deinstallation https://jrsoftware.org/ishelp/topic_uninstcmdline.htm und https://jrsoftware.org/ishelp/topic_uninstexitcodes.htm, `PrivilegesRequiredOverridesAllowed` https://jrsoftware.org/ishelp/topic_setup_privilegesrequiredoverridesallowed.htm, `UsePreviousPrivileges` https://jrsoftware.org/ishelp/topic_setup_usepreviousprivileges.htm, `CloseApplications` https://jrsoftware.org/ishelp/topic_setup_closeapplications.htm, `AppMutex` https://jrsoftware.org/ishelp/topic_setup_appmutex.htm, `ArchitecturesAllowed` https://jrsoftware.org/ishelp/topic_setup_architecturesallowed.htm, `SignedUninstaller` https://jrsoftware.org/ishelp/topic_setup_signeduninstaller.htm
- [W7] Inno-Setup-Lizenz https://jrsoftware.org/files/is/license.txt („Permission is granted to anyone to use this software for any purpose, including commercial applications"); kommerzielle Lizenzen https://jrsoftware.org/isorder.php („It is not strictly required. However, … we believe it is fair to request that all commercial users purchase a license", „We're not requesting that non-commercial users purchase licenses")
- [W8] Inno-Setup-Releases 7.1.1 und 6.7.4 vom 28.10.2026: https://github.com/jrsoftware/issrc/releases
- [W9] GitHub-Runner-Abbilder (InnoSetup 6.7.1 auf Windows Server 2022 und 2025, NSIS 3.10 nur auf 2022, WiX 3.14, .NET SDK bis 10.0): https://github.com/actions/runner-images/blob/main/images/windows/Windows2025-Readme.md, https://github.com/actions/runner-images/blob/main/images/windows/Windows2022-Readme.md
- [W10] WiX: Lebenszyklus https://docs.firegiant.com/wix/, Versionshinweise https://docs.firegiant.com/wix/whatsnew/releasenotes/, Wartungsgebühr https://docs.firegiant.com/wix/osmf/ und https://github.com/wixtoolset/wix/blob/main/OSMFEULA.txt, Kommandozeile https://docs.firegiant.com/wix/tools/wixexe/, `Package/@Scope` https://docs.firegiant.com/wix/schema/wxs/packagescopetype/, `MajorUpgrade` https://docs.firegiant.com/wix/schema/wxs/majorupgrade/, Signieren https://docs.firegiant.com/wix/tools/signing/, WiX unter Linux https://github.com/wixtoolset/issues/issues/4381
- [W11] Windows Installer: https://learn.microsoft.com/en-us/windows/win32/msi/allusers, https://learn.microsoft.com/en-us/windows/win32/msi/single-package-authoring, https://learn.microsoft.com/en-us/windows/win32/msi/major-upgrades, https://learn.microsoft.com/en-us/windows/win32/msi/standard-installer-command-line-options, https://learn.microsoft.com/en-us/windows/win32/msi/error-codes, https://learn.microsoft.com/en-us/windows/win32/msi/using-windows-installer-with-restart-manager, https://learn.microsoft.com/en-us/windows/win32/msi/productversion, https://learn.microsoft.com/en-us/windows/win32/msi/productcode
- [W12] MSIX: https://learn.microsoft.com/en-us/windows/msix/package/signing-package-overview, https://learn.microsoft.com/en-us/windows/msix/desktop/desktop-to-uwp-behind-the-scenes, https://learn.microsoft.com/en-us/windows/msix/desktop/flexible-virtualization
- [W13] WebView2: https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution, https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/evergreen-vs-fixed-version, https://learn.microsoft.com/en-us/deployedge/microsoft-edge-supported-operating-systems, https://learn.microsoft.com/en-us/deployedge/microsoft-edge-update-policies, https://learn.microsoft.com/en-us/deployedge/webview2-enterprise, https://learn.microsoft.com/en-us/troubleshoot/microsoft-edge/manageability/update-install-rollback-failures; Beispiele mit WiX https://learn.microsoft.com/en-us/microsoft-edge/webview2/samples/wv2deploymentwixburnbundlesample
- [W14] Ivanti DSM: Datenblatt „Transitioning from Ivanti DSM to Ivanti Neurons" (IVI-2819) https://ivanti.com/resources/library/ivi/2819/0fae02480f5a/?ext=pdf; Hilfe https://help.ivanti.com/iv/help/en_US/DSM/vNow/Konzept/N_KON_SWL_SWF_PAK_Allgemein.htm, …/Befehle/Definitionen/BEF_ExecuteEx.htm, …/Befehle/Definitionen/BEF_ExitProcEx.htm, …/Konzept/N_KON_SWL_SWF_MSI_Unterstuetzung.htm, …/Konzept/N_KON_SWL_SWF_PAK_LUT_LSH.htm, …/Konzept/N_KON_SWL_ZUP_ComplianceEnforcement.htm
- [W15] Configuration Manager: https://learn.microsoft.com/en-us/intune/configmgr/apps/deploy-use/create-applications, https://learn.microsoft.com/en-us/intune/configmgr/apps/deploy-use/check-for-running-executable-files
- [W16] Intune: https://learn.microsoft.com/en-us/intune/app-management/deployment/add-win32, https://learn.microsoft.com/en-us/intune/app-management/deployment/add-lob-windows, https://learn.microsoft.com/en-us/intune/app-management/deployment/enterprise-app-management
- [W18] Windows-VM im Container: https://github.com/dockur/windows (README, Release v6.06 vom 05.10.2026)
- [W17] winget: Schema https://github.com/microsoft/winget-pkgs/blob/master/doc/manifest/schema/1.28.0/installer.md, Standardschalter und -codes https://github.com/microsoft/winget-cli/blob/master/src/AppInstallerCommonCore/Manifest/ManifestCommon.cpp, Systemkonto https://learn.microsoft.com/en-us/windows/package-manager/winget/troubleshooting, Regeln https://github.com/microsoft/winget-pkgs/blob/master/doc/Policies.md und https://github.com/microsoft/winget-pkgs/blob/master/doc/Validation.md, Beispiel mit zwei Modi https://github.com/microsoft/winget-pkgs/blob/master/manifests/o/Obsidian/Obsidian/1.15.0/Obsidian.Obsidian.installer.yaml

**Vorbilder**

- [V1] VS Code: https://code.visualstudio.com/docs/setup/windows („Visual Studio Code is available for Windows through a user installer, a system installer, and a ZIP archive", „VS Code uses Inno Setup to create its Windows setup package. All Inno Setup command-line switches are available."), https://code.visualstudio.com/docs/setup/linux
- [V2] KeePassXC: https://keepassxc.org/docs/KeePassXC_GettingStarted („Portable and MSI Installer", „msiexec.exe /q /i KeePassXC-Y.Y.Y-WinZZ.msi AUTOSTARTPROGRAM=0", „DMG Installer, Homebrew Cask")

**Linux**

- [L1] nfpm: Konfiguration https://nfpm.goreleaser.com/docs/configuration/, Release 2.49.0 https://github.com/goreleaser/nfpm/releases/tag/v2.49.0
- [L2] Flatpak, Sandbox-Rechte: https://docs.flatpak.org/en/latest/sandbox-permissions.html („the following directories from host need to be explicitly requested with --filesystem and are not available with home, host, host-os, host-etc by default: … /tmp")
- [L3] Tauri: AppImage https://v2.tauri.app/distribute/appimage/, Flatpak https://v2.tauri.app/distribute/flatpak/
- [L4] Flathub-Anforderungen: https://docs.flathub.org/docs/for-app-authors/requirements („Binary or precompiled files must not be present in the submission pull request", „All source available submissions must be built entirely from source code")
- [L5] GTK 3, Wayland-App-ID aus dem Programmnamen: https://gitlab.gnome.org/GNOME/gtk/-/blob/gtk-3-24/gdk/wayland/gdkwindow-wayland.c (`app_id = g_get_prgname ();`); Wails `linux.Options.ProgramName` („used to set the program's name for the window manager via GTK's g_set_prgname()") https://github.com/wailsapp/wails/blob/v2.17.0/v2/pkg/options/linux/linux.go
- Paketnamen und Verfügbarkeit: in den Containern abgefragt (Anhang A.1), nicht aus Webseiten.

**macOS**

- [M1] Apple, Gatekeeper in macOS Sequoia: https://developer.apple.com/news/?id=saqachfa
- [M2] Apple, Notarisierung: https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution, https://developer.apple.com/documentation/security/customizing-the-notarization-workflow
- [M3] Apple Developer Program, Anmeldung: https://developer.apple.com/support/enrollment/
- [M4] Intune: https://learn.microsoft.com/en-us/intune/intune-service/apps/lob-apps-macos, https://learn.microsoft.com/en-us/intune/intune-service/apps/macos-unmanaged-pkg
- [M5] Homebrew: https://docs.brew.sh/Acceptable-Casks, https://docs.brew.sh/Package-Acceptance-Policy
- [M6] Homebrew 5.0.0: https://brew.sh/2025/11/12/homebrew-5.0.0/ („Casks without codesigning are deprecated.")
- [M7] Apple, Distribution-XML (`domains`): https://developer.apple.com/library/archive/documentation/DeveloperTools/Reference/DistributionDefinitionRef/Chapters/Distribution_XML_Ref.html

**Nicht belegt (Windows)**: der Lizenztext der WebView2-Laufzeit (nur im Dialog der Download-Seite); die Größe ihres eigenständigen Installers; ob sie auf Windows Server vorinstalliert ist; die Rückgabecodes des Bootstrappers; Intunes vorbelegte Rückgabecodes (nur in Dokumentation Dritter); wie DSM einen Code 3010 eines mit `ExecuteEx` gestarteten Programms behandelt.

## Anhang C: Prototyp des Setups (Inno Setup, geprüft)

Das auf Windows 11 geprüfte Skript (Anhang A.5). Übersetzt mit `ISCC.exe /DAppVersion=<productVersion> ldapilot.iss` neben `LDAPilot.exe` und `MicrosoftEdgeWebview2Setup.exe`. Für das Release fehlen noch: `uninsrestartdelete` an der Programmdatei (3.4), Signieren (`SignTool=`, Abschnitt 7) und die Programmänderung mit dem Mutex (3.10), ohne die die Prüfung auf ein laufendes Programm ins Leere geht.

```pascal
; LDAPilot setup, prototype for the installer concept (not part of the repository).
; One setup for both modes: per user (default, no admin rights) and per machine (/ALLUSERS).
#ifndef AppVersion
  #define AppVersion "0.5.0"
#endif
#define AppGuid "{2216036E-00F6-49B8-9C8F-D331676AFF43}"
#define UninstKey "Software\Microsoft\Windows\CurrentVersion\Uninstall\" + AppGuid + "_is1"
#define OldNsisKey "Software\Microsoft\Windows\CurrentVersion\Uninstall\David PicilloLDAPilot"
#define MsiMarkerKey "Software\LDAPilot\Installer"
#define Mutexes "LDAPilot.Running,Global\LDAPilot.Running"

[Setup]
AppId={{2216036E-00F6-49B8-9C8F-D331676AFF43}
AppName=LDAPilot
AppVersion={#AppVersion}
AppVerName=LDAPilot {#AppVersion}
AppPublisher=David Picillo
AppPublisherURL=https://github.com/DPicillo/LDAPilot
AppSupportURL=https://github.com/DPicillo/LDAPilot/issues
DefaultDirName={autopf}\LDAPilot
DisableProgramGroupPage=yes
DisableDirPage=auto
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog commandline
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputDir=out
OutputBaseFilename=LDAPilot-windows-amd64-installer
UninstallDisplayIcon={app}\LDAPilot.exe
UninstallDisplayName=LDAPilot
VersionInfoVersion={#AppVersion}.0
VersionInfoProductVersion={#AppVersion}.0
WizardStyle=modern
CloseApplications=no
RestartApplications=no
SetupLogging=yes
Compression=lzma2
SolidCompression=yes

[Languages]
Name: "en"; MessagesFile: "compiler:Default.isl"
Name: "de"; MessagesFile: "compiler:Languages\German.isl"

[Tasks]
Name: "startmenuicon"; Description: "Start menu shortcut"
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "MicrosoftEdgeWebview2Setup.exe"; Flags: dontcopy
Source: "LDAPilot.exe"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\LDAPilot"; Filename: "{app}\LDAPilot.exe"; Tasks: startmenuicon
Name: "{autodesktop}\LDAPilot"; Filename: "{app}\LDAPilot.exe"; Tasks: desktopicon

[Code]
const
  WV2 = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';

function WebView2Version(): String;
var
  v: String;
begin
  Result := '';
  if RegQueryStringValue(HKLM32, 'SOFTWARE\Microsoft\EdgeUpdate\Clients\' + WV2, 'pv', v) and (v <> '') and (v <> '0.0.0.0') then
    Result := v
  else if RegQueryStringValue(HKCU, 'Software\Microsoft\EdgeUpdate\Clients\' + WV2, 'pv', v) and (v <> '') and (v <> '0.0.0.0') then
    Result := v;
end;

{ Runs the bundled Evergreen bootstrapper; success is judged by the registry afterwards, not by its exit code. }
procedure InstallWebView2();
var
  rc: Integer;
begin
  ExtractTemporaryFile('MicrosoftEdgeWebview2Setup.exe');
  Log('WebView2 runtime missing; running the bootstrapper');
  if Exec(ExpandConstant('{tmp}\MicrosoftEdgeWebview2Setup.exe'), '/silent /install', '', SW_HIDE, ewWaitUntilTerminated, rc) then
    Log(Format('WebView2 bootstrapper exit code %d', [rc]))
  else
    Log('WebView2 bootstrapper could not be started');
end;

{ The NSIS setup of LDAPilot 0.5.0 (per machine only). Removed before a per-machine install. }
function RemoveOldNsisSetup(): String;
var
  s, dir, uninst: String;
  rc: Integer;
begin
  Result := '';
  if not RegQueryStringValue(HKLM64, '{#OldNsisKey}', 'UninstallString', s) then exit;
  uninst := RemoveQuotes(s);
  dir := ExtractFileDir(uninst);
  if not IsAdminInstallMode() then begin
    Log('LDAPilot 0.5.0 (NSIS) is installed for all users in ' + dir + '; it needs administrator rights to remove and stays');
    exit;
  end;
  Log('Removing LDAPilot 0.5.0 (NSIS) from ' + dir);
  if not Exec(uninst, '/S _?=' + dir, '', SW_HIDE, ewWaitUntilTerminated, rc) or (rc <> 0) then begin
    Result := Format('The previous LDAPilot setup in %s could not be removed (exit code %d).', [dir, rc]);
    exit;
  end;
  DeleteFile(uninst);
  RemoveDir(dir);
  RemoveDir(ExtractFileDir(dir));
  Log('LDAPilot 0.5.0 (NSIS) removed');
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  mode: String;
begin
  Result := '';
  if CheckForMutexes('{#Mutexes}') then begin
    Result := 'LDAPilot is running. Close it and run Setup again.';
    exit;
  end;
  if RegKeyExists(HKLM64, '{#MsiMarkerKey}') then begin
    Result := 'LDAPilot is installed from its MSI package on this computer. Use the MSI to update or remove it.';
    exit;
  end;
  if (not IsAdminInstallMode()) and RegKeyExists(HKLM64, '{#UninstKey}') then begin
    Result := 'LDAPilot is already installed for all users of this computer.';
    exit;
  end;
  mode := Lowercase(ExpandConstant('{param:WEBVIEW2|install}'));
  if WebView2Version() = '' then begin
    if mode = 'install' then InstallWebView2();
    if WebView2Version() <> '' then
      Log('WebView2 runtime now installed: ' + WebView2Version())
    else if mode = 'ignore' then
      Log('WebView2 runtime not found; continuing because of /WEBVIEW2=ignore')
    else begin
      Result := 'The Microsoft Edge WebView2 Runtime is not installed and could not be installed. ' +
        'Install it first (offline: MicrosoftEdgeWebView2RuntimeInstallerX64.exe /silent /install), or run Setup with /WEBVIEW2=ignore.';
      exit;
    end;
  end else
    Log('WebView2 runtime found: ' + WebView2Version());
  Result := RemoveOldNsisSetup();
end;

function InitializeUninstall(): Boolean;
begin
  Result := True;
  if CheckForMutexes('{#Mutexes}') then begin
    SuppressibleMsgBox('LDAPilot is running. Close it and run the uninstaller again.', mbError, MB_OK, IDOK);
    Result := False;
  end;
end;
```

## Anhang D: Linux-Dateien (geprüft)

So gebaut und geprüft wie in Anhang A.4. Für das Release fehlen noch die Korrekturen aus 4.4 (Copyright-Format, `libc6 (>= 2.34)`, Changelog) und der Eintrag `StartupWMClass=io.github.dpicillo.LDAPilot`, der die Programmänderung aus 4.8 voraussetzt; geprüft wurde mit `StartupWMClass=LDAPilot`. Das Paket für RHEL 9 entsteht aus derselben Datei mit der 4.0-Programmdatei, den Abhängigkeiten `libwebkit2gtk-4.0.so.37()(64bit)` und `libgtk-3.so.0()(64bit)` und `release: "1.el9"`.

**`nfpm.yaml`** (Aufruf: `VERSION=0.6.0 nfpm package -f nfpm.yaml -p deb` bzw. `-p rpm`):

```yaml
name: ldapilot
arch: amd64
platform: linux
version: ${VERSION}
release: "1"
section: net
priority: optional
maintainer: David Picillo <58555256+DPicillo@users.noreply.github.com>
vendor: David Picillo
homepage: https://github.com/DPicillo/LDAPilot
license: Apache-2.0
description: |-
  LDAP and Active Directory browser and administration tool
  Desktop browser and administration tool for Active Directory, Samba,
  OpenLDAP and 389 Directory Server.
contents:
  - src: ./bin/LDAPilot-linux-amd64-webkit2_41
    dst: /usr/bin/ldapilot
    file_info: {mode: 0755}
  - src: ./io.github.dpicillo.LDAPilot.desktop
    dst: /usr/share/applications/io.github.dpicillo.LDAPilot.desktop
  - src: ./io.github.dpicillo.LDAPilot.metainfo.xml
    dst: /usr/share/metainfo/io.github.dpicillo.LDAPilot.metainfo.xml
  - src: ./icons/48.png
    dst: /usr/share/icons/hicolor/48x48/apps/io.github.dpicillo.LDAPilot.png
  - src: ./icons/64.png
    dst: /usr/share/icons/hicolor/64x64/apps/io.github.dpicillo.LDAPilot.png
  - src: ./icons/128.png
    dst: /usr/share/icons/hicolor/128x128/apps/io.github.dpicillo.LDAPilot.png
  - src: ./icons/256.png
    dst: /usr/share/icons/hicolor/256x256/apps/io.github.dpicillo.LDAPilot.png
  - src: ./LICENSE
    dst: /usr/share/doc/ldapilot/copyright
    packager: deb
  - src: ./LICENSE
    dst: /usr/share/licenses/ldapilot/LICENSE
    packager: rpm
    type: license
overrides:
  deb:
    depends:
      - libwebkit2gtk-4.1-0
      - libgtk-3-0
  rpm:
    depends:
      - libwebkit2gtk-4.1.so.0()(64bit)
      - libgtk-3.so.0()(64bit)
```

**`io.github.dpicillo.LDAPilot.metainfo.xml`:**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<component type="desktop-application">
  <id>io.github.dpicillo.LDAPilot</id>
  <metadata_license>CC0-1.0</metadata_license>
  <project_license>Apache-2.0</project_license>
  <name>LDAPilot</name>
  <summary>Browse and manage LDAP and Active Directory directories</summary>
  <description>
    <p>LDAPilot is a desktop browser and administration tool for LDAP directories: Active Directory, Samba, OpenLDAP and 389 Directory Server.</p>
    <ul>
      <li>Directory tree, search, entry editor and LDIF import and export</li>
      <li>Account status, password resets and group membership</li>
      <li>TLS, Kerberos and NTLM binds</li>
    </ul>
  </description>
  <developer id="io.github.dpicillo">
    <name>David Picillo</name>
  </developer>
  <launchable type="desktop-id">io.github.dpicillo.LDAPilot.desktop</launchable>
  <url type="homepage">https://github.com/DPicillo/LDAPilot</url>
  <url type="bugtracker">https://github.com/DPicillo/LDAPilot/issues</url>
  <provides>
    <binary>ldapilot</binary>
  </provides>
  <screenshots>
    <screenshot type="default">
      <image>https://raw.githubusercontent.com/DPicillo/LDAPilot/master/assets/Browser.png</image>
      <caption>Directory tree and entry editor</caption>
    </screenshot>
  </screenshots>
  <content_rating type="oars-1.1"/>
  <releases>
    <release version="0.5.0" date="2026-11-01"/>
  </releases>
</component>
```

**`install.sh`** (im Archiv `LDAPilot-linux-amd64.tar.gz` neben beiden Programmdateien, dem Desktop-Eintrag, den AppStream-Daten, `icons/{48,64,128,256}.png` und `LICENSE`):

```sh
#!/bin/sh
# LDAPilot: install for the current user, without root.
#   ./install.sh              install or update into ~/.local
#   ./install.sh --uninstall  remove it again (settings in ~/.config/LDAPilot stay)
# Exit codes: 0 done, 2 wrong usage, 3 WebKitGTK missing.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
bin="${XDG_BIN_HOME:-$HOME/.local/bin}"
data="${XDG_DATA_HOME:-$HOME/.local/share}"
id=io.github.dpicillo.LDAPilot

case "${1:-}" in
--uninstall)
  rm -f "$bin/ldapilot" "$data/applications/$id.desktop" "$data/metainfo/$id.metainfo.xml"
  for s in 48 64 128 256; do rm -f "$data/icons/hicolor/${s}x${s}/apps/$id.png"; done
  echo "LDAPilot removed. Settings in ${XDG_CONFIG_HOME:-$HOME/.config}/LDAPilot were kept."
  exit 0 ;;
"") ;;
*) echo "usage: $0 [--uninstall]" >&2; exit 2 ;;
esac

has_lib() {
  for d in /usr/lib/x86_64-linux-gnu /usr/lib64 /usr/lib /lib/x86_64-linux-gnu /lib64; do
    [ -e "$d/$1" ] && return 0
  done
  return 1
}
if has_lib libwebkit2gtk-4.1.so.0; then variant=LDAPilot-linux-amd64-webkit2_41
elif has_lib libwebkit2gtk-4.0.so.37; then variant=LDAPilot-linux-amd64
else
  echo "WebKitGTK is not installed. Install libwebkit2gtk-4.1-0 (Debian, Ubuntu), webkit2gtk4.1 (Fedora, RHEL 10 with EPEL) or libwebkit2gtk-4_1-0 (openSUSE)." >&2
  exit 3
fi

install -D -m 755 "$here/$variant" "$bin/ldapilot"
mkdir -p "$data/applications"
sed "s|^Exec=.*|Exec=$bin/ldapilot|" "$here/$id.desktop" > "$data/applications/$id.desktop"
chmod 644 "$data/applications/$id.desktop"
install -D -m 644 "$here/$id.metainfo.xml" "$data/metainfo/$id.metainfo.xml"
for s in 48 64 128 256; do
  install -D -m 644 "$here/icons/$s.png" "$data/icons/hicolor/${s}x${s}/apps/$id.png"
done
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database -q "$data/applications" || true
echo "LDAPilot installed: $bin/ldapilot ($variant)"
```

## Anhang E: MSI (WiX v7, geprüft)

Auf Windows 11 gebaut und geprüft (Anhang A.5): `wix build -arch x64 -acceptEula wix7 -d Version=<productVersion> -o LDAPilot-windows-amd64.msi Package.wxs`, `wix msi validate -acceptEula wix7 …` ohne Befund.

Die Verknüpfungs-Komponenten haben je einen Wert unter HKCU als KeyPath, so verlangen es ICE38, ICE43 und ICE57 für Verknüpfungen. Bei einer Installation durch die Softwareverteilung landet dieser Wert im Profil des installierenden Kontos (SYSTEM); das ist harmlos und die übliche Form. Der Merker für das Setup liegt unter HKLM bei der Programmdatei.

```xml
<!-- LDAPilot MSI, prototype for the installer concept: per machine only, for software distribution. -->
<Wix xmlns="http://wixtoolset.org/schemas/v4/wxs">
  <Package Name="LDAPilot" Manufacturer="David Picillo" Version="$(var.Version)"
           UpgradeCode="47D44C40-C3AA-40A0-8C62-27CD33B9CF77" Scope="perMachine">
    <MajorUpgrade Schedule="afterInstallInitialize"
                  DowngradeErrorMessage="A newer version of LDAPilot is already installed." />
    <MediaTemplate EmbedCab="yes" />

    <Icon Id="AppIcon" SourceFile="LDAPilot.exe" />
    <Property Id="ARPPRODUCTICON" Value="AppIcon" />
    <Property Id="ARPURLINFOABOUT" Value="https://github.com/DPicillo/LDAPilot" />
    <Property Id="DESKTOPSHORTCUT" Value="0" Secure="yes" />

    <!-- One installation type per machine: refuse when the Inno setup installed LDAPilot for all users. -->
    <Property Id="LDAPILOT_SETUP">
      <RegistrySearch Root="HKLM" Bitness="always64" Type="raw" Name="DisplayVersion"
        Key="Software\Microsoft\Windows\CurrentVersion\Uninstall\{2216036E-00F6-49B8-9C8F-D331676AFF43}_is1" />
    </Property>
    <Launch Condition="Installed OR NOT LDAPILOT_SETUP"
            Message="LDAPilot is already installed with its setup program. Uninstall it first." />

    <StandardDirectory Id="ProgramFiles64Folder">
      <Directory Id="INSTALLFOLDER" Name="LDAPilot">
        <Component Id="AppExe">
          <File Id="LDAPilotExe" Source="LDAPilot.exe" KeyPath="yes" />
          <!-- Marker for the Inno setup: LDAPilot was installed by this MSI. -->
          <RegistryValue Root="HKLM" Key="Software\LDAPilot\Installer" Name="Type" Type="string" Value="msi" />
        </Component>
      </Directory>
    </StandardDirectory>

    <StandardDirectory Id="ProgramMenuFolder">
      <Component Id="StartMenuShortcut">
        <Shortcut Id="StartMenuLnk" Name="LDAPilot" Target="[INSTALLFOLDER]LDAPilot.exe" WorkingDirectory="INSTALLFOLDER" />
        <RegistryValue Root="HKCU" Key="Software\LDAPilot\Installer" Name="StartMenuShortcut" Type="integer" Value="1" KeyPath="yes" />
      </Component>
    </StandardDirectory>

    <StandardDirectory Id="DesktopFolder">
      <Component Id="DesktopShortcut" Condition="DESKTOPSHORTCUT = 1">
        <Shortcut Id="DesktopLnk" Name="LDAPilot" Target="[INSTALLFOLDER]LDAPilot.exe" WorkingDirectory="INSTALLFOLDER" />
        <RegistryValue Root="HKCU" Key="Software\LDAPilot\Installer" Name="DesktopShortcut" Type="integer" Value="1" KeyPath="yes" />
      </Component>
    </StandardDirectory>

    <Feature Id="Main" Title="LDAPilot">
      <ComponentRef Id="AppExe" />
      <ComponentRef Id="StartMenuShortcut" />
      <ComponentRef Id="DesktopShortcut" />
    </Feature>
  </Package>
</Wix>
```
