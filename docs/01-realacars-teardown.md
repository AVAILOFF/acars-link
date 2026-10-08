# 01 — Разбор RealAcars 7.3.2

Статический анализ установленной копии `C:\Users\avail\AppData\Local\RealAcars` (2026-10-07). Приложение не запускалось. Исходники восстановлены из source map, встроенного в `app.asar` (см. `tools/extract-asar-sources.js`). **Это справка для идей. Код не копировать** (см. CLAUDE.md, инвариант 1).

## 1. Компоненты

| Файл | Что это |
|---|---|
| `Update.exe`, `packages/RealAcars-7.3.2-full.nupkg`, `RELEASES` | Squirrel.Windows: установка, обновление, ярлыки |
| `app-7.3.2/RealAcars.exe` | Electron 23, сборка electron-forge 6 + webpack |
| `resources/app.asar` | Приложение: React 18, react-router (HashRouter), Bootstrap/Grommet, axios |
| `resources/realacarssimconnect.exe` | C++ x64, SimConnect + HTTP-сервер на **Crow**. PDB-путь `C:\Users\Admin\source\repos\realacarssimconnect\` |

Восстановленные исходники (31 файл, ~12 тыс. строк):

```
src/renderer/components/
  Application.tsx           роутинг, провайдеры, фейковая загрузка 8 с
  hoppielogic.tsx           6314 строк — ВСЯ бизнес-логика
  simdatacontext.tsx        GET localhost:36427/simdata
  simbriefdatafetcher.tsx   загрузка OFP
  PresetContext.tsx         пресеты настроек в localStorage
  latlongcomparer.tsx       поиск стартовых площадок рядом с маршрутом
  navbar.tsx, *Modal.tsx    UI
src/pages/
  FlightInitalizationPage   старт/стоп полёта, проверка версии, клиренс на сервер автора
  OFPSettingsPage           какие сообщения слать, тайминги
  AirlineCommsPage, ServiceCommsPage, RandomMessagingPage, GeneralSettingsPage
```

## 2. Поток данных

```
MSFS ──SimConnect──> realacarssimconnect.exe ──HTTP :36427 /simdata (JSON)──┐
                                                                              v
SimBrief API ──OFP JSON──────────────────────────────────────────> Renderer (React)
                                                                    │  таймеры + флаги
                                                                    v
                                     Hoppie / SayIntentions  <── GET connect.html?type=telex
                                     87.106.57.67:*          <── POST JSON (клиренс, step climb…)
                                     OpenAI, RapidAPI, NASA, VATSIM, TheSpaceDevs, Overpass
```

1. Главный процесс запускает мост как дочерний процесс, открывает окно без рамки 1200×600, при закрытии убивает мост.
2. Мост подключается к MSFS (ретрай каждые 5 с) и отдаёт JSON по `/simdata`. Поля: `latitude_decimal`, `longitude…`, `altitude`, `isOnGround`, `isEngineRunning`, `eng_combustion1/2`, `totalFuelMassKg`. Читаемые SimVar: `PLANE ALTITUDE`, `PLANE LATITUDE`, `PLANE LONGITUDE`, `SIM ON GROUND`, `GENERAL ENG COMBUSTION:1/2`, `TURB ENG ITT:1/2`, `ENG N2 RPM:1/2`, `FUEL TOTAL QUANTITY WEIGHT`. Слушает на `0.0.0.0` (видно в LAN).
3. Renderer получает OFP SimBrief: `https://www.simbrief.com/api/xml.fetcher.php?username=<user>&json=v2:1`.
4. Нажатие «старт» → логон `type=ping` в Hoppie → планирование сообщений через `setTimeout` + главный цикл `setInterval` 30 с (опрос телеметрии, проверки дистанций).
5. Отправитель: `OPS<flight_number>` из OFP. Получатель: `atc.callsign` из OFP. Тип: всегда `telex`.

## 3. Каталог сообщений и триггеры оригинала

Расстояния — до точки TOD из навлога SimBrief, в морских милях (гаверсинус, R = 3440.065).

