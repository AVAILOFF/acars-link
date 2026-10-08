# 06 — Интеграции

Всё помеченное `[ПРОВЕРИТЬ]` — по памяти или из реверса. Перед реализацией сверить с официальной документацией.

## Hoppie ACARS

- Endpoint: `http://www.hoppie.nl/acars/system/connect.html` (оригинал использует http). `[ПРОВЕРИТЬ]` наличие https.
- Параметры: `logon` (личный код пользователя, выдаётся на сайте Hoppie), `from`, `to`, `type`, `packet`.
- Типы: `ping`, `telex`, `poll`, `peek`, `cpdlc`, `progress`, `position`, `posreq`, `datareq` `[ПРОВЕРИТЬ]` полный список и семантику.
- Ответ: `ok …` или `error {…}`. Для poll — список `{FROM type {packet}}` `[ПРОВЕРИТЬ]` грамматику.
- **Этикет:** интервал poll — сверить с рекомендацией Hoppie `[ПРОВЕРИТЬ]` (принято ~45–75 с с рандомизацией). Не слать пачками. Очередь с rate limit, backoff на ошибках.
- Отправитель «авиакомпании» в оригинале: `OPS<номер рейса>`. Нужно проверить, допустимо ли это по правилам сети и не конфликтует ли с реальными станциями `[ПРОВЕРИТЬ]`.
- Максимальная длина telex `[ПРОВЕРИТЬ]`.
- POST vs GET: оригинал шлёт GET с текстом в query. Для длинных сообщений лучше POST, если поддерживается `[ПРОВЕРИТЬ]`.

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
