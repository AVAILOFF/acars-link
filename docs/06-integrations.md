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
- **Проверено человеком** (MSFS 2024, Fenix A320, 2026-10-10, тестовый полёт EFHK–ENGM, запись `reference/recordings/20261010-FIN4E-EFHK-ENGM-tekva.jsonl`): после посадки FMS сбрасывает INIT (по словам пользователя — на всех самолётах), FLT NBR пропадает, и самолёт перестаёт забирать telex с Hoppie, хотя AOC FLT INIT сохраняет номер рейса. block_report (IN, 13:03:56Z) и welcome_turnaround (13:05:55Z) Hoppie принял (`sent`), но в AOC RCVD MSGS их не было; после повторного ввода `FIN4E` в INIT → FLT NBR оба пришли. Строка `ARRIVAL MSG` в AOC RCVD MSGS — собственное сообщение Fenix, не наше. CPDLC в Fenix есть (ATC COMM → ATC MENU, ATSU DLK): логон, `REQUEST FL360` → `CLIMB TO`, WILCO на PDC и на uplink, LOGOFF после HANDOVER работают; ответ STANDBY уходит как `STDBY` (баг станции — `07`, T38). После `HANDOVER @XNOS` (12:45Z, снижение) Fenix отправил LOGOFF старой станции, но логона на новую не было `[ПРОВЕРИТЬ]`, сам ли он логинился после первой передачи (12:16Z).
- Отправитель «авиакомпании» в оригинале: `OPS<номер рейса>`. Допустимость по правилам сети `[ПРИ РЕЛИЗЕ]` — вопрос владельцу Hoppie до публичного релиза (08, решение 9).

## CPDLC через Hoppie (T23)

Сверено 2026-10-09. Hoppie не разбирает CPDLC: это свободный текст в сообщении `cpdlc`, обрабатывают его клиенты (tech.html: «@» — переводы строк для показа). Формат пакета и фразы — из открытого кода и перехваченных пакетов. Код не копировался, взят только формат.
- Источники: FlyByWire A32NX `fbw-common/src/systems/datalink` (`AcarsConnector.ts`, `CpdlcMessage.ts`, `CpdlcMessageElements.ts`, `ATC.ts`; GPL-3.0); пакеты сети из YV E-Jet `Nasal/cpdlc/hoppie-driver.nas` и `hoppie-standalone` (MIT); руководство TopSky «Data Link Functions» v2.2 (2017); страница Hoppie ACARS ATC Client (`hoppie.nl/acars/prg/atc`).
- Пакет: `/data2/<min>/<mrn>/<ra>/<текст>`. `min` — счётчик отправителя, `mrn` — `min` сообщения, на которое ответ (пусто у первого), `ra` — `WU`, `AN`, `R`, `NE`, `Y`, `N`. FBW берёт текст как шестое поле `split('/')`, поэтому в тексте uplink нет `/`. `@` выделяет значение, `@_@` разделяет части строки.
- Логон: самолёт шлёт `/data2/n//Y/REQUEST LOGON` (так шлют A350/A380, T09). Станция отвечает `/data2/m/n/NE/LOGON ACCEPTED` и `CURRENT ATC UNIT@_@EDGG@_@LANGEN CTL` (океан — `… OCA`). Отказ — `UNABLE …` (FBW: UM9996/UM0). Передача: `HANDOVER @EDUU` (NE) — FBW шлёт LOGOFF старой станции и REQUEST LOGON новой. Конец связи — `LOGOFF` (NE).
- Позывные живых станций — 4 символа (TopSky: «four characters»): EDGG, EDYJ, LONC, EUWN. ROPS использует `X` + FIR (решение 2026-10-09, `07` T23).
- Опрос: по tech.html ждать первого сообщения должны клиенты самолётов; станция УВД ждёт логона, поэтому опрашивается с начала (те же 45–75 с, после HANDOVER — 20 с не дольше 3 мин).
- `[ПРОВЕРИТЬ]` человеком: показ в PMDG 777/737, Fenix, iniBuilds; автологон после HANDOVER у не-FBW самолётов.

