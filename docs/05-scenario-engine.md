# 05 — Движок сценариев

Сценарии описываются в YAML, валидируются JSON Schema, исполняются ядром детерминированно (seeded Rng). Примеры — `reference/scenarios/`.

## Модель

```yaml
id: string                 # уникальный, snake_case
version: 1
category: docs | ops | irregular | external | fun
title: string              # для UI настроек
enabled_by_default: bool
trigger:                   # когда сценарий становится кандидатом
  on: phase_enter | phase | event | time | distance
  phase: CRUISE            # для phase_enter / phase
  event: OOOI_OFF          # для event
  at: { rel: sched_out, offset_min: -25 }       # для time
  dist: { to: tod, lte_nm: 150 }                # для distance
conditions:                # все должны выполняться
  - "ofp.block_time_min >= 90"
  - "aircraft.cat in ['M','H']"
probability: 0.05          # 0..1, бросок один раз при входе в кандидаты
cooldown: per_flight | per_session | { minutes: 120 }
excludes: [other_scenario_id]   # взаимоисключение
priority: 0                # при конфликте на одном тике
steps:                     # последовательность
  - send: template_id | inline text
    vars: { ... }          # локальные переменные
  - wait: { minutes: 5 } | { phase: DESCENT } | { reply: { options: [CONTINUE, DIVERT], timeout_min: 10, default: CONTINUE } }
  - branch:
      DIVERT: [ { send: ... } ]
      CONTINUE: [ { send: ... } ]
  - set: { flags.mel_item: "21-31-01" }   # влияет на следующие сценарии и следующий рейс
```

## Шаблоны

- Синтаксис: `{var}`, `{var|fmt}`. Форматтеры: `kg1` (12345 → 12.3), `hhmm`, `ddmmm`, `pad:N`, `upper`, `qnh`.
- Генераторы: `{rand:10-35}`, `{pick:[A,B,C]}`, `{name:crew}` (по стране авиакомпании), `{seat}`.
- Блоки шаблона: `header` / `body` / `footer`. Линии и разделители подставляет форматтер по `DisplayProfile`.
- Все переменные берутся из контекста: `ofp.*`, `tm.*` (телеметрия), `phase`, `flight.*` (OOOI, seed, флаги), `wx.*`, `ext.*`.

## Исполнение

1. На каждом тике ядро вычисляет набор кандидатов по `trigger` и `conditions`.
2. Для новых кандидатов: бросок `probability` (seeded). Проверка `cooldown` и `excludes`.
3. Активные сценарии исполняются как корутины по `steps`. `wait` переводит сценарий в ожидание события.
4. Исходящие сообщения → форматтер → очередь транспорта (rate limit).
5. Входящий telex от пилота сопоставляется с ожидающими `reply`. Если ожидающих нет — с глобальными «командами» (`REQ WX`, `REQ GATE`…).

## Входящие команды пилота (v1)

| Команда | Ответ |
|---|---|
| `REQ WX <ICAO>` | METAR/TAF |
| `REQ GATE` | назначенный гейт и стоянка |
| `REQ LOADSHEET` | повтор последнего лоадшита |
| `DELAY <мин> <причина>` | подтверждение, сдвиг расписания |
| `DIVERT <ICAO>` | цепочка диверсии |
| `ETA` | ETA и данные по стыковкам |

Парсер терпим к пробелам и регистру. Неизвестная команда → вежливый `UNABLE / SEND HELP FOR LIST`.

## Валидация контента

- JSON Schema + тест, который прогоняет каждый сценарий на 3 синтетических полётах и проверяет: шаблоны раскрываются, строки ≤ ширины профиля, нет запрещённых символов.
- LLM (опц.): шаг `send` может иметь `llm_flavor: true`. Тогда бэкенд перефразирует **только** свободный текст. Результат проходит те же проверки, при провале используется исходный шаблон.

## Реализация v0 (T06)