| Сообщение | Триггер | Источник данных |
|---|---|---|
| Preliminary Loadsheet | Custom: N мин после старта. Realistic: `sched_out − 25 мин` | OFP; вес рандомизируется (±5 пакс при p=0.5, ±200 кг груза при p=0.5) |
| TO Report (данные на взлёт) | через 5 мин после prelim | OFP, QNH, bleed/thrust |
| Final Loadsheet | `sched_out − 7 мин`; для heavy — после запуска двигателей | OFP + скорректированный ZFW/TOW |
| Fuel Slip | стабилизация топлива после заправки (проверка раз в 35 с, допуск 100 кг, 2 стабильных замера) | телеметрия |
| Slot Notification | 2 мин после логона | расчёт задержки |
| Crew change | ≤100 nm до TOD | списки имён по странам |
| A/C change, Next leg change, Comp. difficulties, Funny msg | случайная задержка в окне между est_out и est_in | OFP; Comp. difficulties — **OpenAI gpt-3.5-turbo** |
| LA Report (данные на посадку) | ≤150 nm до TOD | OFP |
| Expected gate | ≤135 nm до TOD | Overpass (OSM) стоянки + **OpenAI** выбирает стоянку под тип ВС |
| Arrival schedule | ≤120 nm до TOD | AeroDataBox (RapidAPI) |
| VATSIM ATC online | ≤80 nm до TOD | `api.vatsim.net/v2/atc/online` |
| Natural event | близость к событию EONET | NASA EONET |
| Space launch | близость путевой точки к стартовой площадке и окно пуска | TheSpaceDevs |
| OBT log (блок-время) | события двигатели/отрыв/посадка/выкл. | телеметрия |
| Arr OBT | ≤5 nm до аэропорта назначения | телеметрия |
| «ROPS»: клиренс | ≤20 nm до TOD → POST на сервер автора | OFP (ВПП, STAR) |
| «ROPS»: step climb | пересечение эшелонов (23500/28500 ft) → POST на сервер автора | OFP |

Форматирование: ширина под тип ВС (B77x +3 символа, B78x +6, остальное базовая), строки из точек и дефисов, верхний регистр.

## 4. Сервер автора (87.106.57.67, plain HTTP)

| Порт | Назначение (по коду) | Payload |
|---|---|---|
| 12345 | клиренс на вылет | Departure, Arrival, Runway, InitClimb, SID, ATIS, ROPSEnabled + заголовок FlightNumber |
| 5070 | disconnect | Callsign |
| 8050 | высота | Callsign, Altitude |
| 9090 | клиренс на прилёт | Callsign, Runway, STAR |
| 5000 | путевые точки | callsign, waypoints[] |
| 5050 | step climb | callsign, ident, flightLevel |
| 8888 | logoff | callsign, logoff: true |
| realacars.cloud:8080/version | проверка версии | — |

Предположительно сервер сам отвечает пилоту через Hoppie от имени «станции» (CPDLC-подобно). Не проверено.

## 5. Найденные проблемы (чего не повторять)

- Ключи OpenAI и RapidAPI захардкожены в клиенте.
- При выборе SayIntentions логон идёт с захардкоженными чужими данными, а не с SI ID пользователя.
- Вся бизнес-логика — в одном React-компоненте на 6300 строк, на `setTimeout`/`setInterval` и `useState`-флагах. Гонки (комментарий автора: значение времени запуска двигателей «всегда 0»). Эффекты пересоздают интервалы при смене зависимостей.
- Фаза полёта не моделируется — только «расстояние до TOD» и пороги высоты.
- Сообщения только в одну сторону: нет poll, пилот не может ответить или запросить.
- Копипаста: `formatDate`/`getZuluTime` определены десятки раз.
- `appVersion = '1.0.0.0'` при версии 7.3.2 → окно обновления всегда.
- `webSecurity: false`, `allowRunningInsecureContent: true`, внешний скрипт Font Awesome с CDN.
- Мост слушает `0.0.0.0`. Связь с сервером автора по HTTP без аутентификации.
- `Math.random()` везде → невоспроизводимость, нет тестов.
- `FUEL TOTAL QUANTITY WEIGHT` по умолчанию в фунтах, а поле названо `totalFuelMassKg`. Нужно проверить, какие единицы запрашивает мост `[ПРОВЕРИТЬ]`.

## 6. Что взять как идеи

- Набор сообщений и их «реалистичные» тайминги относительно `sched_out` и TOD.
- Небольшая рандомизация загрузки между prelim и final loadsheet. Это хороший штрих реализма.
- Профили ширины под тип ВС.
- Внешние источники: EONET, VATSIM, OSM-стоянки. Они бесплатные.
- Пресеты настроек и «streamer mode» (скрытие личных данных на экране).
