# 06 — Интеграции

Всё помеченное `[ПРОВЕРИТЬ]` — по памяти или из реверса. Перед реализацией сверить с официальной документацией.

## Hoppie ACARS

Сверено с `https://www.hoppie.nl/acars/system/tech.html` 2026-10-08 (T09). Реализация — `packages/transport/src/hoppie/`.

- Endpoint: `https://www.hoppie.nl/acars/system/connect.html` — **https работает** (проверено запросом, ответ `error {invalid logon code}`). Документация показывает только http и пишет «subject to change». Используем https; http транспорт не принимает.
- Параметры: `logon` (личный код, ≥ 24 символов под хранение), `from`, `to`, `type`, `packet`. Для серверных типов (`poll`, `ping`) `to` игнорируется, но обязателен — шлём `SERVER`.
- Типы: `ping` (проверка связи, не помечает онлайн; в `packet` — список позывных → ответ, кто онлайн), `telex`, `poll`, `peek` (только для логгеров), `cpdlc`, `progress`, `position`, `posreq`, `datareq`; `inforeq` (metar/taf/… ) описан, но в списке типов не значится. В T09 используются `telex`, `poll` (и `ping` в протоколе).
- Ответ: `ok`, `ok {…}` или `error {причина}`. Poll: `ok {FROM type {packet}} {FROM type {packet}} …`; ping с позывными: `ok {CS1 CS2}`. Формальной грамматики в документации **нет** — разбор по ответам сервера и открытому клиенту `hoppie-connector` (Python), тесты в `packages/transport/test/protocol.test.ts`.
- **GET и POST** поддерживаются, можно смешивать. URL держать < 256 символов; длиннее — POST (`packet` в form-body). Транспорт выбирает сам.
- Жёсткого лимита длины telex **нет**; «килобайты — нереалистично». Ограничение задаёт профиль дисплея.
- **Этикет** (в транспорте, инвариант 6): poll каждые **45–75 с случайно**; после запроса, ждущего ответа, — ~**20 с** недолго (у нас ≤ 3 мин, `expectReply`); **не начинать poll, пока станция не отправила первое сообщение**; таймаут HTTP **15 с**, при таймауте poll — пропуск до следующего интервала, повтор отправки — через несколько секунд (у нас backoff 5 с × 2ⁿ ± 20 %, ≤ 5 мин, 6 попыток); не слать много сообщений за 2 с (у нас ≥ 2 с между любыми запросами, один запрос в полёте).
- **Лок позывного:** на тройку (logon, сеть, позывной), ставится каждым запросом, кроме `peek`/`ping`; TTL **100 с**, продлевается любым действием. Один logon может держать несколько позывных. Конфликт → `callsign already in use` (повтор через 110 с). То есть **лок распространяется на `from` telex** — станция `OPS{flight}` залочена на код пилота, пока идёт полёт.
- Неверный код → `error {invalid logon code}` / `illegal logon code` → транспорт в `halted`, очередь сохраняется.
- Формат позывного документация не определяет; принимаем `A–Z0–9`, 2–16 символов `[ПРОВЕРИТЬ]` максимальную длину (`OPSDLH123` — 9).
- **Проверено человеком** (MSFS 2024, iniBuilds A350-1000, 2026-10-08, `pnpm hoppie:telex`): telex от `OPSVPAII` на позывной `VPAII` (FLT NBR в INIT) дошёл примерно через 60 с — A350 сам опрашивает сервер примерно раз в минуту. Показ: MFD → ATC COM → MSG RECORD / ALL MSG / EXPAND, заголовок `1130Z FROM OPSVPAII`. Кнопка ATC MSG **не** загорается (это не CPDLC). Переносы `
` сохраняются, строки по 24 символа и линии `---`/`...` выводятся без обрезки; экран заметно шире 24 символов. **Запятая не отображается** (`THIS, T09` → `THIS  T09`) — учесть в профиле A350 (T15). Приём (INBOUND) проверен через CPDLC-логон: ATC COM → CONNECT → сеть VATSIM → NOTIFY на станцию `XOPS` (нужна позиция самолёта: без выставленных ADIRS — `NOTIF UNAVAIL: ACFT POS UNAVAIL`); poll станции вернул `cpdlc` от `VPAII` с пакетом `/data2/0//Y/REQUEST LOGON` (формат для T12). В A350 нет free-text telex наружу (в ATC COM только CPDLC) `[ПРОВЕРИТЬ]` в руководстве iniBuilds. Между `NOTIFIED AT 1136Z` и получением прошло до ~2,5 мин (получено 11:38:31 при poll каждые ~20 с) — причина не выяснена. Не проверено: длинный telex через POST, Fenix/FBW.
- **Проверено человеком** (MSFS 2024, iniBuilds A380, 2026-10-08): то же, что у A350 — telex от `OPSVPAII` в MFD → ATC COM → MSG RECORD / ALL MSG / EXPAND, заголовок `1145Z FROM OPSVPAII`, переносы и линии `---`/`...` целы, **запятая не отображается**. Без FLT NBR в FMS INIT самолёт сообщения не забирает (telex ждал на сервере и пришёл после ввода). Длинный telex (~260 символов текста, ушёл через POST) пришёл целиком, 11 строк по ≤ 24, перенос после `-` (`EDDF-`/`KJFK`) как в форматтере. Приём из A380 тем же путём, что у A350 (NOTIFY на `XOPS`): один poll вернул два `cpdlc` от `VPAII` — `/data2/1//Y/LOGOFF`, затем `/data2/0//Y/REQUEST LOGON`. LOGOFF, вероятно, — DISCONNECT ALL из прошлой сессии A350, ждавший на сервере (`[ПРОВЕРИТЬ]` порядок выдачи poll: похоже, от старых к новым). Номер после `/data2/` — счётчик сообщений самолёта (MIN), для T12.
- **Проверено человеком** (MSFS 2024, iniBuilds A380, 2026-10-08, вечер, после T14): позывной `VPAII` введён в FMS вручную, приложение (станция `OPSVIP`) за три запуска отправило telex, Hoppie их принял — но в MSG RECORD ничего не появилось. После **F-PLN REQUEST** (запрос плана в FMS INIT) пришли все сообщения сразу, включая отправленные в прошлых запусках. Вывод: самолёт не опрашивал сервер, пока не был сделан запрос плана; ручного ввода FLT NBR недостаточно `[ПРОВЕРИТЬ]` на втором полёте и в A350 (тот же софт iniBuilds). Следствия: (1) перед стартом рейса в приложении в A380 нужно сделать F-PLN REQUEST; (2) недоставленные telex хранятся на сервере Hoppie и придут пачкой, как только самолёт начнёт опрос, — удалить их нельзя.
- **Проверено человеком** (MSFS 2024, Fenix A320, 2026-10-08): telex от `XOPS` на `VPAII` — MCDU → AOC MSG DISPLAY, заголовок `XOPS TELEX`, Fenix сам разбивает на страницы (`1/2`, 7 строк текста на первой странице). Строка ровно в 24 символа (`TELEX FROM XOPS TO VPAII`) помещается, линия `---` на всю ширину, **запятая отображается** (в отличие от iniBuilds). Ответ из Fenix (AOC free text на `XOPS`) пришёл как `telex` от `VPAII` с пакетом `REQ-REFUEL` — приём telex пилота работает.
- Отправитель «авиакомпании» в оригинале: `OPS<номер рейса>`. Допустимость по правилам сети `[ПРОВЕРИТЬ]` — вопрос владельцу Hoppie до публичного релиза (08, решение 9).