- Код: `packages/core/src/scenario/` (типы, условия, шаблоны, контекст, движок), `packages/core/src/core.ts` (`AcarsCore`: FSM + движок по контракту из `03`), `packages/scenarios/src/` (YAML 1.2 → JSON Schema → `compileScenario`).
- Триггеры: `phase_enter`, `phase`, `event` (события FSM, кроме `TELEMETRY_LOST`), `time` (`rel`: `sched_*`, `est_*`, фактические `out/off/on/in`), `distance` (`to: dest | tod | orig`, `lte_nm` / `gte_nm`). Шаги: `send`, `wait: { minutes }`, `wait: { phase }`; `reply`, `branch` — T12 (см. ниже), `set` — T14 (см. ниже).
- Кандидат = триггер **и** условия стали истинны на этом тике (фронт). Затем cooldown, `excludes` (в обе стороны), бросок `probability`; старт по `priority` (убыв.), затем по `id`.
- У каждого сценария свой Rng с seed `<seed>/<id>`: добавление сценария не меняет броски других.
- `wait.minutes` считает «время полёта» FSM (× `simRate`, без пауз); `time`-триггеры — по `Clock`. Пока телеметрия потеряна, движок стоит.
- Переменные — `CONTEXT_VARIABLES` в `scenario/context.ts` (`ofp.*`, `aircraft.*`, `tm.*`, `flight.*`, `phase`); неизвестная переменная — ошибка загрузки. Отсутствующее значение печатается как `----`.
- Форматтеры: `kg1`, `hhmm`, `ddmmm`, `pad:N`, `lpad:N`, `int`, `upper`, `qnh` (T13: группа `Q1013`/`A2992` из METAR). Генераторы: `rand`, `pick`, `seat`; `name:*` — T07.
- T07 добавил: форматтер `sign` (+3 / -120 / 0), генераторы `{name:crew}` / `{name:ops}`.
- **Поздний старт** (решение пользователя 2026-10-08, после проверки T10: при старте за 5 мин до STD пять предвылетных telex пришли разом и не по порядку). На первом тике движок считает задержку: если до `sched_out` осталось меньше `lateStartLeadMin` (по умолчанию 35 мин — столько длится посадка в синтетическом профиле), рейс считается задержанным на недостающее время, с округлением вверх до 5 мин. Триггеры `time` с `rel: sched_*` и `est_*`, переменные `ofp.est_*`, `ops.ctot`, `ops.next_std` сдвигаются на задержку; `ofp.sched_*` (STD/STA в текстах) — нет. Переменная `flight.delay_min` — задержка в минутах (0 — вовремя). Задержка — часть состояния движка (`delayMs`), один и тот же (OFP, запись, seed) даёт одну и ту же задержку. Сценарии, время которых для задержанного рейса уже прошло к старту (например, `crew_info` за 45 мин), уходят на первом тике.

## Двусторонняя связь (T12)

