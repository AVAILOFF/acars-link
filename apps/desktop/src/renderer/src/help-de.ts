// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

/**
 * The "Help" tab in German (T86/T87): machine translation by `pnpm i18n translate` (tools/i18n,
 * glossary docs/glossary-i18n.md), not yet checked by a native speaker. Hand edits are kept on the next run.
 */

import type { HelpSection } from './help.js';

export const de: readonly HelpSection[] = [
  {
    id: 'start',
    title: 'Erste Schritte',
    items: [
      {
        id: 'what',
        q: 'Was bewirkt „ACARS Link“?',
        a: [
          'Es fungiert als Betriebszentrale Ihrer Airline. Während Sie fliegen, liest es die Simulator-Daten und Ihren SimBrief-Flugplan aus, verfolgt die jeweilige Flugphase und sendet über Hoppie ACARS ACARS-Nachrichten an das Cockpit: Loadsheets, Slot- und Gate-Informationen, Verspätungen, unvorhergesehene Ereignisse sowie die nächste Flugetappe. Sie können vom FMS des Flugzeugs aus antworten und Anfragen senden.',
          'ACARS-Nachrichten erfolgen stets in englischer Sprache, wie im realen Betrieb. Die Benutzeroberfläche der App ist in mehreren Sprachen verfügbar (Einstellungen → Sprache).',
        ],
      },
      {
        id: 'ui',
        q: 'Was befindet sich wo in der App',
        a: [
          {
            list: [
              'Nachrichten: die Nachrichten der Airline und Ihre Antworten, die Flugkarte (OFP laden, Flug starten und beenden) sowie der FMS-Bildschirm mit der ausgewählten Nachricht, wie sie im Cockpit angezeigt wird. Vor dem ersten Flug listet die Flugkarte auf, was noch fehlt, wobei neben jedem Punkt „Einrichten“ steht.',
              'Szenarien: Welche Nachrichten und Situationen können während eines Fluges auftreten und wie hoch ist deren Wahrscheinlichkeit?',
              'Einstellungen: Konten (SimBrief, Hoppie), Sprache, Art der Nachrichtenübermittlung; der Rest befindet sich unter „Erweiterte Einstellungen“.',
              'Hilfe: dieses Handbuch.',
            ],
          },
          'Die obere Leiste zeigt UTC, den Flug sowie den Status des Simulators (SIM), des Netzwerks (NET) und der XATC-Station (CPDLC) an. Die Statusleiste unten zeigt die Bridge, den Simulator und das Netzwerk an sowie die Punkte, die Ihre Aufmerksamkeit erfordern.',
          '„Willkommensbildschirm erneut anzeigen“ und „Tour durch die Benutzeroberfläche starten“ oben auf dieser Seite wiederholen die Einführung.',
        ],
      },
      {
        id: 'install',
        q: 'Windows warnt vor dem Installationsprogramm',
        a: [
          'Das Installationsprogramm ist nicht code-signiert, daher zeigt SmartScreen die Meldung „Windows hat Ihren PC geschützt“ an. Klicken Sie auf „Weitere Informationen“ und anschließend auf „Trotzdem ausführen“.',
        ],
      },
      {
        id: 'first',
        q: 'Erster Flug, Schritt für Schritt',
        a: [
          {
            list: [
              'Einstellungen → Konten: Geben Sie Ihren SimBrief-Benutzernamen ein und klicken Sie auf „Überprüfen“.',
              'Geben Sie Ihren Hoppie-logon code ein und klicken Sie auf „Speichern“. Noch keinen Code? Registrieren Sie sich bei Hoppie (Link unten); der Code wird per E-Mail zugeschickt. Ohne Code stellen Sie „Nachrichten senden über“ auf „Offline (nur in der App)“ ein: Nachrichten erscheinen dann nur in diesem Fenster.',
              'Erstellen Sie einen Flugplan in SimBrief und klicken Sie anschließend auf der Registerkarte „Nachrichten“ auf „OFP aus SimBrief laden“.',
              'Starten Sie MSFS oder X-Plane 12 und laden Sie das Flugzeug am Gate. Die installierte App startet die Simulator-Bridge selbst, und die Bridge erkennt den laufenden Simulator (Einstellungen → Verbindung → „Simulator“: „Automatisch“); in der Statusleiste werden „Sim-Bridge“ und „Simulator“ als „verbunden“ angezeigt, zusammen mit der Angabe, um welchen Simulator es sich handelt.',
              'Geben Sie im FMS/MCDU des Flugzeugs (Seite „INIT“ oder „ATC COMM“) die auf der Flugkarte angegebene Flugnummer ein und stellen Sie im Flugzeug eine Verbindung zu ACARS/Hoppie her.',
              'Drücken Sie „Flug starten“. Es werden Nachrichten von der Airline-Station gesendet, standardmäßig OPS + Flugnummer.',
            ],
            ordered: true,
          },
          {
            link: 'SimBrief-Dispatch',
            href: 'https://dispatch.simbrief.com/',
          },
          {
            link: 'Hoppie-ACARS-Registrierung',
            href: 'https://www.hoppie.nl/acars/system/register.html',
          },
        ],
      },
      {
        id: 'inibuilds',
        q: 'iniBuilds-A350/A380-Modelle empfangen keine Nachrichten',
        a: [
          'Diese Flugzeuge empfangen Telex-Nachrichten erst nach einem F-PLN-REQUEST (INIT REQUEST) im FMS. Führen Sie dies nach dem Laden des Fluges durch.',
        ],
      },
    ],
  },
  {
    id: 'flight',
    title: 'Während des Fluges',
    items: [
      {
        id: 'reply',
        q: 'Wie beantworte ich eine Nachricht?',
        a: [
          'Einige Nachrichten erfordern eine Entscheidung und listen die Optionen auf. Senden Sie vom Flugzeug-FMS aus ein Freitext-Telex an die Airline-Station, wobei die Option als erstes Wort stehen muss. Wenn „Nachrichtenhinweise“ aktiviert sind (Einstellungen), zeigt die Registerkarte „Nachrichten“ unterhalb des FMS-Bildschirms an, was die Nachricht bedeutet, welche Antworten erwartet werden und welche Antwort übernommen wird, falls Sie nicht antworten.',
          'Nachrichten, die auf eine Antwort warten, sind mit „Wartet auf Antwort“ gekennzeichnet; was Ihre Aktion erfordert, bleibt in der Statusleiste, bis es erledigt ist.',
        ],
      },
      {
        id: 'commands',
        q: 'Welche Befehle kann ich an die Airline senden?',
        a: [
          'Senden Sie diese als Freitext-Telex an die Station der Airline:',
          {
            list: [
              'HELP: Die Liste der Befehle, die OPS versteht.',
              'REQ WX [ICAO]: METAR (und TAF mit Live-Daten) eines Flughafens; leer bedeutet den Zielflughafen.',
              'REQ ATIS [ICAO]: das auf VATSIM aktive ATIS; falls nicht vorhanden, der aktuellste METAR.',
              'REQ NOTAM [ICAO]: Wesentliches NOTAM eines Flughafens des Flugplans (leer bedeutet den Zielflughafen), Stand zum Zeitpunkt der OFP-Freigabe.',
              'REQ GATE: das voraussichtliche Gate oder die Parkposition, das Gepäckband und die STA.',
              'REQ GATE CHANGE [Gate] [Grund]: Beantragung eines anderen Gates für die Ankunft.',
              'REQ LOADSHEET: das aktuellste Loadsheet des Fluges noch einmal.',
              'DELAY <MIN> <GRUND>: Melden Sie eine Abflug-Verspätung; OPS antwortet mit der neuen EOBT.',
              'ETA: voraussichtliche Ankunftszeit gemäß Flugplan, Gate und Umsteigepassagiere.',
              'RDY: Startbereit vor dem Slot (CTOT), an die Fließkontrolle weitergeleitet.',
              'DIVERT <ICAO>: Ausweichlandung; OPS warnt die Abfertigung vor Ort und fragt nach dem Grund.',
              'MEDICAL <text>: Ein medizinischer Notfall an Bord; OPS stellt eine Verbindung zu MedLink her.',
            ],
          },
          'Ohne das Flugzeug-FMS verwenden Sie „Anfrage der Airline…“ auf der Registerkarte „Nachrichten“: Die Anfrage wird an die simulierte Airline gesendet, als hätte Ihr Flugzeug sie gesendet, und die Antwort trifft wie gewohnt ein.',
        ],
      },
      {
        id: 'xatc',
        q: 'Was ist XATC?',
        a: [
          'Eine simulierte CPDLC-Station für Ihr eigenes Flugzeug, eine pro FIR (Einstellungen → XATC-Station (CPDLC)). Melden Sie sich bei X + dem FIR-Code an (EDGG → XDGG); an der FIR-Grenze werden Sie an die nächste Station übergeben. Fordern Sie am Boden die Abflugfreigabe (DCL / PDC) per Telex bei X + dem Abflughafen an (EDDF → XDDF). Hierfür werden Live-Daten benötigt. Bei aktivierter Option „Yield für Live-VATSIM-ATC“ gibt XATC den Vorrang ab, sobald ein echter Fluglotse in der FIR online ist.',
        ],
      },
      {
        id: 'sim-time',
        q: 'Zeitbeschleunigung, Pause und verspäteter Start',
        a: [
          'Nachrichten richten sich nach der Flugphase und nicht nach festen Zeitgebern, sodass Pausen und die Simulationsgeschwindigkeit die Reihenfolge nicht stören. Wenn Sie den Flug später als zum geplanten Abflug beginnen, gilt der Flug als mit Verspätung abgefertigt, und in den Dokumenten wird die neue Abflugzeit verwendet.',
          '„Simulationszeit“ (erweiterte Einstellungen) wird der Flug anhand der UTC-Uhr des Simulators statt anhand der PC-Uhr ausgeführt. Die Synchronisierung erfolgt einmalig zu Beginn des Fluges.',
        ],
      },
      {
        id: 'end',
        q: 'Was geschieht nach der Landung?',
        a: [
          'Am Stand fragt die Registerkarte „Nachrichten“, wie es weitergehen soll. „Nächste Etappe fliegen“ wartet auf die verbleibenden Nachrichten und lädt dann den nächsten OFP-Plan (diesen müssen Sie zuvor in SimBrief erstellen). „Keine Flüge mehr“ schließt den Flug, sobald die verbleibenden Nachrichten gesendet wurden; „Jetzt schließen“ schließt ihn sofort.',
          '„Flug beenden“ wird der Flug zu jedem beliebigen Zeitpunkt beendet; noch nicht gesendete Nachrichten werden verworfen.',
        ],
      },
    ],
  },
  {
    id: 'settings',
    title: 'Szenarien und Einstellungen',
    items: [
      {
        id: 'scenarios',
        q: 'Kann ich auswählen, welche Nachrichten angezeigt werden?',
        a: [
          'Ja, auf der Registerkarte „Szenarien“: Schalten Sie einzelne Szenarien oder ganze Kategorien ein und aus und ändern Sie die Wahrscheinlichkeit von Zufallsereignissen. Die Änderungen gelten ab dem nächsten Flug. Pilotenbefehle haben keine Schalter: Anfragen benötigen diese.',
          'Um eine bestimmte Art von Nachricht zu deaktivieren, geben Sie ein Wort daraus in das Suchfeld auf der Registerkarte „Szenarien“ ein: „CTOT“ findet die drei Szenarien mit Slot-Nachrichten. In der Nachrichtenliste ist der Betreff einer Nachricht der Name des zugehörigen Szenarios.',
        ],
      },
      {
        id: 'gap',
        q: 'Nachrichten werden gebündelt empfangen',
        a: [
          'Das Flugzeug ruft etwa einmal pro Minute Telex-Nachrichten ab, sodass häufiger gesendete Nachrichten gebündelt eintreffen. Der „Zeitabstand zwischen den Nachrichten“ (Einstellungen) sorgt für einen zeitlichen Abstand zwischen den Nachrichten; Antworten auf Ihre Anfragen werden immer zuerst angezeigt.',
        ],
      },
      {
        id: 'live',
        q: 'Was sind Live-Daten?',
        a: [
          'Echtzeit-Wetterdaten (METAR/TAF), VATSIM-Fluglotsen, Naturereignisse, Raketenstarts und andere in Nachrichten verwendete Ereignisse. Deaktivieren Sie diese („Live-Daten“), wenn das Datum im Simulator weit vom heutigen Tag entfernt ist. Wenn eine Quelle ausfällt, greifen die Nachrichten auf den Flugplan zurück.',
        ],
      },
      {
        id: 'secrets',
        q: 'Wo werden mein „logon code“ und meine Schlüssel gespeichert?',
        a: [
          'Verschlüsselt durch das Betriebssystem (Windows DPAPI). Sie werden nach dem Speichern nie wieder angezeigt und nicht in Aufzeichnungen oder Protokolle geschrieben. Mit „Entfernen“neben einem Feld können Sie sie entfernen.',
        ],
      },
      {
        id: 'memory',
        q: 'Was ist der „Airline-Speicher“?',
        a: [
          'Welche unregelmäßigen Ereignisse werden auf die nächsten Flüge übertragen: offene MEL-Punkte, Passagiere auf der Sperrliste, Ruhezeiten der Besatzung nach einer Verlängerung. Löschen Sie diese in den erweiterten Einstellungen.',
        ],
      },
      {
        id: 'records',
        q: 'Flugaufzeichnungen',
        a: [
          'Wenn „Flüge erfassen“ aktiviert ist, werden die Telemetriedaten und Nachrichten jedes Fluges in einer Datei gespeichert; die letzten 20 Flüge werden aufbewahrt. „Ordner „Aufzeichnungen“ öffnen“ zeigt diese an, was bei der Meldung eines Problems hilfreich ist.',
        ],
      },
      {
        id: 'logs',
        q: 'Protokolle und Diagnose',
        a: [
          'Die App speichert Protokolle über ihre eigene Funktionsweise sowie über die Simulator-Bridge im Ordner „logs“ neben den Einstellungen (%APPDATA%\\ACARS-Link\\logs): Starts, Verbindungen, Hoppie-Status und Fehler – fünf Dateien mit jeweils 5 MB. Ihr logon code, Ihre Schlüssel und Ihr SimBrief-Name werden durch *** ersetzt.',
          'Unter „Erweiterte Einstellungen“ → „Diagnose“ → „Exportieren…“ werden die Protokolle, Versionen und Einstellungen als eine ZIP-Datei gespeichert, die Sie einem Problembericht beifügen können. Die neueste Flugaufzeichnung wird nur hinzugefügt, wenn Sie diese Funktion aktivieren.',
        ],
      },
    ],
  },
  {
    id: 'trouble',
    title: 'Fehlerbehebung',
    items: [
      {
        id: 'no-msg',
        q: 'Nachrichten erreichen das Flugzeug nicht',
        a: [
          {
            list: [
              'Die Flugnummer im FMS muss exakt mit der Flugkarte übereinstimmen.',
              '„NET“ in der oberen Leiste sollte „Hoppie: OK“ anzeigen, nicht „Offline“.',
              'ACARS/Hoppie muss im Flugzeug aktiviert sein (in einigen Flugzeugen handelt es sich dabei um eine EFB- oder MCDU-Option mit einem eigenen Feld für den logon code).',
              'iniBuilds A350 / A380: Zunächst F-PLN REQUEST.',
              'Moment mal: Das Flugzeug ruft Telex-Nachrichten nach seinem eigenen Zeitplan ab.',
            ],
          },
        ],
      },
      {
        id: 'halted',
        q: '„Hoppie hat das Senden eingestellt“',
        a: [
          'Hoppie hat den logon code abgelehnt. Überprüfen Sie diesen in den Einstellungen (es handelt sich um den Code aus der Hoppie-E-Mail, nicht um Ihr Passwort), beenden Sie dann den Flug und starten Sie ihn erneut: Der laufende Flug behält den alten Code bei.',
        ],
      },
      {
        id: 'no-sim',
        q: 'Der Simulator zeigt „keine Brücke“ oder „disconnected“ an',
        a: [
          {
            list: [
              'Starten Sie MSFS und warten Sie, bis das Hauptmenü erscheint; die Bridge wird automatisch hergestellt.',
              'X-Plane 12: Die Einstellung „Simulator“ unter „Einstellungen“ muss auf „Automatisch“ oder „X-Plane 12“ eingestellt sein, X-Plane muss Version 12.1.1 oder höher sein, und unter „Einstellungen > Netzwerk“ in X-Plane muss eingehender Datenverkehr zugelassen sein. Der Simulator zeigt „verbunden“ an, sobald ein Flug geladen ist.',
              'Stellen Sie sicher, dass kein anderes Programm den Port unter „Sim-Bridge-Port“ (erweiterte Einstellungen) belegt. Die installierte App startet die Bridge neu, sobald sich der Port ändert. Die Meldung „Port belegt“ in der oberen Leiste bedeutet, dass ein anderes Programm (eine andere, manuell gestartete Bridge) den Port belegt: Schließen Sie dieses Programm oder ändern Sie den Port.',
              'Wenn die Bridge von selbst stoppt, startet die installierte App sie nach wenigen Sekunden erneut (eine Zeile in der Nachrichtenliste weist darauf hin, der Flug wird fortgesetzt). „Lässt sich nicht starten“ bedeutet, dass sie innerhalb von 5 Minuten sechsmal gestoppt wurde: Starten Sie die App neu oder ändern Sie den Bridge-Port und senden Sie die Diagnose (Einstellungen → Diagnose) mit der Fehlerbeschreibung.',
              'Die Bridge lauscht ausschließlich auf 127.0.0.1: Die App und der Simulator müssen auf demselben PC laufen.',
            ],
          },
        ],
      },
      {
        id: 'lost',
        q: '„Telemetrie verloren“ oder „Positionssprung“ in der Nachrichtenliste',
        a: [
          'Solange die Telemetrie unterbrochen ist (Simulator geschlossen, Ladebildschirm), werden Szenarien angehalten und fortgesetzt, sobald die Verbindung wiederhergestellt ist. Ein Positionssprung bedeutet eine Drehung oder einen Teleport; dies wird gemeldet, unterbricht den Flug jedoch nicht.',
        ],
      },
      {
        id: 'close',
        q: 'Kann ich das Fenster während eines Fluges schließen?',
        a: [
          'Ja. Die Aufzeichnung des Flugs erfolgt fortlaufend: Nach dem Schließen der App oder bei einem Absturz der App oder des PC bietet der nächste Start (innerhalb von 24 Stunden) die Möglichkeit, den Flug fortzusetzen – die Flugphase, die Nachrichtenliste und die erwarteten Antworten werden wiederhergestellt, und Nachrichten, die das Netzwerk nicht erreicht haben, werden erneut gesendet. Solange die App geschlossen ist, gehen keine Nachrichten im Flugzeug ein; die in der Zwischenzeit fälligen Nachrichten werden nach dem Neustart nacheinander angezeigt. Die App fragt vor dem Schließen weiterhin nach.',
        ],
      },
    ],
  },
];
