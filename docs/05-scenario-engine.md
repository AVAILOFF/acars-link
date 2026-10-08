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
- Триггеры: `phase_enter`, `phase`, `event` (события FSM, кроме `TELEMETRY_LOST`), `time` (`rel`: `sched_*`, `est_*`, фактические `out/off/on/in`), `distance` (`to: dest | tod | orig`, `lte_nm` / `gte_nm`). Шаги: `send`, `wait: { minutes }`, `wait: { phase }`. `reply`, `branch`, `set` — T12/T14; загрузчик отклоняет их с понятной ошибкой.
- Кандидат = триггер **и** условия стали истинны на этом тике (фронт). Затем cooldown, `excludes` (в обе стороны), бросок `probability`; старт по `priority` (убыв.), затем по `id`.
- У каждого сценария свой Rng с seed `<seed>/<id>`: добавление сценария не меняет броски других.
- `wait.minutes` считает «время полёта» FSM (× `simRate`, без пауз); `time`-триггеры — по `Clock`. Пока телеметрия потеряна, движок стоит.
- Переменные — `CONTEXT_VARIABLES` в `scenario/context.ts` (`ofp.*`, `aircraft.*`, `tm.*`, `flight.*`, `phase`); неизвестная переменная — ошибка загрузки. Отсутствующее значение печатается как `----`.
- Форматтеры: `kg1`, `hhmm`, `ddmmm`, `pad:N`, `lpad:N`, `int`, `upper`. `qnh` — с METAR (T13). Генераторы: `rand`, `pick`, `seat`; `name:*` — T07.
- T07 добавил: форматтер `sign` (+3 / -120 / 0), генераторы `{name:crew}` / `{name:ops}`.
- **Поздний старт** (решение пользователя 2026-10-08, после проверки T10: при старте за 5 мин до STD пять предвылетных telex пришли разом и не по порядку). На первом тике движок считает задержку: если до `sched_out` осталось меньше `lateStartLeadMin` (по умолчанию 35 мин — столько длится посадка в синтетическом профиле), рейс считается задержанным на недостающее время, с округлением вверх до 5 мин. Триггеры `time` с `rel: sched_*` и `est_*`, переменные `ofp.est_*`, `ops.ctot`, `ops.next_std` сдвигаются на задержку; `ofp.sched_*` (STD/STA в текстах) — нет. Переменная `flight.delay_min` — задержка в минутах (0 — вовремя). Задержка — часть состояния движка (`delayMs`), один и тот же (OFP, запись, seed) даёт одну и ту же задержку. Сценарии, время которых для задержанного рейса уже прошло к старту (например, `crew_info` за 45 мин), уходят на первом тике.

## Базовый набор (T07)

- 15 сценариев MVP из `02` — `packages/scenarios/base/*.yaml` (имя файла = `id`): `crew_info`, `slot_ctot`, `prelim_loadsheet`, `takeoff_data`, `fuel_slip`, `final_loadsheet`, `departure_report`, `next_leg`, `aircraft_change`, `dest_weather`, `landing_data`, `gate_assignment`, `arrival_info`, `block_report`, `welcome_turnaround`.
- Данные, о которых должны договориться несколько сценариев (LMC между prelim и final, CTOT, гейт, следующий рейс), — переменные `load.*` и `ops.*` из `core/src/scenario/ops-data.ts`. Считаются один раз на рейс из OFP и Rng `<seed>/#ops`, не сериализуются (выводятся заново). Это детерминированная логика ядра (инвариант 8), а не `set`; `set` по-прежнему T12/T14.
- LMC по оригиналу: ±5 пакс с p = 0.5, ±200 кг груза (шаг 10) с p = 0.5; масса пассажира = `pax_weight + bag_weight` из OFP (иначе 84 кг). Underload = min(MTOW, MZFW + TOF, MLW + TIF) − TOW.
- Гейт, лента, транзитные пассажиры — заглушки до адаптера стоянок OSM (T13). Погода — METAR из OFP (на момент выпуска OFP, о чём сказано в сообщении) до T13. В `takeoff_data` нет V-скоростей: их нет в OFP.
- `{name:*}`: «страна авиакомпании» в OFP отсутствует, вместо неё регион ICAO аэропорта вылета (`core/src/scenario/names.ts`).
- Тест `packages/scenarios/test/base.test.ts`: каждый сценарий отдельно (probability = 1) на 3 синтетических полётах (норма; уход на второй круг + пауза + ×4; OFP в lbs без номера рейса + разрыв телеметрии) × 3 профиля дисплея; весь набор на одном полёте — порядок, снапшот, согласованность LMC и гейта.