- **Вход ядра** — `CoreInput.inbound: PilotMessage[]` (`{ from, type, text }`, контракт `03`). Приложение передаёт с ближайшим тиком: telex, полученные транспортом, и текст, набранный в окне «Ответить за пилота» (для самолётов без свободного telex — A350/A380, `06`; в сеть не уходит). Учитываются только `type: telex` от позывного рейса; CPDLC (логон A350/A380), чужие позывные и пустые сообщения — событие `PILOT_MESSAGE` с `result: ignored`. Пока телеметрия потеряна, сообщения ждут в состоянии ядра (`inbox`).
- **Нормализация**: верхний регистр, всё кроме `A–Z0–9` → пробел (`REQ-REFUEL` из Fenix, `req  wx/eddf`), `core/src/scenario/pilot.ts`.
- **`wait: { reply: { options, timeout_min, default } }`**: варианты — одно слово `A–Z0–9`, `default` обязателен и входит в `options`. Ответ — сообщение пилота, первое слово которого — вариант (при нескольких ожидающих — самый ранний запуск); остальные слова — `reply.arg`. Без ответа за `timeout_min` **полётного** времени (как `wait.minutes`: пауза не идёт, ×N ускоряет) берётся `default`, `reply.timeout = true`. Ответ на вопрос важнее команды с тем же словом (`DIVERT`). Событие `REPLY_EXPECTED` — приложение просит транспорт чаще опрашивать (`expectReply`, у Hoppie ≤ 3 мин), `REPLY_TIMEOUT` — в ленту.
- **`branch: { ВАРИАНТ: [шаги], … }`** — по последнему ответу (`reply.option`); ответ без ветки — дальше после `branch`. Ветки вложенные; ключи проверяются по ближайшему `wait: reply`; `branch` после ветвления, где ветки задавали разные вопросы, без нового вопроса — ошибка загрузки. Компилируется в плоскую программу с переходами — состояние прогона по-прежнему номер шага (сериализуется).
- **`resend: { of: [id, …] }`** — повтор последнего сообщения одного из сценариев этого рейса (дословно). Переменная `flight.sent` — id сценариев, уже что-то отправивших (`'final_loadsheet' in flight.sent`).
- **Команды пилота** — триггер `on: command`, `command: REQ_WX | REQ_GATE | REQ_LOADSHEET | DELAY | DIVERT | ETA | HELP` (cooldown по умолчанию `none`: отвечать на каждую). Синтаксис: `REQ WX [ICAO]` (`REQ METAR`; без аэропорта — назначение), `REQ GATE`, `REQ LOADSHEET` (`REQ LS`), `DELAY <1–600> [причина]`, `DIVERT <ICAO>`, `ETA`, `HELP`; лишние слова игнорируются. Переменные запуска: `cmd.name`, `cmd.text`, `cmd.icao`, `cmd.minutes`, `cmd.reason`, `cmd.metar` (METAR из OFP для вылета/назначения/запасных, иначе null — до T13). Часть команды делает ядро (детерминированно, до сценариев): `DELAY` до OUT прибавляется к задержке рейса — как поздний старт (`est_*`, триггеры `sched_*`/`est_*`, `flight.delay_min`; уже отправленные сообщения не повторяются); `DIVERT` только в воздухе (OFF есть, ON нет) и не на назначение — `flight.divert`. Прилётные сценарии базового набора (`dest_weather`, `landing_data`, `gate_assignment`, `arrival_info`, `welcome_turnaround`) при диверсии не идут; перестроение маршрута на запасной — нет.
- **Каждая команда получает ответ.** Неизвестная — `UNABLE <текст> / SEND HELP FOR LIST`; известная с неверными аргументами или невыполнимая — `UNABLE <КОМАНДА> / <почему или формат>`; известная, но без включённого сценария — `RCVD <текст>`. Это сообщения самого ядра (`scenarioId: '#ops'`), через форматтер.
- Обработчики — `packages/scenarios/commands/*.yaml` (11 файлов: `cmd_help`, `cmd_req_wx`(+`_no_data`), `cmd_req_gate`(+`_divert`), `cmd_req_loadsheet`(+`_none`), `cmd_delay`, `cmd_divert` — с вопросом о причине и ветками, `cmd_eta`, `cmd_eta_ground`). Варианты одной команды разводятся условиями. Приложение и `pnpm replay` грузят их вместе с базовым набором; в настройках они отключаются как обычные сценарии.
- Новый форматтер шаблона `or:ТЕКСТ` — текст вместо `----` для пустого значения (`{cmd.reason|or:NOT GIVEN}`).
- Запись полёта: строка `tick` получила необязательное поле `inbound`; `pnpm replay run … --pilot "<мин>=<текст>"` добавляет сообщения пилота к прогону.
- Тесты: `core/test/two-way.test.ts` (парсер, reply/branch/таймаут/вложенность, сериализация посреди вопроса, потеря телеметрии, команды), `scenarios/test/commands.test.ts` (все команды на 3 синтетических полётах × 3 профиля, разговор целиком, эталон `reference/scenarios/medical_onboard.yaml` без `set`/`calc.*`).

