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