## DCL/PDC через Hoppie (T24)

Сверено 2026-10-09. Реализация — `packages/core/src/atc/dcl.ts`, решения и допущения — `07`, T24.
- Запрос (RCD) — telex от самолёта: `REQUEST PREDEP CLEARANCE` / `<позывной> <тип> TO <назн.>` / `AT <вылет> STAND <x>` / `ATIS <буква>` (FBW `DclMessage.ts`, GPL-3.0, только формат; пример TopSky «ATIS PAPA» — буква словом).
- ARINC 623 DCL. Источники формата: AIP Singapore eSUP 2018/013 (`aim-sg.caas.gov.sg`), AIP Malaysia SUP 02/25 (`aip.caam.gov.my`): RCD, FSM (`FSM hhmm yymmdd WSSS` / `SIA123 RCD RECEIVED` / `REQUEST BEING PROCESSED` / `STANDBY`; `RCD REJECTED` / `REVERT TO VOICE PROCEDURES`; `CDA RECEIVED` / `CLEARANCE CONFIRMED`), CLD (`CLD hhmm yymmdd WSSS PDC 001` / `SIA123 CLRD TO WMKK OFF 02C VIA MASBO2A` / `SQUAWK 2201` / `NEXT FREQ 121.65 ATIS B`), CDA, тайминги (CLD в течение 5 мин, ответ пилота в течение 5 мин, запрос не раньше 20 мин до TOBT). Реальные CLD из эфира ACARS — образцы тестов `plane-watch/acars-parser` (`internal/parsers/pdc/*_test.go`, лицензия не указана, взят только формат) и `airframesio/acars-message-documentation` (`research/A3.md`): EDDF, EFHK, EGLL, EPWA, LSZH, VHHH, WSSS, VTBS, RKSI. На проводе Hoppie — как у TopSky (руководство «Data Link Functions» v2.2 и перехваченные пакеты сети): `/data2/n//NE/FSM … @CS@ RCD RECEIVED @REQUEST BEING PROCESSED @STANDBY`, `/data2/n//WU/CLD … PDC nnn @CS@ CLRD TO @DEST@ OFF @RWY@ VIA @SID@ SQUAWK @XXXX@ …`, ответ пилота `/data2/m/n/N/WILCO`.
- США: PDC идёт через хост авиакомпании, ответа пилота нет (TopSky 1.4; FAA JO 7110.113F, 2017-10-02: поля SID, Transition, Climb Out, CLIMB VIA, Maintain, Expected Altitude, Departure Frequency, Contact, Local Info; «Cleared as filed» в полях УВД не используется). Раскладка — реальный PDC Delta DAL2699 KMSP–KRDU от 2025-12-29 (`plane-watch/acars-parser`).
- `[ПРОВЕРИТЬ]` человеком: какие самолёты принимают DCL/PDC (FBW — страница DEPART REQ; PMDG, Fenix, iniBuilds), показ WU-кнопок у CLD.

## Океанический клиренс NAT (T27)