## Внешние данные (T13)

- **Ядро не ходит в сеть** (инвариант 3). Данные — вход ядра `CoreInput.data: ExtDataUpdate` (`core/src/ext/data.ts`): `wx` (METAR/TAF по аэропортам, `null` = отчёта нет), `atc` (станции VATSIM аэропортов вылета и назначения), `events` (EONET), `stands` (стоянки OSM назначения). Каждое поле заменяет прежнее; данные хранятся в состоянии движка (`ext`, сериализуется) и пишутся в запись полёта (`tick.data`), поэтому replay детерминирован.
- **Переменные**: `wx.{orig,dest,altn}_metar` — живой METAR, иначе из OFP; `_live` — живой ли; `_obs` — время наблюдения; `_taf` — только живой. Живой = не старше 3 ч. `ext.{orig,dest}_atc` — строки `ПОЗЫВНОЙ ЧАСТОТА` (ATIS, DEL, GND, TWR, APP), `_atc_count` (null без данных или если данным VATSIM больше 20 мин), `ext.dest_atis` — буква ATIS. `ext.event_*` — ближайшее событие EONET **впереди по маршруту** в пределах 150 NM от него: `id`, `title`, `category` (`SEVERE STORM`, `WILDFIRE`, `VOLCANO`…), `ahead_nm` (по маршруту от самолёта), `off_nm` (от маршрута). Положение события относительно маршрута считается один раз при получении (ломаная OFP с шагом ≤ 10 NM).
- **Гейт из OSM**: при стоянках назначения `ops.arr_gate` берётся из них (гейты, если их ≥ 3, иначе стоянки; натуральный порядок; одна выборка Rng `<seed>/#stands`). Как только сообщение с `ops.arr_gate` ушло, новые стоянки игнорируются (`ext.gateLocked`) — гейт в `gate_assignment`, `REQ GATE`, `arrival_info` один и тот же.
- **`REQ WX` с запросом данных**: при `dataWaitMs > 0` (приложение с живыми данными — 60 с) и без свежей (≤ 15 мин) погоды аэропорта ядро откладывает команду и выдаёт событие `DATA_REQUEST {kind: wx, icao}`; ответ — когда данные пришли или вышло время (тогда с тем, что есть: METAR из OFP или «нет данных»). Переменные: `cmd.metar` (живой или из OFP), `cmd.taf`, `cmd.wx_live`, `cmd.wx_obs`. Без источника данных (`dataWaitMs = 0`, по умолчанию) — ответ сразу.
- **Сценарии**: `packages/scenarios/external/` — `dest_weather_live` (вместо `dest_weather`, если у назначения живой METAR; `dest_weather` получил условие `!wx.dest_live`), `vatsim_atc` / `vatsim_atc_none` (за 80 NM до TOD, как в оригинале; без данных VATSIM — ничего), `natural_event` (в крейсере, событие ≤ 250 NM впереди, не позже 15 мин до TOD). `commands/cmd_req_wx_live` (METAR + TAF), `cmd_req_wx` — только без живой погоды. `takeoff_data` берёт `wx.orig_metar`. Приложение и `pnpm replay` грузят `external/` вместе с `base/` и `commands/`.
- **Адаптеры** — пакет `@acars/data-sources` (см. `06`). Тесты: `core/test/ext-data.test.ts`, `scenarios/test/external.test.ts` (каждый сценарий на 3 полётах × 3 профиля с данными и без; весь набор с данными), `data-sources/test/adapters.test.ts`, `desktop/test/controller.test.ts` («live data»).

## Нестандартные сценарии и память авиакомпании (T14)

