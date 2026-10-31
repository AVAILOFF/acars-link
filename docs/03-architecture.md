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

Стек по умолчанию (как в других проектах пользователя): pnpm, TypeScript strict, React, Zustand, Vitest, Biome, Playwright для UI. Мост — C# (.NET 8); SimConnect — через `acars_simconnect.dll` (C++, `bridge/msfs/native`, статическая линковка клиента из официального MSFS SDK; P/Invoke из C#, T73). Управляемая обёртка SDK и `SimConnect.dll` не используются и не поставляются.

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
  events: CoreEvent[];            // для UI и лога (фазы, сценарии, УВД XATC)
  listen: string[];               // позывные станций УВД XATC для опроса (T23)
}
// core.tick(input) → output. Состояние — внутри экземпляра, сериализуемо (resume после рестарта).
// core.report() → FlightReport — сводка рейса (T69), см. ниже.
```

### Сводка рейса (T69)

Решения пользователя 2026-10-30 (`07`, T69). `AcarsCore.report()` — чистый расчёт `flightReport` (`packages/core/src/summary/report.ts`) из данных ядра: OOOI машины фаз и топливо/позиция снимка ровно в момент каждого OOOI (`PhaseMachine.oooiAt`), план OFP (`sched_out…sched_in`, `sched_block`, `est_time_enroute`, `plan_ramp`/`plan_takeoff`/`plan_landing`, `taxi`, `enroute_burn`), скорость касания из симулятора (T46; нет — `null`, «нет данных»), уходы на второй круг (входы в `GO_AROUND`), задержка с кодами IATA (T43), аэропорт диверсии (T50), счётчики сообщений (авиакомпании — выданные сценариями; пилота — телексы авиакомпании, кроме `ignored`; из них ответы на `wait: reply`) и сработавшие нестандартные сценарии. Только цифры, без оценок; разница — «факт − план». Аэропорт посадки — ближайший к точке касания из аэропортов OFP (назначение, вылет, запасные, ETOPS) и аэропорта диверсии в пределах `LANDED_WITHIN_NM` = 5 NM; дальше — неизвестный аэропорт с координатами; диверсия — посадка не в аэропорту назначения. Сводка снимается в момент закрытия рейса у гейта (`endFlight` → TURNAROUND/DONE): сообщения разворота после этого относятся к следующему рейсу. Приложение пишет её строкой `summary` сразу после `end` в запись полёта и добавляет в журнал рейсов `<userData>/logbook.json` (без ограничения числа рейсов); `pnpm replay summary <запись>` считает её заново тем же кодом (`--check` сверяет со строкой `summary`).

### Восстановление рейса после закрытия или падения приложения (T64)

Решения пользователя 2026-10-29 (`07`, T64). Рейс восстанавливается из записи полёта (T11), отдельного файла состояния нет: при запуске приложение находит последнюю запись (по имени — времени старта) и предлагает продолжить, если в ней есть `start`, нет `end` и `stop`, заголовок записан после T64 (есть поле `simTime`) и файл менялся не больше 24 ч назад (`RESUME_MAX_AGE_MS`, `apps/desktop/src/main/recording.ts`). «Продолжить» — `FlightSession` с `resume`: ядро создаётся из заголовка (`recordedCoreOptions`, `tools/replay/src/run.ts` — те же опции, что у `pnpm replay run`), все события записи прогоняются через ядро заново (инвариант 4), лента собирается из того же прогона; транспорт, мост, данные и файл при этом не трогаются. Каждый телекс прогона сверяется со строкой `out` записи; расхождение (другие сценарии, другая версия приложения) — отказ `resume_mismatch`, рейс не загружается. Затем телексы без строки `sent` отправляются заново (решение 5), транспорт снова слушает станции XATC, запись дописывается в тот же файл (`resume`, решение 3). Прогон быстрый: синтетический RJTT–KLAX 12 ч (43 580 тиков, 18 МБ) — 1,7 с вместе с запуском Node (замер 2026-10-29). «Отказаться» — в конец записи пишется `stop`, рейс больше не предлагается; новый рейс делает то же с прежним. Закрытие окна и выход приложения рейс не останавливают (`FlightSession.suspend`: файл закрывается без `stop`). При выключенной настройке «Записывать полёты» запись всё равно пишется — во временную папку `<userData>/flight-temp`, и удаляется, когда рейс остановлен или от него отказались (решение 6). Не восстанавливаются: эффекты в симуляторе, бывшие в момент падения (дым, машины — приложение убирает их при запуске, `SimEffects.clear`), закрытие рейса, начатое в TURNAROUND/DONE (`end` уже записан).

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
| `parkingBrake` | BRAKE PARKING POSITION; у Fenix (TITLE начинается с `Fenix`) — ещё `L:S_MIP_PARKING_BRAKE` ≥ 0.5 (одно из двух) | bool |
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

Стояночный тормоз Fenix A320 (2026-10-23, баг: приложение «рулило» на стоянке): Fenix 3.0.0.7438 (обновление 2026-10-21) не ведёт BRAKE PARKING POSITION — во всех полётах с 22.10 она 0. **Проверено человеком** (MSFS 2024, Fenix A320, LIRF, стоянка, двигатели выключены, 2026-10-23, проба SimConnect): `L:S_MIP_PARKING_BRAKE` идёт за рукояткой 1 → 0 → 1, `L:B_HYD_PARKING_BRAKE_SET` всё время 0, BRAKE PARKING POSITION — 0. Чтение L-переменной: `AddToDataDefinition("L:NAME", "number")`, только FLOAT64 (SDK, SimConnect_AddToDataDefinition, сверено 2026-10-23). **Одобрено пользователем 2026-10-23:** Fenix определяется по TITLE с префикса `Fenix`, тормоз = SimVar или LVar; у остальных самолётов — только SimVar. Тормоз в машинах аварийных служб (T54) — по тому же правилу.

## Профили дисплеев

`DisplayProfile { id, matchIcao[], matchTitleRegex?, lineWidth, maxLines?, uppercase, allowedChars, pageBreak? }`. Значения ширины для конкретных аддонов неизвестны — собираются «Проверкой человеком». Оригинал: базовая ширина + 3 для B77x и + 6 для B78x.

Реализация — `packages/core/src/format/` (T05). По умолчанию 24 символа (колонки MCDU/CDU; базовая ширина оригинала неизвестна `[ПРОВЕРИТЬ]`), B77x — 27, B78x — 30. Символы по умолчанию: `A–Z 0–9`, пробел и `.,:;/-+()'?!=%#*&@`; `{}` (разделители пакета Hoppie), кавычки, `\`, `<>`, `|` запрещены. Раскладка: заголовок, линия дефисов, тело, линия точек, подвал; строка тела из `-`/`.`/`=`/`*` (≥ 3) растягивается на всю ширину. Перенос по пробелу или после `/`/`-` внутри слова, иначе жёсткий.