Сверено 2026-10-09.
- **Статус в NAT.** NAT OPS Bulletin 2023_001 rev 6 (ICAO EUR/NAT, 25 Feb 2026): клиренсы отменены (Oceanic Clearance Removal) везде, кроме **Shanwick** — он выдаёт клиренс после RCL «until further notice» (дата перехода — по NOTAM). RCL отправляют в Bodø, Gander, Santa Maria, Shanwick; New York East и Reykjavik его не требуют (Reykjavik отвечает, что RCL не нужен). Ответ районов без клиренса — `RCL RECEIVED BY [ANSP]` (точное слово после BY известно только из комментария на ops.group: «RCL received by Santa Maria»). Окна RCL до точки входа: Gander 90–60 мин, Shanwick 90–30, Santa Maria ≥ 40, Bodø ≥ 20. В RCL: OEP, ETO, Мах, эшелон, `MAX FL` свободным текстом (без MAX — запрошенный считается наибольшим).
- **Формат CLX и ошибки.** NAT OPS Bulletin 2020_001 rev 01 (14 Jun 2022), §4–12: `CLX hhmm yymmdd EGGX CLRNCE nnn` / `<позывной> CLRD TO <назн.> VIA <OEP>` / `NAT <буква>` или `RANDOM ROUTE` / точки / `FM <OEP>/<ETO> MNTN F<эшелон> M<мах>` / `ATC/ …` (LEVEL CHANGE, MACH CHANGE, ENTRY POINT CHANGE, ROUTE CHANGE, RECLEARANCE n) / `END OF MESSAGE`. Пример Shanwick в §12: маршрут без повторения OEP, до точки выхода. Сообщения: `RCL RECEIVED` + `IF NO CLEARANCE WITHIN 15 MINUTES CONTACT SHANWICK BY VOICE`; `RCL REJECTED` + `RCL SENT TOO EARLY` / `RCL RECEIVED TOO LATE REVERT TO VOICE PROCEDURES` / `REQUEST BEING PROCESSED AWAIT TRANSACTION COMPLETION` / `FLIGHT PLAN NOT HELD` / `INVALID <…> RESUBMIT YOUR REQUEST`; `RCL/CLA RECEIVED NEGOTIATION REQUIRED CONTACT SHANWICK BY VOICE`; `CLA RECEIVED CLEARANCE CONFIRMED END OF MESSAGE`; без CLA 10 мин — `CLEARANCE CANCELLED REVERT TO VOICE PROCEDURES` (§7.1, Shanwick). Эшелон в CLX — не разрешение на набор (§5.3). Координаты — как в FPL (Doc 4444, прил. 2, поле 15): `57N020W`, с минутами `5530N02000W`.
- **Hoppie.** FlyByWire `OclMessage.ts` (GPL-3.0, только формат): RCL — пакет `cpdlc` `/data2/<min>//N/OCEANIC REQUEST
<позывной> 
ENTRY POINT:<OEP>
AT:<hhmm>Z 
REQ:M.<мах> FL<эшелон>[
<свободный текст>]` станции, на которую самолёт залогинен (`atsu.currentStation()`). `ATS623.ts`: ответ принимается от той же станции, telex превращается в свободный текст UM169 с ожиданием ROGER; ответ с `TO <назначение>` закрывает обмен. Какие ещё самолёты шлют RCL через Hoppie — `[ПРОВЕРИТЬ]` человеком.
- **Треки.** natTrak (VATSIM, `https://nattrak.vatsim.net/api/tracks`): `[{identifier, active, last_routeing: "SUNOT 58/20 60/30 60/40 59/50 AVUTI", valid_from, valid_to, concorde, flight_levels: [34000, …], direction}]`, данные — из настоящих NOTAM с треками NAT (`TracksService.php`). Только активные треки. Лицензия кода и условия API не опубликованы — `[ПРИ РЕЛИЗЕ]`. FAA `notams.faa.gov/common/nat.html` из сети не открылся (403), FlightPlanDatabase `/nav/NATS` отдал пустой список. В OFP SimBrief есть поле `tracks` (у RCTP–RJBB пустое) — формат на реальном трансатлантическом OFP — `[ПРИ РЕЛИЗЕ]`.
- **Районы.** Первый океанический район после OEP — по `fir` SimBrief первой точки-координаты, иначе по VATSpy: EGGX, CZQX/CZQO (Gander), BIRD, ENOB, LPPO, KZWY/KZNY. Флаг `oceanic` VATSpy ненадёжен (у EGGX и CZQO он `0`). Коды `fir` SimBrief у океанических точек на реальном OFP — `[ПРИ РЕЛИЗЕ]`.

## Таблицы сквоков (T24)