- **`set: { цель: значение, … }`** (`core/src/scenario/engine.ts`). Цели: `flags.<имя>` (`a–z0–9_`, до 40 символов) — **память авиакомпании**: видна всем сценариям этого рейса как `flags.<имя>` (нет — `null`) и переходит на следующие рейсы; `null` удаляет. `flight.divert` — диверсия рейса (ICAO; только в воздухе — OFF есть, ON нет — и не на назначение; иначе не применяется), как команда `DIVERT`. `ops.arr_gate` — гейт прибытия с этого момента (`A–Z0–9`, 1–6 символов; дальше `arrival_info`, `REQ GATE` называют новый). Значение — литерал (строка/число/bool/null) или шаблон; шаблон из одной переменной `{ofp.pax}` сохраняет тип (число остаётся числом). Строки обрезаются до 80 символов, флагов не больше 64. Любые другие цели (`flight.pax_delta` из черновика `reference/`) — ошибка загрузки. Каждое присваивание — событие `SET {id, name, value, applied}`.
- **Перенос между рейсами**: `CoreOptions.flags` на входе, `AcarsCore.flags` на выходе; состояние ядра сериализует их. Приложение хранит их в `<userData>/airline-memory.json`, сохраняет при «Завершить»/«Стоп», при старте пишет в ленту (`memory`) и в заголовок записи (`header.flags`, replay стартует с ними). В настройках — список и кнопка «Очистить» (не во время полёта). Привязка к самолёту/дате — дело сценария (`flags.mel_reg == ofp.ac_reg`, `flags.mel_date != flight.date`).
- **Данные нестандартных сценариев** — `irr.*` (`scenario/irregular-data.ts`, Rng `<seed>/#irr`, от опубликованного расписания, так что задержка приближает curfew и стыковку): `irr.curfew` (+ `_local` по `utc_offset` назначения, `_margin_min` — до оценки посадки с учётом задержки), `irr.connect_flight/_std/_pax/_margin_min/_left_min` (последнее — от текущего момента), `irr.tanker_kg/_block_kg/_ldw_kg`, `irr.flow_delay_min`, `irr.revised_ctot` (= `ops.ctot` + flow), `irr.latest_out` (оценка OUT + запас FDP), `irr.new_gate` (другая стоянка OSM или соседний номер, Rng `<seed>/#irr-gate`), `irr.lost_bags`. Ещё: `flight.nearest_altn(_nm)` — ближайший к самолёту из вылета и запасных; `wx.orig_temp_c`, `wx.dest_temp_c` — из METAR (живого или OFP).
- **Набор** — `packages/scenarios/irregular/` (22, все из списка `02`): `medical_onboard` (CONTINUE/DIVERT → `flight.divert` ближайший), `unruly_passenger` (RESTRAIN/DIVERT/CONTINUE) → `unruly_followup` на следующем рейсе, `tech_defect_mel` (CONFIRM/NEGATIVE) → `mel_carry_over` на следующем рейсе того же борта (закрытие после прилёта), `deicing_holdover` (OAT ≤ 3 °C, READY), `curfew_dest` (запас < 20 мин; UNABLE → диверсия на запасной), `tankering` (ACCEPT/DECLINE, если LDW позволяет), `short_connection` → `connection_made` / `connection_missed` (по фактическому ON_BLOCK), `dg_notoc` (ACK), `vip_onboard`, `runway_closure_dest` и `drone_activity` (HOLD/DIVERT, взаимоисключаются), `altn_wx_deterioration` (OK/LOW), `crew_duty_limit` (задержка ≥ 30 мин; EXTEND/NO) → `discretion_followup`, `atc_flow_delay`, `lost_baggage` → `rush_bags_followup`, `gate_reassignment` (после `gate_assignment`, `set ops.arr_gate`). Вероятности малы (0,03–0,08; реакции на условия — выше): 0,3–2 события на рейс. Временные флаги внутри одной цепочки (`deice_pad`, `vip_seat`) сценарий очищает сам.
- **Тексты для интерфейса**: необязательные поля `title_ru`, `description`, `description_ru` — только для приложения (вкладка «Сценарии», список «Запустить сейчас»), по языку интерфейса; без перевода показывается английский `title`. Телексы всегда на английском (`08`, решение 7). Заполнены у всех `irregular/`.
- **Вероятность вручную** (настройки → Сценарии): у каждого нестандартного события (`irregular`, кроме обработчиков команд, т. е. без `cmd_divert`) поле «%» (0–100, шаг 0,1; пусто — значение `probability` из файла). Хранится в `settings.chances`, применяется со следующего рейса: приложение передаёт ядру сценарий с заменённой `probability`; отличия от файлов пишутся в заголовок записи (`header.probabilities`, 0–1), replay применяет их.
- **«Запустить сейчас»** (экран полёта, пока идёт рейс): вход ядра `CoreInput.force: [id]`. Сценарий стартует на этом тике без триггера, вероятности, кулдауна и `excludes`, но **только если выполнены его условия** (фаза, задержка, флаги — иначе сообщения были бы бессмысленны) и он не идёт сейчас. Итог — событие `FORCED {id, result: started | conditions | running | unknown, detail}` (для `conditions` — текст невыполненного условия), в ленте приложения — `forced_*`. Пока телеметрия потеряна, запрос ждёт в состоянии ядра (`forced`). Запись полёта: поле `force` строки `tick`, replay его воспроизводит.
- Тесты: `core/test/flags.test.ts`, `scenarios/test/irregular.test.ts` (каждый сценарий на 3 полётах × 3 профиля **по каждому варианту ответа**, цепочки внутри рейса и между рейсами, детерминизм), `desktop/test/controller.test.ts` («airline memory»), `replay.test.ts`.

