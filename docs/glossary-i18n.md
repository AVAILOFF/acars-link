# Interface translation glossary (T86, T87)

Only what the pilot sees in the app is translated: strings (`apps/desktop/src/renderer/src/messages-<lang>.ts`), help (`help-<lang>.ts`), scenario texts (`packages/scenarios/locales/<lang>.yaml`). ACARS messages, FMS and telexes are always English (docs/08, decision 7).

Translation is done by `pnpm i18n translate` (`tools/i18n`): the DeepL API with the glossary from this file, with a local Ollama model as a fallback. The tool reads the two sections below, so their format must not change: a list of terms in backticks and a table with the columns `EN | DE | FR | ES | JA`. The tool does not read the rest of the file.

Rules:
- Polite form of address: DE *Sie*, FR *vous*, ES *usted*, JA です・ます調.
- Spanish is European (`es-ES`, T86 decision 2).
- Button and setting labels in the help are taken from the interface strings of the same language, not translated again (the tool substitutes them itself).
- The translation is machine-made until a native speaker has checked it (T86 decision 1): the language list carries a "machine translation" mark (`machine: true` in `LANGUAGES`).

## Do not translate

What the pilot sees in the FMS, in ACARS messages, in SimBrief and in service names. The tool protects these words from translation. Fully upper-case words (`REQ WX`, `EDDF`, `A320`, `OUT`), `{station}` placeholders and `%APPDATA%\…` paths it protects even without the list.

`ACARS` `ACARS Link` `CPDLC` `FMS` `MCDU` `EFB` `OFP` `SimBrief` `Hoppie` `logon code` `SayIntentions` `VATSIM` `IVAO` `VATSpy` `MSFS` `X-Plane` `X-Plane 12` `SimConnect` `GSX` `VDGS` `Fenix` `PMDG` `iniBuilds` `Navigraph` `OpenStreetMap` `OSM` `AeroDataBox` `RapidAPI` `NOAA` `EUROCONTROL` `ICAO` `IATA` `EOBT` `TOBT` `CTOT` `STD` `STA` `ETD` `ETA` `TOD` `OOOI` `METAR` `TAF` `ATIS` `NOTAM` `SIGMET` `PDC` `DCL` `CLD` `CLX` `RCL` `NAT` `XATC` `FIR` `OPS` `ATC` `MEL` `NOTOC` `WILCO` `UNABLE` `ROGER` `STANDBY` `HELP` `F-PLN` `Direct To` `step climb` `squawk` `Shanwick` `Windows` `JSON` `ZIP` `UTC`

## Terms

| EN | DE | FR | ES | JA |
|---|---|---|---|---|
| airline | Airline | compagnie aérienne | aerolínea | 航空会社 |
| alternate | Ausweichflughafen | aérodrome de dégagement | aeropuerto alternativo | 代替空港 |
| arrival | Ankunft | arrivée | llegada | 到着 |
| baggage belt | Gepäckband | tapis à bagages | cinta de equipajes | 手荷物受取所 |
| bridge | Bridge | passerelle | puente | ブリッジ |
| captain | Kapitän | commandant de bord | comandante | 機長 |
| clearance | Freigabe | clairance | autorización | 管制承認 |
| connecting flight | Anschlussflug | vol en correspondance | vuelo de conexión | 乗り継ぎ便 |
| crew | Besatzung | équipage | tripulación | 乗務員 |
| delay | Verspätung | retard | retraso | 遅延 |
| departure | Abflug | départ | salida | 出発 |
| destination | Zielflughafen | destination | destino | 目的地 |
| dispatch | Dispatch | régulation des vols | despacho de vuelos | 運航管理 |
| dispatcher | Dispatcher | régulateur | despachador | 運航管理者 |
| diversion | Ausweichlandung | déroutement | desvío | ダイバート |
| feed | Nachrichtenliste | fil des messages | lista de mensajes | メッセージ一覧 |
| flight phase | Flugphase | phase de vol | fase de vuelo | 飛行フェーズ |
| flight plan | Flugplan | plan de vol | plan de vuelo | 飛行計画 |
| free-text telex | Freitext-Telex | télex en texte libre | télex de texto libre | 自由文テレックス |
| fuel | Kraftstoff | carburant | combustible | 燃料 |
| gate | Gate | porte | puerta | ゲート |
| ground handling | Bodenabfertigung | assistance en escale | asistencia en tierra | グランドハンドリング |
| handling | Abfertigung | assistance | handling | ハンドリング |
| holding | Warteschleife | attente | espera | ホールディング |
| live data | Live-Daten | données en direct | datos en vivo | ライブデータ |
| loadsheet | Loadsheet | devis de masse et centrage | hoja de carga | ロードシート |
| logbook | Flugbuch | carnet de vol | libro de vuelo | ログブック |
| message | Nachricht | message | mensaje | メッセージ |
| messages | Nachrichten | messages | mensajes | メッセージ |
| maintenance | Wartung | maintenance | mantenimiento | 整備 |
| message hints | Nachrichtenhinweise | aides aux messages | ayudas de mensajes | メッセージのヒント |
| offline | Offline | hors ligne | sin conexión | オフライン |
| passenger | Passagier | passager | pasajero | 乗客 |
| pilot command | Pilotenbefehl | commande pilote | comando del piloto | パイロットコマンド |
| pushback | Pushback | repoussage | remolque hacia atrás | プッシュバック |
| recording | Aufzeichnung | enregistrement | grabación | 記録 |
| runway | Piste | piste | pista | 滑走路 |
| scenario | Szenario | scénario | escenario | シナリオ |
| simulator | Simulator | simulateur | simulador | シミュレーター |
| stand | Parkposition | poste de stationnement | puesto de estacionamiento | スポット |
| telex | Telex | télex | télex | テレックス |
| turnaround | Turnaround | rotation | rotación | ターンアラウンド |
| weather | Wetter | météo | meteorología | 気象 |

Origin of the table (assumption, 2026-11-01): the terms were compiled by Claude from the common aviation terminology of these languages (*clairance*, *déroutement*, *aérodrome de dégagement*, *Ausweichflughafen*, 管制承認, 代替空港, スポット). The table was **not checked** against specific documents (ICAO/EASA, JCAB, add-on interfaces). A native speaker's corrections go here, then `pnpm i18n translate` rebuilds the translations (T86 decision 1: until there is a check, the "machine translation" mark stays).