Таблицы — `packages/core/src/atc/squawk/`, сгенерированы из источников (не править вручную).
- **EUROCONTROL CAL** (SSR Code Allocation List for the ICAO EUR Region), приложение к ICAO EUR Doc 023, версия 4.13 от 2026-03-04, `eurocontrol-icao-eur-cal-v4-13.xls` со страницы публикации; столбцы Series, From, To, PA, Unit, CIV/MIL, APP, Unit which assigned, A/R, Destination, Via, Protection, Remarks; лист PAs (участвующие области, CCAMS). Берутся строки `A`, CIV, ENR (557 строк). Условия повторного использования на сайте не указаны — `[ПРИ РЕЛИЗЕ]`.
- **FAA JO 7110.66H** NBCAP от 2024-05-06, TBL A-1 (зарезервированные коды) и TBL B-3 (блоки 23 ARTCC; `2600` = 2601–2677, базовый код обычно не выдаётся, 0000 — никогда). Public domain.
- **ICAO APAC eANP** Vol II, Part IV, Table ATM II-APAC-2 (стр. IV-28…IV-31, поправки до APAC-II 24/04, февраль 2026; документ июля 2026). Ячейки сняты программно по координатам текста PDF и сверены с изображениями страниц. Пункт 3.6: A1000 — conspicuity-код Mode S. © ICAO — `[ПРИ РЕЛИЗЕ]`.
- Специальные коды (не выдаются): 7500/7600/7700 и 2000/7000 — SERA.13005; 7501–7577, 7601–7607, 7701–7707, 1200, 0000, 7400, 7777 — NBCAP TBL A-1; 1000 — APAC 3.6 (решение пользователя: пока не выдавать).

## Запросы пилота и эшелоны (T25)

Сверено 2026-10-09. Реализация — `packages/core/src/atc/` (`requests.ts`, `levels.ts`, `performance.ts`, `route.ts`), решения и допущения — `07`, T25.
- Фразы: FBW A32NX `CpdlcMessageElements.ts`, `CpdlcMessage.ts`, `InputValidation*.ts` (GPL-3.0, только формат). В сети значения downlink без `@`: `REQUEST CLIMB TO FL390`, `REQUEST DESCEND TO 11000FT`, `REQUEST M.78` (FANS-A M.61–M.92), `REQUEST 280KT` (70–350 kt), `REQUEST DIRECT TO MADOG`. Ответы — FANS-A UM20/UM23/UM19/UM106/UM74 (WU), UM0 `UNABLE` (N) + причина свободным текстом (UM169): `DUE TO AIRSPACE RESTRICTION`, `DUE TO TRAFFIC` (тексты ATN B1 UM167/UM166, Doc 4444 Annex 5).
- Таблица эшелонов: SERA, Appendix 3 (Рег. (ЕС) 923/2012, EUR-Lex, повторное использование разрешено) = ICAO Annex 2, App. 3. Исключения: AIP Spain ENR 1.7-3, AMDT 403/26 от 19-FEB-26 (`aip.enaire.es`); AIP Portugal ENR 1.7.5 от 01 OCT 2026 (`ais.nav.pt`); AIC France A 06/20 (`sia.aviation-civile.gouv.fr`, UTA с 21.05.2020; ENR 1.3.5 и граница UTA `[ПРИ РЕЛИЗЕ]`); CAA NZ Part 91 amdt 12 (`aviation.govt.nz`). Италия (ENR 1.7) и метрические таблицы Китая/КНДР не получены — `[ПРИ РЕЛИЗЕ]`.
- SimBrief: `navlog[].track_mag`, `mora` (ft), `fir`, `fir_valid_levels` (футы через запятую, с учётом направления и ограничений трассы), `aircraft.equip` (поле 10a FPL, `W` = RVSM). Поля не описаны в публичной документации SimBrief — смысл установлен по реальному OFP RCTP–RJBB (2026-10-08).
- Потолок и VMO/MMO: EASA TCDS (`easa.europa.eu/en/downloads/…`): A.064 iss. 62, A.004 iss. 69, A.151 iss. 33, IM.A.120 iss. 29, IM.A.003 iss. 20.0, IM.A.115 iss. 30, IM.A.196 iss. 19; A.110 (A380) iss. 17 — без чисел. Скорость 250 kt ниже FL100 — 14 CFR 91.117 (применяется везде, допущение).
- `[ПРОВЕРИТЬ]` человеком: показ `UNABLE@_@DUE TO …` и WU-кнопок у ответов в FBW, PMDG, Fenix, iniBuilds.

