# Глоссарий перевода интерфейса (T86, T87)

Переводится только то, что пилот видит в приложении: строки (`apps/desktop/src/renderer/src/messages-<lang>.ts`), справка (`help-<lang>.ts`), тексты сценариев (`packages/scenarios/locales/<lang>.yaml`). ACARS-сообщения, FMS и телексы — всегда английский (docs/08, реш. 7).

Перевод делает `pnpm i18n translate` (`tools/i18n`): DeepL API с глоссарием из этого файла, запасной вариант — локальная модель Ollama. Инструмент читает два раздела ниже, поэтому их формат менять нельзя: список терминов в обратных кавычках и таблица с колонками `EN | DE | FR | ES | JA`. Остальной текст файла инструмент не читает.

Правила:
- Обращение вежливое: DE *Sie*, FR *vous*, ES *usted*, JA です・ます調.
- Испанский — европейский (`es-ES`, решение T86 п. 2).
- Подписи кнопок и настроек в справке берутся из строк интерфейса того же языка, а не переводятся заново (инструмент подставляет их сам).
- Перевод машинный, пока его не проверил носитель языка (решение T86 п. 1): в списке языков пометка «машинный перевод» (`machine: true` в `LANGUAGES`).

## Не переводятся

То, что пилот видит в FMS, в ACARS-сообщениях, в SimBrief и в названиях сервисов. Инструмент закрывает эти слова от перевода. Слова целиком в верхнем регистре (`REQ WX`, `EDDF`, `A320`, `OUT`), плейсхолдеры `{station}` и пути `%APPDATA%\…` он закрывает и без списка.

`ACARS` `ACARS Link` `CPDLC` `FMS` `MCDU` `EFB` `OFP` `SimBrief` `Hoppie` `logon code` `SayIntentions` `VATSIM` `IVAO` `VATSpy` `MSFS` `X-Plane` `X-Plane 12` `SimConnect` `GSX` `VDGS` `Fenix` `PMDG` `iniBuilds` `Navigraph` `OpenStreetMap` `OSM` `AeroDataBox` `RapidAPI` `NOAA` `EUROCONTROL` `ICAO` `IATA` `EOBT` `TOBT` `CTOT` `STD` `STA` `ETD` `ETA` `TOD` `OOOI` `METAR` `TAF` `ATIS` `NOTAM` `SIGMET` `PDC` `DCL` `CLD` `CLX` `RCL` `NAT` `XATC` `FIR` `OPS` `ATC` `MEL` `NOTOC` `WILCO` `UNABLE` `ROGER` `STANDBY` `HELP` `F-PLN` `Direct To` `step climb` `squawk` `Shanwick` `Windows` `JSON` `ZIP` `UTC`

## Термины

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

Происхождение таблицы (допущение, 2026-11-01): термины составил Claude по общепринятой авиационной терминологии этих языков (*clairance*, *déroutement*, *aérodrome de dégagement*, *Ausweichflughafen*, 管制承認, 代替空港, スポット). С конкретными документами (ICAO/EASA, JCAB, интерфейсы аддонов) таблица **не сверялась**. Поправки носителя языка вносятся сюда, затем `pnpm i18n translate` пересобирает переводы (решение T86 п. 1: пока проверки нет — пометка «машинный перевод»).
