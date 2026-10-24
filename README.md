# ACARS Link

Имитатор ACARS авиакомпании для авиасимуляторов (MSFS 2020/2024, X-Plane 12). Читает телеметрию симулятора и OFP SimBrief, определяет фазу полёта и по сценариям присылает в кабину через сеть Hoppie ACARS сообщения «авиакомпании»: лоадшиты, слоты, гейт, погоду, нестандартные ситуации. Пилот отвечает и запрашивает данные telex-командами. Есть имитация станции УВД XATC (CPDLC-логон, DCL/PDC, запросы эшелона, океанический клиренс).

Идеи взяты из RealAcars 7.3.2, код написан с нуля (CLAUDE.md, инвариант 1).

## Статус

| Что | Состояние |
|---|---|
| Ядро: FSM фаз, движок сценариев, форматтер | готово (T01–T07, T39–T40) |
| Сценарии | 91: базовые 17, команды пилота 21, внешние данные 17, нестандартные 34, эффекты в симуляторе 2 |
| Мост | C# / .NET 8: SimConnect (MSFS) и X-Plane 12 Web API, автовыбор симулятора (T08, T18, T59) |
| Транспорт | Hoppie; SayIntentions — не сделан (T17) |
| Приложение | Electron, EN/RU, установщик Windows без подписи (T10, T19, T56, T57, T-UI) |
| Распространение | личное использование, лицензия проприетарная (`08`) |

Открытые карточки — `docs/07-roadmap-tasks.md` (T15, T16, T17, T20, T35–T37).

## Структура

```
apps/desktop             Electron-приложение (main / preload / renderer)
packages/core            ядро: чистый TS, без Node/DOM/сети; время и случайность инъектируются
packages/scenarios       сценарии YAML (base, commands, external, irregular, sim) и их схема
packages/data-sources    внешние данные: METAR/TAF, VATSIM, EONET, OurAirports, AeroDataBox и др.
packages/transport       транспорт Hoppie и mock за интерфейсом Transport
tools/replay             формат записи полёта (JSONL) и CLI прогона через ядро
bridge/msfs              мост к симулятору (C#), слушает только 127.0.0.1
docs/                    документы — источник истины
reference/               примеры сценариев, телеметрии, обезличенные OFP
```

## Быстрый старт

Нужны Node ≥ 24 и pnpm 12; для моста — .NET 8 SDK.

```
pnpm install
pnpm check          # typecheck + lint + test
pnpm desktop:dev    # приложение с HMR; мост в dev запускается вручную — bridge/msfs/README.md
pnpm desktop:dist   # установщик: apps/desktop/release/ACARS-Link-Setup-<версия>.exe
```

Полный список команд и правила работы — [CLAUDE.md](CLAUDE.md).

## Документы

1. [CLAUDE.md](CLAUDE.md) — инварианты и порядок работы (обязательно).
2. [docs/02-product-vision.md](docs/02-product-vision.md) — что делаем и чего не делаем.
3. [docs/03-architecture.md](docs/03-architecture.md) — компоненты, стек, схема телеметрии.
4. [docs/04-flight-phase-fsm.md](docs/04-flight-phase-fsm.md) — машина фаз полёта.
5. [docs/05-scenario-engine.md](docs/05-scenario-engine.md) — формат сценариев.
6. [docs/06-integrations.md](docs/06-integrations.md) — Hoppie, SimBrief, SimConnect, X-Plane, внешние API.
7. [docs/07-roadmap-tasks.md](docs/07-roadmap-tasks.md) — карточки задач.
8. [docs/08-risks-open-questions.md](docs/08-risks-open-questions.md) — решения, риски, отложенное до релиза.
9. [docs/01-realacars-teardown.md](docs/01-realacars-teardown.md) — справка по оригиналу (идеи, не код).