## CPDLC через Hoppie (T23)

Сверено 2026-10-09. Hoppie не разбирает CPDLC: это свободный текст в сообщении `cpdlc`, обрабатывают его клиенты (tech.html: «@» — переводы строк для показа). Формат пакета и фразы — из открытого кода и перехваченных пакетов. Код не копировался, взят только формат.
- Источники: FlyByWire A32NX `fbw-common/src/systems/datalink` (`AcarsConnector.ts`, `CpdlcMessage.ts`, `CpdlcMessageElements.ts`, `ATC.ts`; GPL-3.0); пакеты сети из YV E-Jet `Nasal/cpdlc/hoppie-driver.nas` и `hoppie-standalone` (MIT); руководство TopSky «Data Link Functions» v2.2 (2017); страница Hoppie ACARS ATC Client (`hoppie.nl/acars/prg/atc`).
- Пакет: `/data2/<min>/<mrn>/<ra>/<текст>`. `min` — счётчик отправителя, `mrn` — `min` сообщения, на которое ответ (пусто у первого), `ra` — `WU`, `AN`, `R`, `NE`, `Y`, `N`. FBW берёт текст как шестое поле `split('/')`, поэтому в тексте uplink нет `/`. `@` выделяет значение, `@_@` разделяет части строки.
- Логон: самолёт шлёт `/data2/n//Y/REQUEST LOGON` (так шлют A350/A380, T09). Станция отвечает `/data2/m/n/NE/LOGON ACCEPTED` и `CURRENT ATC UNIT@_@EDGG@_@LANGEN CTL` (океан — `… OCA`). Отказ — `UNABLE …` (FBW: UM9996/UM0). Передача: `HANDOVER @EDUU` (NE) — FBW шлёт LOGOFF старой станции и REQUEST LOGON новой. Конец связи — `LOGOFF` (NE).
- Позывные живых станций — 4 символа (TopSky: «four characters»): EDGG, EDYJ, LONC, EUWN. ROPS использует `X` + FIR (решение 2026-10-09, `07` T23).
- Опрос: по tech.html ждать первого сообщения должны клиенты самолётов; станция УВД ждёт логона, поэтому опрашивается с начала (те же 45–75 с, после HANDOVER — 20 с не дольше 3 мин).
- `[ПРОВЕРИТЬ]` человеком: показ в PMDG 777/737, Fenix, iniBuilds; автологон после HANDOVER у не-FBW самолётов.

