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
- Триггеры: `phase_enter`, `phase`, `event` (события FSM, кроме `TELEMETRY_LOST`), `time` (`rel`: `sched_*`, `est_*`, фактические `out/off/on/in`), `distance` (`to: dest | tod | orig`, `lte_nm` / `gte_nm`). Шаги: `send`, `wait: { minutes }`, `wait: { phase }`; `reply`, `branch` — T12 (см. ниже), `set` — T14 (загрузчик отклоняет его с понятной ошибкой, в том числе внутри ветки).
- Кандидат = триггер **и** условия стали истинны на этом тике (фронт). Затем cooldown, `excludes` (в обе стороны), бросок `probability`; старт по `priority` (убыв.), затем по `id`.
- У каждого сценария свой Rng с seed `<seed>/<id>`: добавление сценария не меняет броски других.
- `wait.minutes` считает «время полёта» FSM (× `simRate`, без пауз); `time`-триггеры — по `Clock`. Пока телеметрия потеряна, движок стоит.
- Переменные — `CONTEXT_VARIABLES` в `scenario/context.ts` (`ofp.*`, `aircraft.*`, `tm.*`, `flight.*`, `phase`); неизвестная переменная — ошибка загрузки. Отсутствующее значение печатается как `----`.
- Форматтеры: `kg1`, `hhmm`, `ddmmm`, `pad:N`, `lpad:N`, `int`, `upper`. `qnh` — с METAR (T13). Генераторы: `rand`, `pick`, `seat`; `name:*` — T07.
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

## Базовый набор (T07)

- 15 сценариев MVP из `02` — `packages/scenarios/base/*.yaml` (имя файла = `id`): `crew_info`, `slot_ctot`, `prelim_loadsheet`, `takeoff_data`, `fuel_slip`, `final_loadsheet`, `departure_report`, `next_leg`, `aircraft_change`, `dest_weather`, `landing_data`, `gate_assignment`, `arrival_info`, `block_report`, `welcome_turnaround`.
- Данные, о которых должны договориться несколько сценариев (LMC между prelim и final, CTOT, гейт, следующий рейс), — переменные `load.*` и `ops.*` из `core/src/scenario/ops-data.ts`. Считаются один раз на рейс из OFP и Rng `<seed>/#ops`, не сериализуются (выводятся заново). Это детерминированная логика ядра (инвариант 8), а не `set`; `set` по-прежнему T12/T14.
- LMC по оригиналу: ±5 пакс с p = 0.5, ±200 кг груза (шаг 10) с p = 0.5; масса пассажира = `pax_weight + bag_weight` из OFP (иначе 84 кг). Underload = min(MTOW, MZFW + TOF, MLW + TIF) − TOW.
- Гейт, лента, транзитные пассажиры — заглушки до адаптера стоянок OSM (T13). Погода — METAR из OFP (на момент выпуска OFP, о чём сказано в сообщении) до T13. В `takeoff_data` нет V-скоростей: их нет в OFP.
- `{name:*}`: «страна авиакомпании» в OFP отсутствует, вместо неё регион ICAO аэропорта вылета (`core/src/scenario/names.ts`).
- Тест `packages/scenarios/test/base.test.ts`: каждый сценарий отдельно (probability = 1) на 3 синтетических полётах (норма; уход на второй круг + пауза + ×4; OFP в lbs без номера рейса + разрыв телеметрии) × 3 профиля дисплея; весь набор на одном полёте — порядок, снапшот, согласованность LMC и гейта.
