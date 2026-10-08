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
- **Проверено человеком** (MSFS 2024, iniBuilds A380, 2026-10-08): то же, что у A350 — telex от `OPSVPAII` в MFD → ATC COM → MSG RECORD / ALL MSG / EXPAND, заголовок `1145Z FROM OPSVPAII`, переносы и линии `---`/`...` целы, **запятая не отображается**. Без FLT NBR в FMS INIT самолёт сообщения не забирает (telex ждал на сервере и пришёл после ввода). Не проверено: приём из A380, длинный telex через POST.
- Отправитель «авиакомпании» в оригинале: `OPS<номер рейса>`. Допустимость по правилам сети `[ПРОВЕРИТЬ]` — вопрос владельцу Hoppie до публичного релиза (08, решение 9).

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
- Мост: реконнект с backoff. WebSocket-сервер **только 127.0.0.1**. Протокол — JSON-сообщения `{type:"telemetry", data}` / `{type:"status"}`. Версия протокола в handshake.
- Список SimVar — `03-architecture.md`.

## Внешние данные

| Источник | Для чего | Ключ | Заметки |
|---|---|---|---|
| aviationweather.gov Data API | METAR/TAF | нет | `[ПРОВЕРИТЬ]` текущие endpoints |
| VATSIM data feed v3 / `api.vatsim.net/v2/atc/online` | онлайн ATC | нет | |
| IVAO whazzup | онлайн ATC | `[ПРОВЕРИТЬ]` | |
| NASA EONET v3 | стихийные события | нет | оригинал фильтрует severeStorms, earthquakes, manmade, volcanoes, wildfires |
| TheSpaceDevs LL 2.2.0 | пуски ракет | нет, жёсткий rate limit | кэшировать |
| Overpass API (OSM) | стоянки и гейты аэропорта (`aeroway=parking_position/gate`) | нет | кэшировать, уважать лимиты |
| FAA NOTAM API | NOTAM | да | только через бэкенд |
| AeroDataBox (RapidAPI) | реальное расписание прилётов | да, платно | только через бэкенд, опционально |
| OpenAI / Anthropic | оживление текста | да | только через бэкенд, см. CLAUDE.md инвариант 8 |

Все адаптеры: таймаут, кэш, graceful degradation (сценарий, которому не хватило данных, пропускается или использует фолбэк-шаблон).