## SayIntentions ACARS

- Endpoint: `https://acars.sayintentions.ai/acars/system/connect.html` (Hoppie-совместимый). Логон — SI-код пользователя.
- Условия API и rate limit `[ПРОВЕРИТЬ]`.

## SimBrief

- `https://www.simbrief.com/api/xml.fetcher.php?userid=<pilot id>&json=v2` (или `username=`). **Формат — `json=v2`** (решение 2026-10-08, рекомендация Navigraph для новых проектов). Оригинал использовал `json=v2:1`; он не поддерживается.
- Проверено на реальном OFP (2026-10-08). Особенности `json=v2`:
  - все значения — **строки**, в т.ч. числа (`"182664"`, `".84"`); пустое значение — `""`;
  - времена — ISO UTC (`"2026-10-08T07:45:00Z"`), длительности — `"HH:MM:SS"`;
  - списки — всегда массивы: `alternate[]`, `navlog[]` (без обёртки `fix`), `origin.atis[]`;
  - `params.units` — `"kgs"` или `"lbs"`; веса и топливо в этих единицах, количества (`pax_count`) — нет;
  - `navlog[].distance` — длина плеча (сумма = `general.route_distance`); TOC/TOD — `ident: "TOC"/"TOD"`, `type: "ltlg"`; `stage` — `CLB/CRZ/DSC`;
  - `aircraft.equip_category` — категория турбулентности следа (`H` и т. п.).
- Поля и их маппинг — `packages/core/src/ofp/` (тип `Ofp`, `parseSimbriefOfp`). Ошибки формата — `OfpParseError` с путём поля.
- Тестовые примеры делаются `tools/anonymize-ofp.mjs` из сырых OFP в `reference/ofp/raw/` (в `.gitignore`). Сырые OFP не коммитить: в них id пилота и имена.

## MSFS / SimConnect

- MSFS SDK → SimConnect (C/C++ или managed .NET-обёртка `Microsoft.FlightSimulator.SimConnect`). MSFS 2024 — проверить совместимость SDK `[ПРОВЕРИТЬ]`.
- Подписка `SIMCONNECT_PERIOD_SECOND` на data definition. Системные события: `Pause`, `SimStart`, `SimStop`, `AircraftLoaded`.
- Мост: реконнект с backoff. WebSocket-сервер **только 127.0.0.1**. Протокол — JSON-сообщения `{type:"telemetry", data}` / `{type:"status"}`. Версия протокола в handshake (`hello`).
- Протокол v2 (T21): клиент просит `?protocol=2`. После этого он может слать `{type:"command",id,command,args}` из белого списка. Мост отвечает этому клиенту `{type:"ack",id,ok,error?,detail?}`. Клиент без запроса версии получает v1 без изменений. Подробно — `bridge/msfs/README.md`. Команды выдаёт ядро (`CoreOutput.commands`, `packages/core/src/sim/commands.ts`). Пока в белом списке только `ping`.
- Список SimVar — `03-architecture.md`.

## GSX VDGS (T22)