## OurAirports (T24)

- `https://davidmegginson.github.io/ourairports-data/airport-frequencies.csv` (~1,3 МБ, обновляется ночью). Лицензия (ourairports.com/data, сверено 2026-10-09): «All data is released to the Public Domain, and comes with no guarantee of accuracy or fitness for use». Столбцы `id, airport_ref, airport_ident, type, description, frequency_mhz`; типы `DEL`, `CLD`, `GND`, `TWR`, `APP`, `DEP`, `ATIS` и др.
- Только частоты аэропорта вылета, при включённой станции ROPS; кэш 30 дней, после сбоя — через 10 мин, не более 3 попыток. Используются, когда у VATSIM нет живого диспетчера (NEXT FREQ / DPFRQ). Реализация — `packages/data-sources/src/ourairports.ts`.

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
| IVAO whazzup | онлайн ATC | `[ПРИ РЕЛИЗЕ]` | адаптера нет |
| NASA EONET v3 | стихийные события | нет | сверено 2026-10-08 (T13), ниже |
| natTrak (VATSIM) | треки NAT (T27) | нет | сверено 2026-10-09, выше; условия `[ПРИ РЕЛИЗЕ]` |
| TheSpaceDevs Launch Library 2.3.0 | пуски ракет (T28) | нет | 15 запросов/ч на IP, сверено 2026-10-09, ниже; лицензия данных `[ПРИ РЕЛИЗЕ]` |
| NOAA SWPC | космическая погода (шкалы R/S/G), прогноз сияния OVATION (T29) | нет | сверено 2026-10-09, ниже; лицензия `[ПРИ РЕЛИЗЕ]` |
| aviationweather.gov `isigmet` | SIGMET вулканического пепла (T29) | нет | сверено 2026-10-09, ниже |
| USGS earthquake feed | землетрясения у аэропорта назначения (T29) | нет | сверено 2026-10-09, ниже; условия `[ПРИ РЕЛИЗЕ]` |
| Nager.Date | праздники страны назначения (T29) | нет | только частное/некоммерческое использование, сверено 2026-10-09 |
| Jolpica F1 | результат Формулы-1 (T29) | нет | некоммерческое использование, CC BY-NC-SA 4.0, сверено 2026-10-09 |
| api-web.nhle.com | счета NHL (T29) | нет | без документации и условий (одобрено 2026-10-09) |
| NASA 5MCSE (бесселевы элементы) | затмения (T29), таблица в репозитории | — | «Permission is freely granted…» с указанием источника |
| Overpass API (OSM) | стоянки и гейты аэропорта (`aeroway=parking_position/gate`) | нет | T13, ниже; живой ответ `[ПРОВЕРИТЬ]` |
| VATSpy Data Project | границы FIR, префиксы позывных центров (ROPS, T23); FIR и страна аэропортов (T24) | нет | CC BY-SA 4.0, сверено 2026-10-09, ниже |
| OurAirports | частоты аэропорта вылета (DCL/PDC, T24); страна аэропорта назначения (T29) | нет | public domain, сверено 2026-10-09, выше |
| FAA NOTAM API | NOTAM | да | только через бэкенд |
| AeroDataBox (RapidAPI) | реальное расписание прилётов | да, платно | не используется: T30 отменена 2026-10-09 |
| OpenAI / Anthropic | оживление текста | да | только через бэкенд, см. CLAUDE.md инвариант 8 |

Все адаптеры: таймаут, кэш, graceful degradation (сценарий, которому не хватило данных, пропускается или использует фолбэк-шаблон).