## Базовый набор (T07)

- 15 сценариев MVP из `02` — `packages/scenarios/base/*.yaml` (имя файла = `id`): `crew_info`, `slot_ctot`, `prelim_loadsheet`, `takeoff_data`, `fuel_slip`, `final_loadsheet`, `departure_report`, `next_leg`, `aircraft_change`, `dest_weather`, `landing_data`, `gate_assignment`, `arrival_info`, `block_report`, `welcome_turnaround`.
- Данные, о которых должны договориться несколько сценариев (LMC между prelim и final, CTOT, гейт, следующий рейс), — переменные `load.*` и `ops.*` из `core/src/scenario/ops-data.ts`. Считаются один раз на рейс из OFP и Rng `<seed>/#ops`, не сериализуются (выводятся заново). Это детерминированная логика ядра (инвариант 8), а не `set`; `set` по-прежнему T12/T14.
- LMC по оригиналу: ±5 пакс с p = 0.5, ±200 кг груза (шаг 10) с p = 0.5; масса пассажира = `pax_weight + bag_weight` из OFP (иначе 84 кг). Underload = min(MTOW, MZFW + TOF, MLW + TIF) − TOW.
- Лента и транзитные пассажиры — заглушки; гейт — из стоянок OSM, если они есть (T13, ниже), иначе заглушка. Погода — живая (T13) или METAR из OFP (на момент выпуска OFP, о чём сказано в сообщении). В `takeoff_data` нет V-скоростей: их нет в OFP.
- `{name:*}`: «страна авиакомпании» в OFP отсутствует, вместо неё регион ICAO аэропорта вылета (`core/src/scenario/names.ts`).
- Тест `packages/scenarios/test/base.test.ts`: каждый сценарий отдельно (probability = 1) на 3 синтетических полётах (норма; уход на второй круг + пауза + ×4; OFP в lbs без номера рейса + разрыв телеметрии) × 3 профиля дисплея; весь набор на одном полёте — порядок, снапшот, согласованность LMC и гейта.