- Источник: FSDreamTeam, «VGDS Custom Messages System — Developer Manual», 2025-07-29. Поставляется с GSX Pro: `<Addon Manager>\couatl\GSX\SDK\Samples\VGDS\vgds_developer_manual.pdf`, рядом примеры `*.json` и редактор `GSX\VGDSEditor`. Сверено 2026-10-09 по установке пользователя (стандартный файл GSX `parkingServices\vgds_standard_messages.json` от 2026-05-29). Используется только формат файла для совместимости, файлы FSDreamTeam в репозиторий не копируются. Установленную версию GSX по файлам определить не удалось. По списку изменений на форуме функция есть с 3.4.6 (апрель 2025) — это вторичный источник.
- Механизм: GSX загружает все `*.json` из `%APPDATA%\Virtuali\GSX\VGDS\` в алфавитном порядке и перечитывает файл при изменении («на следующем цикле страниц»). Файл с ошибкой пропускается, на табло — «Custom ERROR».
- Заголовок: `type: "vgds_messages"`, `version: "1.0"`, `enabled`, необязательные `auto_cleanup`, `source`. Сообщение: `id`, `duration` (мс), `valid_from`/`valid_until` (ISO 8601, время симулятора), `conditions` (`airports`, `gates`, `aircraft_types`), `display.<тип>.pages[].lines[]`. Строка: текст, `{"red": …}`, `{"alternate": […], "duration"}`, `{"function": "showOnChock" | "showConnections" | "showPaxCargo"}`.
- Типы табло: small (SafeDock3) 4 символа, 5 строк, из них 2 видны на стоянке; narrow (SafeDock TS24) 6×6; wide (SafeDock TS42) 9×7; x (SafeDock X) 10×7. Собственные примеры руководства превышают эти лимиты; мы держимся таблицы.
- Не описано или расходится с руководством `[ПРОВЕРИТЬ]` человеком в симуляторе: набор символов; когда показывается своё сообщение относительно стандартных GSX и указаний по парковке; что видит табло, если для его типа нет варианта. В примерах и стандартном файле есть тип `flex`, цвет `green`, поля `overrides` (подмена стандартного сообщения, например `chock_and_gate_display`) и `data_source` — в руководстве их нет, мы их не используем.
- Реализация: ядро `packages/core/src/sim/vdgs.ts` (шаг `vdgs:`, команда `vdgs`), запись файла `apps/desktop/src/main/vdgs.ts`. Одобренные допущения — `07`, T22.

## Внешние данные

| Источник | Для чего | Ключ | Заметки |
|---|---|---|---|
| aviationweather.gov Data API | METAR/TAF | нет | сверено 2026-10-08 (T13), ниже |
| VATSIM data feed v3 | онлайн ATC | нет | сверено 2026-10-08 (T13), ниже |
| IVAO whazzup | онлайн ATC | `[ПРОВЕРИТЬ]` | |
| NASA EONET v3 | стихийные события | нет | сверено 2026-10-08 (T13), ниже |
| TheSpaceDevs LL 2.2.0 | пуски ракет | нет, жёсткий rate limit | кэшировать |
| Overpass API (OSM) | стоянки и гейты аэропорта (`aeroway=parking_position/gate`) | нет | T13, ниже; живой ответ `[ПРОВЕРИТЬ]` |
| VATSpy Data Project | границы FIR, префиксы позывных центров (ROPS, T23) | нет | CC BY-SA 4.0, сверено 2026-10-09, ниже |
| FAA NOTAM API | NOTAM | да | только через бэкенд |
| AeroDataBox (RapidAPI) | реальное расписание прилётов | да, платно | только через бэкенд, опционально |
| OpenAI / Anthropic | оживление текста | да | только через бэкенд, см. CLAUDE.md инвариант 8 |

Все адаптеры: таймаут, кэш, graceful degradation (сценарий, которому не хватило данных, пропускается или использует фолбэк-шаблон).

### Реализация (T13)

Пакет `packages/data-sources` (`@acars/data-sources`): парсеры, `ExternalDataService` (расписание, кэш, деградация), без Node API (HTTP — через `HttpClient` той же формы, что у транспорта). Ответы проверены запросами 2026-10-08; урезанные фикстуры — `packages/data-sources/test/fixtures/` (VATSIM — без имён и CID, станции EDDF/KJFK/RJBB синтетические).

- **aviationweather.gov**: `GET https://aviationweather.gov/api/data/metar?ids=A,B&format=json` → `[{icaoId, obsTime (epoch с), rawOb, …}]`; `…/taf?…` → `[{icaoId, rawTAF, mostRecent, …}]`; **204** — данных нет. Лимит **100 запросов/мин**, просят свой User-Agent; METAR обычно раз в час, TAF раз в несколько часов. Из `rawOb` убираем `METAR `/`SPECI ` и флаг `$` (форматтер превратил бы его в `USD`).
- **VATSIM**: URL фида — из `https://status.vatsim.net/status.json` → `https://data.vatsim.net/v3/vatsim-data.json` (~1,5 МБ, обновляется раз в 15 с). `controllers[]`/`atis[]`: `callsign`, `frequency`, `facility` (0 OBS, 1 FSS, 2 DEL, 3 GND, 4 TWR, 5 APP, 6 CTR), `atis_code`. Берём DEL/GND/TWR/APP/ATIS на частотах 118–137 МГц (199.998 — «без частоты»); имена и CID не сохраняются. Аэропорт станции — по префиксу позывного: ICAO, IATA, для `K…` ICAO без `K` (`MCI_TWR`) `[ПРОВЕРИТЬ]` другие местные соглашения. `_` в позывных форматтер показывает как `-`.
- **EONET**: `GET https://eonet.gsfc.nasa.gov/api/v3/events?status=open&days=N&category=a,b` (категории через запятую — ИЛИ). Без `days` «открытых» событий тысячи (старые пожары), поэтому два запроса: `severeStorms,wildfires,earthquakes,manmade` за 30 дней и `volcanoes` за 365. Позиция — последняя геометрия; `Point` — `[lon, lat]`, `Polygon` — центр вершин.
- **Overpass**: `POST https://overpass-api.de/api/interpreter`, `data=[out:json][timeout:25];nw["aeroway"~"^(gate|parking_position)$"](around:4000,LAT,LON);out tags;`, берётся тег `ref` (`A12;A13` → два, `Gate 5` → `5`). Правила: < 10 000 запросов и < 1 ГБ в сутки. Во время T13 публичный сервер и зеркала отвечали 504/500 — **формат живого ответа `[ПРОВЕРИТЬ]`**, фикстура синтетическая.
- **Расписание** (`ExternalDataService` тикает от главного цикла приложения, своих таймеров нет): погода аэропортов OFP — при загрузке OFP и каждые 10 мин (+ аэропорт из `REQ WX` сразу); VATSIM — при старте и каждые 5 мин от набора до захода; EONET — при старте и раз в час; стоянки — один раз. Кэш: погода 5 мин, VATSIM 1 мин, EONET 30 мин, стоянки 30 дней; в приложении — файлы в `<userData>/cache` (значения проверяются при чтении). После сбоя — повтор через 2/2/15/10 мин, стоянки — не более 3 попыток за рейс. Один запрос на источник одновременно. Сбой источника — одна запись в ленте (`data_failed`), восстановление — `data_restored`; сообщения при этом идут по OFP.
- User-Agent: `ACARS-Sim/0.1 (flight simulator ACARS; personal use)`. Настройка «Живые данные» (по умолчанию включена); выключено — в сеть ходят только SimBrief и Hoppie.
- Не сделано в T13: TheSpaceDevs (пуски), IVAO, FAA NOTAM, AeroDataBox.