### Реализация (T13)

Пакет `packages/data-sources` (`@acars/data-sources`): парсеры, `ExternalDataService` (расписание, кэш, деградация), без Node API (HTTP — через `HttpClient` той же формы, что у транспорта). Ответы проверены запросами 2026-10-08; урезанные фикстуры — `packages/data-sources/test/fixtures/` (VATSIM — без имён и CID, станции EDDF/KJFK/RJBB синтетические).

- **aviationweather.gov**: `GET https://aviationweather.gov/api/data/metar?ids=A,B&format=json` → `[{icaoId, obsTime (epoch с), rawOb, …}]`; `…/taf?…` → `[{icaoId, rawTAF, mostRecent, …}]`; **204** — данных нет. Лимит **100 запросов/мин**, просят свой User-Agent; METAR обычно раз в час, TAF раз в несколько часов. Из `rawOb` убираем `METAR `/`SPECI ` и флаг `$` (форматтер превратил бы его в `USD`).
- **VATSIM**: URL фида — из `https://status.vatsim.net/status.json` → `https://data.vatsim.net/v3/vatsim-data.json` (~1,5 МБ, обновляется раз в 15 с). `controllers[]`/`atis[]`: `callsign`, `frequency`, `facility` (0 OBS, 1 FSS, 2 DEL, 3 GND, 4 TWR, 5 APP, 6 CTR), `atis_code`. Берём DEL/GND/TWR/APP/ATIS на частотах 118–137 МГц (199.998 — «без частоты»); имена и CID не сохраняются. Аэропорт станции — по префиксу позывного: ICAO, IATA, для `K…` ICAO без `K` (`MCI_TWR`) `[ПРОВЕРИТЬ]` другие местные соглашения. `_` в позывных форматтер показывает как `-`.
- **EONET**: `GET https://eonet.gsfc.nasa.gov/api/v3/events?status=open&days=N&category=a,b` (категории через запятую — ИЛИ). Без `days` «открытых» событий тысячи (старые пожары), поэтому два запроса: `severeStorms,wildfires,earthquakes,manmade` за 30 дней и `volcanoes` за 365. Позиция — последняя геометрия; `Point` — `[lon, lat]`, `Polygon` — центр вершин.
- **Launch Library 2.3.0 (T28)**: `GET https://ll.thespacedevs.com/2.3.0/launches/?mode=normal&ordering=net&limit=100&net__gte=<ISO>&net__lte=<ISO>` → `{count, next, results: [{id, status: {id}, net, net_precision: {id}, window_start, window_end, rocket: {configuration: {full_name}}, mission: {name}, pad: {name, latitude, longitude, country: {alpha_3_code}, location: {name}}}]}`. Не `/launches/upcoming/`: в окно полёта входят и уже состоявшиеся пуски. Координаты площадки — только в `mode=normal` (в `list` нет `pad`), ~7 КБ на пуск. Без ключа — **15 запросов в час на IP** (страница thespacedevs.com/llapi; `GET /2.3.0/api-throttle/` → `your_request_limit: 15, limit_frequency_secs: 3600`), ключ — через Patreon (не используем). Справочники: `/2.3.0/config/launch_statuses/` (1 Go, 2 TBD, 3 Success, 4 Failure, 5 Hold, 6 In Flight, 7 Partial Failure, 8 TBC, 9 Payload Deployed), `/2.3.0/config/net_precisions/` (0 SEC, 1 MIN, 2 HR, 3 AM, 4 PM, 5 DAY, 6 WK, 7 M, …). Берём Go с точностью ≤ часа и состоявшиеся (3, 4, 6, 7, 9). Сервис: запрос в начале полёта и раз в час, кэш 30 мин, после ошибки (429) — через 15 мин; окно — от часа до начала полёта до «сейчас + блок-тайм OFP + 1 ч». Лицензия и условия использования данных на сайте не указаны — `[ПРИ РЕЛИЗЕ]` (`08`, решение 9). Фикстура — урезанный реальный ответ от 2026-10-09 (Nuri, Long March 12, Falcon 9).
- **Особые события (T29)**, все ответы сверены запросами 2026-10-09, фикстуры — урезанные реальные ответы:
  - NOAA SWPC `GET https://services.swpc.noaa.gov/products/noaa-scales.json` → ключи `-1` (максимум за сутки), `0` (текущие), `1`–`3` (сегодня и два дня): `{DateStamp, TimeStamp, R: {Scale, Text, MinorProb, MajorProb}, S: {Scale, Text, Prob}, G: {Scale, Text}}`; в прогнозе шкала есть только у G. Берём R, S, G из `0` и G из `1`, `2`. Тексты влияния — сокращённо по NOAA Space Weather Scales (редакция 2023-12-11). Публичной ленты ICAO SWX Advisory нет.
  - OVATION `GET https://services.swpc.noaa.gov/json/ovation_aurora_latest.json` (~0,9 МБ) → `{"Observation Time", "Forecast Time", coordinates: [[lon 0..359, lat, вероятность %]]}`, сетка 1°×1°, прогноз примерно на час. Сервис оставляет клетки (вероятность > 0), ближайшие к точкам маршрута (ломаная ядра, шаг ≤ 10 NM).
  - SIGMET VA `GET https://aviationweather.gov/api/data/isigmet?format=json&hazard=va` → `[{firId, seriesId, qualifier, base, top, validTimeFrom, validTimeTo (эпоха, с), geom: AREA|AREAS, coords}]`; прогнозные положения облака — отдельные записи (серия с `F`).
  - USGS `GET https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson` (обновление раз в минуту) → GeoJSON `features[{id, properties: {mag, place, time, type}, geometry: {coordinates: [lon, lat, глубина км]}}]`.
  - Страна аэропорта — OurAirports `airports.csv` (~12,7 МБ; `icao_code`, иначе 4-буквенный `ident`/`gps_code` → `iso_country`), кэш карты 30 дней. Праздники — Nager.Date `GET https://date.nager.at/api/v3/PublicHolidays/{год}/{CC}`; 204 — страна не поддерживается, 404 — неизвестный код; берём `global: true`.
  - Jolpica `GET https://api.jolpi.ca/ergast/f1/current/last/results.json` → `MRData.RaceTable.Races[0]`: `raceName`, `date`+`time` (старт), `Results[].position`, `Driver.code`, `Constructor.name`, `Time.millis` (время победителя; конец гонки = старт + millis).
  - NHL `GET https://api-web.nhle.com/v1/score/{YYYY-MM-DD}` (`/now` — 307, клиент редиректы запрещает) → `games[{id, gameType, startTimeUTC, gameState (FUT, PRE, LIVE, CRIT, FINAL, OFF), awayTeam/homeTeam {abbrev, score}, gameOutcome.lastPeriodType}]`. Даты — UTC-даты «12 ч назад» и «сейчас». Времени конца матча нет: ядро видит переход в FINAL/OFF между обновлениями.
  - Расписание (по группам из настроек, `startFlight(…, { special })`): NOAA и OVATION — раз в 30 мин (кэш 15), SIGMET — 15 мин (кэш 10), USGS и Jolpica — 30 мин (кэш 15), NHL — 15 мин (кэш 10), страна и праздники — раз за рейс (кэш 30 дней). Код — `spacewx.ts`, `sigmet.ts`, `quakes.ts`, `holidays.ts`, `sport.ts`.
