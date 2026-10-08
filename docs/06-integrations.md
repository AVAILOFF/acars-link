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

- `https://www.simbrief.com/api/xml.fetcher.php?username=<user>&json=v2:1` (или `userid=`).
- Используемые поля оригиналом: `atc.callsign`, `general.flight_number`, `origin/destination.icao_code`, `origin.plan_rwy`, `origin.trans_alt`, `origin.atis.letter`, `aircraft.icao_code`, `weights.pax_weight/bag_weight`, `params.units`, `fuel.plan_ramp`, `times.sched_out/sched_in/est_out/est_in/taxi_out` (unix-секунды), `navlog.fix[]` (`ident`, `via_airway`, `pos_lat`, `pos_long`, `altitude_feet`…) `[ПРОВЕРИТЬ]` точные имена.
- Нормализовать в собственный тип `Ofp` с unit-тестами на сохранённых примерах JSON. Примеры не коммитить с реальными именами пилота.

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