### Границы FIR (T23)

- **VATSpy Data Project** (`github.com/vatsimnetwork/vatspy-data-project`), лицензия **CC BY-SA 4.0**, сверено 2026-10-09 (релиз v2610.1). Файлы: `https://raw.githubusercontent.com/vatsimnetwork/vatspy-data-project/master/Boundaries.geojson` (~2,2 МБ) и `…/VATSpy.dat` (~0,9 МБ).
- `Boundaries.geojson` — RFC 7946, у каждого объекта MultiPolygon и свойства `id` (FIR `EDGG`, сектор `EDGG-N`), `oceanic` (`"0"`/`"1"`), `label_lon`, `label_lat`, `region`, `division`. Полигоны разрезаны по антимеридиану (координат за ±180 и пролётов больше 180° нет). Некоторые `id` встречаются дважды (`KZNY`: суша и океан) — объединяются. FIR — только 4-буквенные `id` (одобрено, `07` T23). Среди них есть подобласти (`EGTL` London TMA внутри `EGTT`), при перекрытии берётся большая.
- `VATSpy.dat`: `[FIRs]` — строки `ICAO|NAME|CALLSIGN PREFIX|FIR BOUNDARY` (пустой префикс = ICAO), `[UIRs]` — `ID|NAME|FIR,FIR,…` (бывают секторы `EDGG-BAD`). Отсюда имена органов и FIR онлайн-центров VATSIM: самый длинный префикс из частей позывного до суффикса (`EDGG_DKB_CTR` → `EDGG_DKB` → EDGG, `LON_S_CTR` → `LON` → EGTT), UIR — все его FIR (`-` в id → `_` в позывном).
- В ядро и запись полёта уходят только FIR вдоль маршрута (точки маршрута через ≤ 10 NM) и центры, покрывающие их. VATSIM: CTR (facility 6) и FSS (1) на частотах 118–137 МГц. Загрузка — один раз за рейс при включённой станции, кэш 7 дней, после сбоя — через 10 мин, не более 3 попыток. Реализация — `packages/data-sources/src/vatspy.ts`, фикстура — `packages/data-sources/test/fixtures/` (урезанный реальный релиз, та же лицензия).