- **Overpass**: `POST https://overpass-api.de/api/interpreter`, `data=[out:json][timeout:25];nw["aeroway"~"^(gate|parking_position)$"](around:4000,LAT,LON);out tags;`, берётся тег `ref` (`A12;A13` → два, `Gate 5` → `5`). Правила: < 10 000 запросов и < 1 ГБ в сутки. Во время T13 публичный сервер и зеркала отвечали 504/500 — **формат живого ответа `[ПРОВЕРИТЬ]`**, фикстура синтетическая.
- **Расписание** (`ExternalDataService` тикает от главного цикла приложения, своих таймеров нет): погода аэропортов OFP — при загрузке OFP и каждые 10 мин (+ аэропорт из `REQ WX` сразу); VATSIM — при старте и каждые 5 мин от набора до захода; EONET — при старте и раз в час; стоянки — один раз. Кэш: погода 5 мин, VATSIM 1 мин, EONET 30 мин, стоянки 30 дней; в приложении — файлы в `<userData>/cache` (значения проверяются при чтении). После сбоя — повтор через 2/2/15/10 мин, стоянки — не более 3 попыток за рейс. Один запрос на источник одновременно. Сбой источника — одна запись в ленте (`data_failed`), восстановление — `data_restored`; сообщения при этом идут по OFP.
- User-Agent: `ACARS-Sim/0.1 (flight simulator ACARS; personal use)`. Настройка «Живые данные» (по умолчанию включена); выключено — в сеть ходят только SimBrief и Hoppie.
- Не сделано в T13: IVAO (`[ПРИ РЕЛИЗЕ]`), FAA NOTAM. TheSpaceDevs — T28. AeroDataBox — не будет (T30 отменена).

