# 03 — Архитектура

> Решения этапа 0 (см. `08`): оболочка — **Electron**, мост — **C# / .NET 8**, бэкенд на старте не нужен, UI — EN + RU.

## Компоненты

```
┌──────────────┐  named pipe/SimConnect  ┌───────────────────────┐
│  MSFS        │ ───────────────────────>│ sim-bridge (C#/.NET)  │
└──────────────┘                         │ WebSocket 127.0.0.1   │
                                         └──────────┬────────────┘
                                                    │ TelemetrySnapshot, 1 Гц
┌──────────────┐  OFP JSON                ┌─────────v──────────────────────────┐
│  SimBrief    │ ────────────────────────>│ app (Electron)                     │
└──────────────┘                          │  ├─ packages/core   (чистый TS)    │
                                          │  │   FSM фаз · планировщик ·        │
┌──────────────┐  telex/poll              │  │   движок сценариев · форматтер  │
│ Hoppie / SI  │ <───────────────────────>│  ├─ adapters: transport, data,     │
└──────────────┘                          │  │   storage, clock, rng           │
                                          │  └─ ui (React)                     │
┌──────────────┐  HTTPS (опц.)            └────────────────────────────────────┘
│ backend      │ <── LLM-прокси, платные API (ключи только здесь)
└──────────────┘
```

## Монорепо (предложение)

```
apps/desktop            оболочка Electron + UI React (EN/RU)
apps/backend            (опц.) LLM-прокси, кэш внешних данных
bridge/msfs             C# консольный мост SimConnect → WebSocket
packages/core           FSM, планировщик, сценарии, форматтер — чистый TS
packages/scenarios      YAML-сценарии + JSON Schema + валидатор
packages/data-sources   METAR/TAF, VATSIM, EONET, OSM-стоянки (адаптеры)
packages/transport      Hoppie, SayIntentions, Mock
tools/replay            запись и воспроизведение телеметрии для тестов
```

Стек по умолчанию (как в других проектах пользователя): pnpm, TypeScript strict, React, Zustand, Vitest, Biome, Playwright для UI. Мост — C# (.NET 8) с управляемым SimConnect из MSFS SDK. Альтернатива — C++ или Rust.

**Electron или Tauri:** выбран Electron (08, решение 1): проще и в экосистеме оригинала; цена — установщик ~100 МБ.

## Ядро: контракт

```ts
interface CoreInput {
  ofp: Ofp;                       // нормализованный SimBrief
  telemetry: TelemetrySnapshot;   // последний снимок
  inbound: InboundMessage[];      // ответы пилота с прошлого тика
  now: number;                    // от Clock, мс UTC
}
interface CoreOutput {
  outbound: OutboundMessage[];    // { to, from, text, kind: telex | cpdlc (+ заголовок /data2/) }
  commands: SimCommand[];         // команды симулятору (T21)
  phase: FlightPhase;
  events: CoreEvent[];            // для UI и лога (фазы, сценарии, УВД ROPS)
  listen: string[];               // позывные станций УВД ROPS для опроса (T23)
}
// core.tick(input) → output. Состояние — внутри экземпляра, сериализуемо (resume после рестарта).
```

Rng: xoshiro128** (`packages/core/src/random/rng.ts`), seed = `"<callsign>/<OFP request_id>"` или задаётся пользователем. Строка → FNV-1a 32 → расширение до 128 бит (SplitMix32-подобный миксер). Схема сидирования — часть контракта replay, закреплена golden-тестами. Состояние сериализуется (`getState`/`rngFromState`).

Clock: интерфейс `now(): number` (мс UTC). В ядре только `ManualClock`; реальные часы передаёт приложение.

## TelemetrySnapshot (v1)

Имена SimVar и единицы — `[ПРОВЕРИТЬ]` по документации MSFS SDK перед реализацией моста.

| Поле | SimVar | Единицы |
|---|---|---|
| `v` | — | версия схемы, `1` |
| `t` | — | время снимка, мс UTC (часы моста) |
| `lat`, `lon` | PLANE LATITUDE / PLANE LONGITUDE | degrees |
| `altFt` | PLANE ALTITUDE | feet |
| `aglFt` | PLANE ALT ABOVE GROUND | feet |
| `iasKt` | AIRSPEED INDICATED | knots |
| `gsKt` | GROUND VELOCITY | knots |
| `vsFpm` | VERTICAL SPEED | feet per minute |
| `hdgTrue` | PLANE HEADING DEGREES TRUE | degrees |
| `onGround` | SIM ON GROUND | bool |
| `parkingBrake` | BRAKE PARKING POSITION | bool |
| `beacon` | LIGHT BEACON | bool |
| `engRunning[n]` | GENERAL ENG COMBUSTION:n | bool |
| `engN2[n]` | ENG N2 RPM:n или TURB ENG N2:n | percent |
| `fuelKg` | FUEL TOTAL QUANTITY WEIGHT | **запрашивать в kilograms** |
| `gearDown` | GEAR HANDLE POSITION | bool |
| `flapsIdx` | FLAPS HANDLE INDEX | number |
| `doorsOpen[n]` | EXIT OPEN:n | percent (у многих аддонов не работает) |
| `xpdrState` | TRANSPONDER STATE:1 | enum |
| `simRate` | SIMULATION RATE | number |
| `paused` | системное событие Pause | bool |
| `aircraftTitle` | TITLE | string |
| `touchdownFpm` | PLANE TOUCHDOWN NORMAL VELOCITY (T46) | **feet per second** × 60 → ft/мин; сим держит значение до следующего касания; в TS поле необязательное (старые записи) |

Пример — `reference/telemetry.sample.json`.

## Профили дисплеев

`DisplayProfile { id, matchIcao[], matchTitleRegex?, lineWidth, maxLines?, uppercase, allowedChars, pageBreak? }`. Значения ширины для конкретных аддонов неизвестны — собираются «Проверкой человеком». Оригинал: базовая ширина + 3 для B77x и + 6 для B78x.

Реализация — `packages/core/src/format/` (T05). По умолчанию 24 символа (колонки MCDU/CDU; базовая ширина оригинала неизвестна `[ПРОВЕРИТЬ]`), B77x — 27, B78x — 30. Символы по умолчанию: `A–Z 0–9`, пробел и `.,:;/-+()'?!=%#*&@`; `{}` (разделители пакета Hoppie), кавычки, `\`, `<>`, `|` запрещены. Раскладка: заголовок, линия дефисов, тело, линия точек, подвал; строка тела из `-`/`.`/`=`/`*` (≥ 3) растягивается на всю ширину. Перенос по пробелу или после `/`/`-` внутри слова, иначе жёсткий.