### Границы FIR (T23)

- **VATSpy Data Project** (`github.com/vatsimnetwork/vatspy-data-project`), лицензия **CC BY-SA 4.0**, сверено 2026-10-09 (релиз v2610.1). Файлы: `https://raw.githubusercontent.com/vatsimnetwork/vatspy-data-project/master/Boundaries.geojson` (~2,2 МБ) и `…/VATSpy.dat` (~0,9 МБ).
- `Boundaries.geojson` — RFC 7946, у каждого объекта MultiPolygon и свойства `id` (FIR `EDGG`, сектор `EDGG-N`), `oceanic` (`"0"`/`"1"`), `label_lon`, `label_lat`, `region`, `division`. Полигоны разрезаны по антимеридиану (координат за ±180 и пролётов больше 180° нет). Некоторые `id` встречаются дважды (`KZNY`: суша и океан) — объединяются. FIR — только 4-буквенные `id` (одобрено, `07` T23). Среди них есть накладные области без аэропортов (`EGVV` Swanwick Military над Великобританией, `EDXX` FIS only над Германией) и подобласти (`EGTL` London TMA внутри `EGTT`). При перекрытии первыми идут области, которые `[Airports]` называет FIR аэропорта, затем берётся большая. В Австралии у VATSpy только секторы (`YGUN` и т. п.).
- `VATSpy.dat`: `[FIRs]` — строки `ICAO|NAME|CALLSIGN PREFIX|FIR BOUNDARY` (пустой префикс = ICAO), `[UIRs]` — `ID|NAME|FIR,FIR,…` (бывают секторы `EDGG-BAD`), `[Airports]` — `ICAO|NAME|LAT|LON|IATA/LID|FIR|IsPseudo` (FIR аэропорта по VATSIM, псевдозаписи `IsPseudo=1` не берём), `[Countries]` — `NAME|ПРЕФИКС|…`. Отсюда имена органов и FIR онлайн-центров VATSIM: самый длинный префикс из частей позывного до суффикса (`EDGG_DKB_CTR` → `EDGG_DKB` → EDGG, `LON_S_CTR` → `LON` → EGTT), UIR — все его FIR (`-` в id → `_` в позывном).
- В ядро и запись полёта уходят только FIR вдоль маршрута (точки маршрута через ≤ 10 NM) и центры, покрывающие их. VATSIM: CTR (facility 6) и FSS (1) на частотах 118–137 МГц. Загрузка — один раз за рейс при включённой станции, кэш 7 дней, после сбоя — через 10 мин, не более 3 попыток. Реализация — `packages/data-sources/src/vatspy.ts`, фикстура — `packages/data-sources/test/fixtures/` (урезанный реальный релиз, та же лицензия).
